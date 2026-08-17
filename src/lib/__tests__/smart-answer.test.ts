import { describe, expect, it } from "vitest";
import {
  classifySmartAnswerCaller,
  escapeTwiML,
  selectSmartAnswerRoute,
  twimlDialVapiSip,
  twimlReject,
  twimlVoicemail,
  withTwilioSipRegion,
} from "@/lib/smart-answer";

describe("Smart Answer caller screening", () => {
  it.each([
    ["0412 345 678", "mobile", "+61412345678"],
    ["03 9123 4567", "geographic", "+61391234567"],
    ["02 9123 4567", "geographic", "+61291234567"],
    ["07 3123 4567", "geographic", "+61731234567"],
    ["08 8123 4567", "geographic", "+61881234567"],
  ])("classifies %s as an AI-eligible %s", (input, kind, e164) => {
    expect(classifySmartAnswerCaller(input)).toEqual({ kind, e164 });
  });

  it.each(["13 12 34", "1300 123 456", "1800 123 456"])(
    "classifies %s as a service number",
    (input) => {
      expect(classifySmartAnswerCaller(input).kind).toBe("service");
    },
  );

  it.each(["", "private", "anonymous", "withheld", "+1 415 555 0100", "000", "phone me"])(
    "keeps %s away from AI",
    (input) => {
      expect(classifySmartAnswerCaller(input)).toEqual({
        kind: "private_or_invalid",
        e164: null,
      });
    },
  );

  it("manual bypass wins even for a normal mobile", () => {
    const caller = classifySmartAnswerCaller("0412 345 678");
    expect(selectSmartAnswerRoute({ caller, bypassed: true })).toBe("voicemail");
  });

  it("sends valid mobiles and geographic numbers to AI", () => {
    expect(
      selectSmartAnswerRoute({
        caller: classifySmartAnswerCaller("0412 345 678"),
        bypassed: false,
      }),
    ).toBe("ai");
    expect(
      selectSmartAnswerRoute({
        caller: classifySmartAnswerCaller("03 9123 4567"),
        bypassed: false,
      }),
    ).toBe("ai");
  });

  it("rejects service numbers and gives private/invalid callers normal voicemail", () => {
    expect(
      selectSmartAnswerRoute({
        caller: classifySmartAnswerCaller("1800 123 456"),
        bypassed: false,
      }),
    ).toBe("reject");
    expect(
      selectSmartAnswerRoute({
        caller: classifySmartAnswerCaller("private"),
        bypassed: false,
      }),
    ).toBe("voicemail");
  });
});

describe("Smart Answer TwiML", () => {
  it("escapes untrusted XML content", () => {
    expect(escapeTwiML(`A&B <Plumbing> "24/7"`)).toBe(
      "A&amp;B &lt;Plumbing&gt; &quot;24/7&quot;",
    );
  });

  it("adds the Sydney SIP egress region exactly once", () => {
    expect(withTwilioSipRegion("sip:abc@sip.vapi.ai")).toBe(
      "sip:abc@sip.vapi.ai;region=au1",
    );
    expect(withTwilioSipRegion("sip:abc@sip.vapi.ai;region=au1")).toBe(
      "sip:abc@sip.vapi.ai;region=au1",
    );
  });

  it("builds authenticated Vapi SIP dial TwiML with a fallback action", () => {
    const xml = twimlDialVapiSip({
      sipUri: "sip:abc@sip.vapi.ai",
      callerId: "+61412345678",
      actionUrl: "https://example.test/api/public/webhooks/twilio-smart-answer-dial",
      username: "smart-user",
      password: "smart-pass",
    });
    expect(xml).toContain("<Dial");
    expect(xml).toContain('answerOnBridge="true"');
    expect(xml).toContain('username="smart-user"');
    expect(xml).toContain('password="smart-pass"');
    expect(xml).toContain("sip:abc@sip.vapi.ai;region=au1");
  });

  it("builds traditional voicemail without any AI/SIP leg", () => {
    const xml = twimlVoicemail({
      businessName: "A&B Plumbing",
      actionUrl: "https://example.test/record",
      transcribeCallbackUrl: "https://example.test/transcribe",
    });
    expect(xml).toContain("<Record");
    expect(xml).toContain("A&amp;B Plumbing");
    expect(xml).not.toContain("<Sip");
  });

  it("can reject a service-number caller before AI answers", () => {
    expect(twimlReject()).toContain('<Reject reason="rejected"/>');
  });
});
