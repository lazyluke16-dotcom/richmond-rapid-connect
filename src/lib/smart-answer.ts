import { normalizeAustralianPhone } from "@/lib/call-handling";

export type SmartAnswerCallerKind =
  | "mobile"
  | "geographic"
  | "service"
  | "private_or_invalid";

export type SmartAnswerRoute = "ai" | "voicemail" | "reject";

export interface SmartAnswerCaller {
  kind: SmartAnswerCallerKind;
  e164: string | null;
}

const PRIVATE_CALLER_IDS = new Set([
  "anonymous",
  "private",
  "restricted",
  "unknown",
  "unavailable",
  "withheld",
]);

export function classifySmartAnswerCaller(input: string | null | undefined): SmartAnswerCaller {
  const raw = String(input ?? "").trim();
  if (!raw || PRIVATE_CALLER_IDS.has(raw.toLowerCase())) {
    return { kind: "private_or_invalid", e164: null };
  }

  let e164: string;
  try {
    e164 = normalizeAustralianPhone(raw);
  } catch {
    return { kind: "private_or_invalid", e164: null };
  }

  if (/^\+614\d{8}$/.test(e164)) return { kind: "mobile", e164 };
  if (/^\+61[2378]\d{8}$/.test(e164)) return { kind: "geographic", e164 };
  if (/^\+6113\d{4}$/.test(e164) || /^\+611300\d{6}$/.test(e164) || /^\+611800\d{6}$/.test(e164)) {
    return { kind: "service", e164 };
  }
  return { kind: "private_or_invalid", e164: null };
}

export function selectSmartAnswerRoute(input: {
  caller: SmartAnswerCaller;
  bypassed: boolean;
}): SmartAnswerRoute {
  if (input.bypassed) return "voicemail";
  if (input.caller.kind === "service") return "reject";
  if (input.caller.kind === "mobile" || input.caller.kind === "geographic") return "ai";
  return "voicemail";
}

export function escapeTwiML(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function withTwilioSipRegion(sipUri: string, region = "au1"): string {
  const trimmed = sipUri.trim();
  if (!trimmed) throw new Error("Smart Answer SIP URI is required");
  if (/([;?&])region=/i.test(trimmed)) return trimmed;
  return `${trimmed};region=${encodeURIComponent(region)}`;
}

export function twimlReject(reason: "busy" | "rejected" = "rejected"): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Reject reason="${reason}"/></Response>`;
}

export function twimlHangup(): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`;
}

export function twimlVoicemail(input: {
  businessName: string;
  actionUrl: string;
  transcribeCallbackUrl: string;
}): string {
  const businessName = escapeTwiML(input.businessName);
  const actionUrl = escapeTwiML(input.actionUrl);
  const transcribeCallbackUrl = escapeTwiML(input.transcribeCallbackUrl);
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<Response>`,
    `<Say voice="Polly.Nicole">You've reached ${businessName}. We can't take your call right now. Please leave your name, number and message after the tone.</Say>`,
    `<Record action="${actionUrl}" method="POST" maxLength="119" playBeep="true" transcribe="true" transcribeCallback="${transcribeCallbackUrl}"/>`,
    `<Hangup/>`,
    `</Response>`,
  ].join("");
}

export function twimlDialVapiSip(input: {
  sipUri: string;
  callerId?: string | null;
  actionUrl: string;
  username?: string | null;
  password?: string | null;
}): string {
  const actionUrl = escapeTwiML(input.actionUrl);
  const sipUri = escapeTwiML(withTwilioSipRegion(input.sipUri));
  const callerId = input.callerId ? ` callerId="${escapeTwiML(input.callerId)}"` : "";
  const auth =
    input.username && input.password
      ? ` username="${escapeTwiML(input.username)}" password="${escapeTwiML(input.password)}"`
      : "";
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<Response>`,
    `<Dial answerOnBridge="true" timeout="10" action="${actionUrl}" method="POST"${callerId}>`,
    `<Sip${auth}>${sipUri}</Sip>`,
    `</Dial>`,
    `</Response>`,
  ].join("");
}
