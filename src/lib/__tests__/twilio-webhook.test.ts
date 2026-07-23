import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { validateTwilioSignature } from "@/lib/twilio-webhook";

describe("Twilio webhook signatures", () => {
  const token = "test-token";
  const url = "https://example.test/api/public/webhooks/twilio-missed-call/acme";
  const params = new URLSearchParams({
    CallStatus: "no-answer",
    From: "+61400000000",
    CallSid: "CA123",
  });

  it("accepts the correctly signed exact URL and form parameters", () => {
    const payload =
      url +
      [...params.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, value]) => `${key}${value}`)
        .join("");
    const signature = createHmac("sha1", token).update(payload).digest("base64");
    expect(validateTwilioSignature(token, url, params, signature)).toBe(true);
  });

  it("rejects tampered parameters, URL, missing token, and missing signature", () => {
    const signature = createHmac("sha1", token).update("wrong").digest("base64");
    expect(validateTwilioSignature(token, url, params, signature)).toBe(false);
    expect(validateTwilioSignature("", url, params, signature)).toBe(false);
    expect(validateTwilioSignature(token, url, params, "")).toBe(false);
  });
});
