import { createFileRoute } from "@tanstack/react-router";
import { twimlHangup, twimlReject, twimlVoicemail } from "@/lib/smart-answer";
import {
  readVerifiedTwilioForm,
  recordReceptionMessage,
  resolveSmartAnswerTenant,
  smartAnswerPublicUrl,
  twimlResponse,
} from "@/lib/smart-answer.server";

const PATH = "/api/public/webhooks/twilio-smart-answer-dial";
const RECORD_PATH = "/api/public/webhooks/twilio-smart-answer-record";
const TRANSCRIBE_PATH = "/api/public/webhooks/twilio-smart-answer-transcribe";

export async function handleTwilioSmartAnswerDial(request: Request): Promise<Response> {
  let params: URLSearchParams;
  try {
    params = await readVerifiedTwilioForm(request, PATH);
  } catch (error) {
    console.warn("[smart-answer/dial] rejected Twilio request", (error as Error).message);
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const dialStatus = (params.get("DialCallStatus") ?? "").toLowerCase();
  if (dialStatus === "completed") return twimlResponse(twimlHangup());

  const requestUrl = new URL(request.url);
  const businessId = requestUrl.searchParams.get("businessId")?.trim() ?? "";
  const callSid = (params.get("CallSid") ?? "").trim();
  const callerPhone = (params.get("From") ?? "").trim() || null;
  if (!businessId || !callSid) return twimlResponse(twimlReject("busy"));

  let businessName = "the business";
  const platformNumber = (params.get("To") ?? "").trim();
  if (platformNumber) {
    try {
      const tenant = await resolveSmartAnswerTenant(platformNumber);
      if (tenant?.businessId === businessId) businessName = tenant.businessName;
    } catch (error) {
      console.warn("[smart-answer/dial] fallback tenant lookup failed", error);
    }
  }

  try {
    await recordReceptionMessage({
      businessId,
      provider: "twilio",
      providerCallId: callSid,
      source: "voicemail",
      callerPhone,
      metadata: { screening: "smart_answer", sipDialStatus: dialStatus || "unknown" },
    });
  } catch (error) {
    console.error("[smart-answer/dial] voicemail persistence failed", error);
    return twimlResponse(twimlReject("busy"));
  }

  const callbackQuery = new URLSearchParams({ businessId });
  return twimlResponse(
    twimlVoicemail({
      businessName,
      actionUrl: smartAnswerPublicUrl(RECORD_PATH, callbackQuery),
      transcribeCallbackUrl: smartAnswerPublicUrl(TRANSCRIBE_PATH, callbackQuery),
    }),
  );
}

export const Route = createFileRoute("/api/public/webhooks/twilio-smart-answer-dial")({
  server: { handlers: { POST: ({ request }) => handleTwilioSmartAnswerDial(request) } },
});
