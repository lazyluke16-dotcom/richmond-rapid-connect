import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  handleOutreachUnsubscribe,
  handleTwilioOutreachReply,
  hashOutreachEndpoint,
  hashUnsubscribeToken,
  isUnsubscribeIntent,
  normalizeOutreachEndpoint,
  type OutreachSuppressionStore,
} from "@/lib/outreach.server";

function fakeStore(): OutreachSuppressionStore {
  return {
    suppress: vi.fn().mockResolvedValue(undefined),
    suppressByToken: vi.fn().mockResolvedValue(undefined),
  };
}

describe("outreach endpoint normalization", () => {
  it("normalizes Australian mobiles and email addresses before hashing", () => {
    expect(normalizeOutreachEndpoint("sms", "0412 345 678")).toBe("+61412345678");
    expect(normalizeOutreachEndpoint("email", " Sales@Example.COM ")).toBe("sales@example.com");
    expect(hashOutreachEndpoint("sms", "0412 345 678")).toBe(
      hashOutreachEndpoint("sms", "+61 412 345 678"),
    );
  });

  it("accepts standard SMS stop words without treating ordinary replies as opt-outs", () => {
    for (const value of ["STOP", "unsubscribe", "Cancel!", "END", "quit all"]) {
      expect(isUnsubscribeIntent(value)).toBe(true);
    }
    expect(isUnsubscribeIntent("Please send the demo")).toBe(false);
  });
});

describe("public unsubscribe", () => {
  it("hashes the token and suppresses without requiring identity fields or a login", async () => {
    const store = fakeStore();
    const token = "abcdefghijklmnopqrstuvwxyzABCDEFG_123456";
    const response = await handleOutreachUnsubscribe(
      new Request("https://example.test/api/public/outreach/unsubscribe", {
        method: "POST",
        body: JSON.stringify({ token }),
      }),
      store,
    );
    expect(response.status).toBe(200);
    expect(store.suppressByToken).toHaveBeenCalledWith({
      tokenHash: hashUnsubscribeToken(token),
      source: "web",
    });
  });

  it("fails closed for malformed tokens", async () => {
    const store = fakeStore();
    const response = await handleOutreachUnsubscribe(
      new Request("https://example.test/api/public/outreach/unsubscribe", {
        method: "POST",
        body: JSON.stringify({ token: "short" }),
      }),
      store,
    );
    expect(response.status).toBe(400);
    expect(store.suppressByToken).not.toHaveBeenCalled();
  });
});

describe("Twilio STOP ingestion", () => {
  const authToken = "twilio-test-token";
  const publicBaseUrl = "https://staging.example.test";
  const endpoint = `${publicBaseUrl}/api/public/webhooks/twilio-outreach`;

  function signedRequest(body: Record<string, string>) {
    const params = new URLSearchParams(body);
    const payload =
      endpoint +
      [...params.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, value]) => `${key}${value}`)
        .join("");
    const signature = createHmac("sha1", authToken).update(payload).digest("base64");
    return new Request(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "x-twilio-signature": signature,
      },
      body: params.toString(),
    });
  }

  it("records a signed STOP immediately and idempotently by provider event", async () => {
    const store = fakeStore();
    const response = await handleTwilioOutreachReply(
      signedRequest({
        MessageSid: "SM123",
        From: "+61412345678",
        Body: "STOP",
      }),
      { authToken, publicBaseUrl },
      store,
    );
    expect(response.status).toBe(200);
    expect(store.suppress).toHaveBeenCalledWith({
      channel: "sms",
      endpointHash: hashOutreachEndpoint("sms", "+61412345678"),
      reason: "stop_reply",
      source: "twilio",
      sourceEventId: "SM123",
    });
  });

  it("rejects unsigned callbacks and ignores ordinary signed replies", async () => {
    const store = fakeStore();
    const unsigned = new Request(endpoint, {
      method: "POST",
      body: new URLSearchParams({
        MessageSid: "SM124",
        From: "+61412345678",
        Body: "STOP",
      }),
    });
    expect(
      (await handleTwilioOutreachReply(unsigned, { authToken, publicBaseUrl }, store)).status,
    ).toBe(401);

    const ordinary = await handleTwilioOutreachReply(
      signedRequest({
        MessageSid: "SM125",
        From: "+61412345678",
        Body: "Can you call tomorrow?",
      }),
      { authToken, publicBaseUrl },
      store,
    );
    expect(ordinary.status).toBe(200);
    expect(store.suppress).not.toHaveBeenCalled();
  });
});

describe("database send gate", () => {
  const migration = readFileSync(
    resolve("supabase/migrations/20260728160000_outreach_compliance.sql"),
    "utf8",
  );

  it("requires reviewed consent, sender identity, unsubscribe and suppression checks", () => {
    expect(migration).toContain("Recipient does not have reviewed permission evidence");
    expect(migration).toContain("Message does not identify the authorised sender");
    expect(migration).toContain("Message does not contain its unsubscribe instruction");
    expect(migration).toContain("Recipient is suppressed");
    expect(migration).toContain("outreach_messages_send_gate");
  });

  it("keeps all outreach tables behind the service-role boundary", () => {
    for (const table of [
      "outreach_campaigns",
      "outreach_recipients",
      "outreach_suppressions",
      "outreach_messages",
    ]) {
      expect(migration).toContain(`REVOKE ALL ON public.${table} FROM anon, authenticated`);
    }
  });

  it("suppresses pending messages when a STOP or unsubscribe is recorded", () => {
    expect(migration).toContain("eligibility_status = 'suppressed'");
    expect(migration).toContain("m.status IN ('draft','queued')");
    expect(migration).toContain("unsubscribe_outreach_recipient");
  });
});
