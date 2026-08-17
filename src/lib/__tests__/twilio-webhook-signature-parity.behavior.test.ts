import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import { validateTwilioSignature } from "@/lib/twilio-webhook";

// Independent reference signer implementing Twilio's official algorithm
// (twilio-node getExpectedTwilioSignature): native case-sensitive key sort,
// per-value concatenation with array dedupe+sort, HMAC-SHA1 over a UTF-8 buffer,
// base64. Deliberately does NOT use localeCompare.
function twilioReferenceSignature(
  authToken: string,
  url: string,
  params: Record<string, string | string[]>,
): string {
  const data = Object.keys(params)
    .sort()
    .reduce((acc, key) => {
      const value = params[key];
      if (Array.isArray(value)) {
        return (
          acc +
          Array.from(new Set(value))
            .sort()
            .map((val) => `${key}${val}`)
            .join("")
        );
      }
      return acc + key + value;
    }, url);
  return createHmac("sha1", authToken).update(Buffer.from(data, "utf-8")).digest("base64");
}

// The OLD buggy behaviour: sort keys with localeCompare (case-folding).
function localeCompareSignature(
  authToken: string,
  url: string,
  params: Record<string, string>,
): string {
  const data =
    url +
    Object.entries(params)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key}${value}`)
      .join("");
  return createHmac("sha1", authToken).update(data).digest("base64");
}

const TOKEN = "test-auth-token-not-a-real-secret";
const URL_ = "https://staging.example.test/api/public/webhooks/twilio-smart-answer";

// Realistic inbound Voice webhook parameter names — includes the identifiers
// whose native vs localeCompare ordering diverges (CallSid/CallStatus/Called/
// Caller, ForwardedFrom/From/From*, To/To*).
const VOICE_PARAMS: Record<string, string> = {
  AccountSid: "ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  ApiVersion: "2010-04-01",
  CallSid: "CA00000000000000000000000000000001",
  CallStatus: "ringing",
  Called: "+61468089180",
  CalledCity: "MELBOURNE",
  CalledCountry: "AU",
  CalledState: "VIC",
  CalledZip: "3000",
  Caller: "+61450364907",
  CallerCity: "MELBOURNE",
  CallerCountry: "AU",
  CallerState: "VIC",
  CallerZip: "3121",
  Direction: "inbound",
  ForwardedFrom: "+61468089180",
  From: "+61450364907",
  FromCity: "MELBOURNE",
  FromCountry: "AU",
  FromState: "VIC",
  FromZip: "3121",
  To: "+61468089180",
  ToCity: "MELBOURNE",
  ToCountry: "AU",
  ToState: "VIC",
  ToZip: "3000",
};

function toSearchParams(obj: Record<string, string>): URLSearchParams {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(obj)) usp.append(k, v);
  return usp;
}

describe("Twilio signature parity with the official algorithm", () => {
  it("proves native vs localeCompare orderings diverge for real Voice params", () => {
    const twilioSig = twilioReferenceSignature(TOKEN, URL_, VOICE_PARAMS);
    const localeSig = localeCompareSignature(TOKEN, URL_, VOICE_PARAMS);
    // If they were equal the fixture would not exercise the bug.
    expect(twilioSig).not.toEqual(localeSig);
  });

  it("validates a Twilio-official signature over realistic Voice params", () => {
    const twilioSig = twilioReferenceSignature(TOKEN, URL_, VOICE_PARAMS);
    expect(validateTwilioSignature(TOKEN, URL_, toSearchParams(VOICE_PARAMS), twilioSig)).toBe(true);
  });

  it("rejects a signature built with the old localeCompare ordering", () => {
    // A validator that (wrongly) used localeCompare would accept this; the
    // corrected validator must reject it.
    const localeSig = localeCompareSignature(TOKEN, URL_, VOICE_PARAMS);
    expect(validateTwilioSignature(TOKEN, URL_, toSearchParams(VOICE_PARAMS), localeSig)).toBe(false);
  });

  it("rejects a wrong auth token", () => {
    const twilioSig = twilioReferenceSignature(TOKEN, URL_, VOICE_PARAMS);
    expect(validateTwilioSignature("different-token", URL_, toSearchParams(VOICE_PARAMS), twilioSig)).toBe(false);
  });

  it("rejects a tampered parameter", () => {
    const twilioSig = twilioReferenceSignature(TOKEN, URL_, VOICE_PARAMS);
    const tampered = toSearchParams({ ...VOICE_PARAMS, From: "+61400000001" });
    expect(validateTwilioSignature(TOKEN, URL_, tampered, twilioSig)).toBe(false);
  });

  it("rejects a changed URL", () => {
    const twilioSig = twilioReferenceSignature(TOKEN, URL_, VOICE_PARAMS);
    expect(
      validateTwilioSignature(TOKEN, `${URL_}?extra=1`, toSearchParams(VOICE_PARAMS), twilioSig),
    ).toBe(false);
  });

  it("rejects a missing signature", () => {
    expect(validateTwilioSignature(TOKEN, URL_, toSearchParams(VOICE_PARAMS), "")).toBe(false);
  });

  it("matches Twilio multi-value handling (dedupe + sort of repeated params)", () => {
    const multi: Record<string, string | string[]> = {
      CallSid: "CA00000000000000000000000000000009",
      Digits: ["3", "1", "2", "1"],
      To: "+61468089180",
    };
    const usp = new URLSearchParams();
    usp.append("CallSid", "CA00000000000000000000000000000009");
    for (const d of ["3", "1", "2", "1"]) usp.append("Digits", d);
    usp.append("To", "+61468089180");

    const twilioSig = twilioReferenceSignature(TOKEN, URL_, multi);
    expect(validateTwilioSignature(TOKEN, URL_, usp, twilioSig)).toBe(true);
  });

  it("contains no real secret token values", () => {
    // Guard: the fixtures use obviously-fake identifiers only.
    expect(TOKEN).toContain("not-a-real-secret");
    expect(/^[0-9a-f]{32}$/.test(TOKEN)).toBe(false);
  });
});
