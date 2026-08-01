import { createHash } from "node:crypto";
import { validateTwilioSignature } from "@/lib/twilio-webhook";

export type OutreachChannel = "sms" | "email" | "social";

export interface OutreachSuppressionStore {
  suppress(input: {
    channel: OutreachChannel;
    endpointHash: string;
    reason: "unsubscribe" | "stop_reply";
    source: string;
    sourceEventId: string | null;
  }): Promise<void>;
  suppressByToken(input: { tokenHash: string; source: string }): Promise<void>;
}

const UNSUBSCRIBE_INTENT = /^(stop|unsubscribe|cancel|end|quit)(\s+all)?[.!]?$/i;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,160}$/;

export function normalizeOutreachEndpoint(channel: OutreachChannel, value: string): string {
  const trimmed = value.trim();
  if (channel === "email") {
    const email = trimmed.toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 254) {
      throw new Error("Invalid email endpoint");
    }
    return email;
  }
  if (channel === "sms") {
    const compact = trimmed.replace(/[\s().-]/g, "");
    const e164 = compact.startsWith("04") ? `+61${compact.slice(1)}` : compact;
    if (!/^\+61\d{9}$/.test(e164)) throw new Error("Invalid Australian SMS endpoint");
    return e164;
  }
  if (!trimmed || trimmed.length > 320) throw new Error("Invalid social endpoint");
  return trimmed.toLowerCase();
}

export function hashOutreachEndpoint(channel: OutreachChannel, value: string): string {
  const normalized = normalizeOutreachEndpoint(channel, value);
  return createHash("sha256").update(`${channel}:${normalized}`, "utf8").digest("hex");
}

export function hashUnsubscribeToken(token: string): string {
  if (!TOKEN_PATTERN.test(token)) throw new Error("Invalid unsubscribe token");
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function isUnsubscribeIntent(body: string): boolean {
  return UNSUBSCRIBE_INTENT.test(body.trim());
}

export async function handleOutreachUnsubscribe(
  request: Request,
  store: OutreachSuppressionStore,
): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, error: "Invalid request" }, { status: 400 });
  }
  const token =
    body && typeof body === "object" && "token" in body
      ? String((body as { token: unknown }).token ?? "")
      : "";
  try {
    await store.suppressByToken({ tokenHash: hashUnsubscribeToken(token), source: "web" });
  } catch {
    return Response.json(
      { ok: false, error: "This unsubscribe link is invalid or unavailable." },
      { status: 400 },
    );
  }
  return Response.json(
    { ok: true, message: "You have been unsubscribed from future marketing messages." },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function handleTwilioOutreachReply(
  request: Request,
  config: { authToken: string; publicBaseUrl: string },
  store: OutreachSuppressionStore,
): Promise<Response> {
  const publicBaseUrl = config.publicBaseUrl.replace(/\/+$/, "");
  if (!config.authToken || !publicBaseUrl) {
    return Response.json({ error: "Server misconfigured" }, { status: 503 });
  }
  const params = new URLSearchParams(await request.text());
  const signedUrl = `${publicBaseUrl}/api/public/webhooks/twilio-outreach`;
  if (
    !validateTwilioSignature(
      config.authToken,
      signedUrl,
      params,
      request.headers.get("x-twilio-signature") ?? "",
    )
  ) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const messageSid = (params.get("MessageSid") ?? "").trim();
  const from = (params.get("From") ?? "").trim();
  const message = params.get("Body") ?? "";
  if (!messageSid || !from) {
    return Response.json({ error: "Missing Twilio message identity" }, { status: 400 });
  }

  if (isUnsubscribeIntent(message)) {
    try {
      await store.suppress({
        channel: "sms",
        endpointHash: hashOutreachEndpoint("sms", from),
        reason: "stop_reply",
        source: "twilio",
        sourceEventId: messageSid,
      });
    } catch {
      return Response.json({ error: "Suppression could not be recorded" }, { status: 503 });
    }
  }

  return new Response("<Response></Response>", {
    status: 200,
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
