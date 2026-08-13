import { createFileRoute } from "@tanstack/react-router";
import {
  classifySmartAnswerCaller,
  selectSmartAnswerRoute,
  twimlDialVapiSip,
  twimlReject,
  twimlVoicemail,
} from "@/lib/smart-answer";
import {
  isSmartAnswerBypassNumber,
  markSmartAnswerForwardingVerified,
  readVerifiedTwilioForm,
  recordReceptionMessage,
  resolveSmartAnswerTenant,
  smartAnswerPublicUrl,
  twimlResponse,
} from "@/lib/smart-answer.server";

const PATH = "/api/public/webhooks/twilio-smart-answer";
const DIAL_PATH = "/api/public/webhooks/twilio-smart-answer-dial";
const RECORD_PATH = "/api/public/webhooks/twilio-smart-answer-record";
const TRANSCRIBE_PATH = "/api/public/webhooks/twilio-smart-answer-transcribe";

async function traditionalVoicemail(input: {
  businessId: string;
  businessName: string;
  callSid: string;
  callerPhone: string | null;
}): Promise<Response> {
  await recordReceptionMessage({
    businessId: input.businessId,
    provider: "twilio",
    providerCallId: input.callSid,
    source: "voicemail",
    callerPhone: input.callerPhone,
    metadata: { screening: "smart_answer" },
  });
  const callbackQuery = new URLSearchParams({ businessId: input.businessId });
  return twimlResponse(
    twimlVoicemail({
      businessName: input.businessName,
      actionUrl: smartAnswerPublicUrl(RECORD_PATH, callbackQuery),
      transcribeCallbackUrl: smartAnswerPublicUrl(TRANSCRIBE_PATH, callbackQuery),
    }),
  );
}

export async function handleTwilioSmartAnswer(request: Request): Promise<Response> {
  let params: URLSearchParams;
  try {
    params = await readVerifiedTwilioForm(request, PATH);
  } catch (error) {
    console.warn("[smart-answer] rejected Twilio request", (error as Error).message);
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const platformNumber = (params.get("To") ?? "").trim();
  const callerRaw = (params.get("From") ?? "").trim();
  const callSid = (params.get("CallSid") ?? "").trim();
  if (!platformNumber || !callSid) return twimlResponse(twimlReject());

  let tenant;
  try {
    tenant = await resolveSmartAnswerTenant(platformNumber);
  } catch (error) {
    console.error("[smart-answer] tenant resolution failed", error);
    return twimlResponse(twimlReject("busy"));
  }
  if (!tenant) return twimlResponse(twimlReject());

  try {
    await markSmartAnswerForwardingVerified(tenant.businessId, callSid);
  } catch (error) {
    console.warn("[smart-answer] forwarding verification update failed", error);
  }

  const caller = classifySmartAnswerCaller(callerRaw);
  let bypassed = false;
  if (caller.e164 && (caller.kind === "mobile" || caller.kind === "geographic")) {
    try {
      bypassed = await isSmartAnswerBypassNumber(tenant.businessId, caller.e164);
    } catch (error) {
      // Fail away from AI if we cannot prove the caller is not protected.
      console.error("[smart-answer] bypass lookup failed", error);
      bypassed = true;
    }
  }

  const route = selectSmartAnswerRoute({ caller, bypassed });
  if (route === "reject") return twimlResponse(twimlReject());

  const aiReady =
    tenant.smartAnswerEnabled &&
    tenant.answeringMode === "ai_receptionist" &&
    tenant.aiReceptionistEnabled &&
    Boolean(tenant.smartAnswerSipUri);

  if (route !== "ai" || !aiReady || !tenant.smartAnswerSipUri) {
    try {
      const callerPhone = caller.e164 ?? (callerRaw || null);
      return await traditionalVoicemail({
        businessId: tenant.businessId,
        businessName: tenant.businessName,
        callSid,
        callerPhone,
      });
    } catch (error) {
      console.error("[smart-answer] voicemail setup failed", error);
      return twimlResponse(twimlReject("busy"));
    }
  }

  const dialQuery = new URLSearchParams({ businessId: tenant.businessId });
  return twimlResponse(
    twimlDialVapiSip({
      sipUri: tenant.smartAnswerSipUri,
      callerId: caller.e164,
      actionUrl: smartAnswerPublicUrl(DIAL_PATH, dialQuery),
      username: process.env.VAPI_SIP_AUTH_USERNAME ?? null,
      password: process.env.VAPI_SIP_AUTH_PASSWORD ?? null,
    }),
  );
}

export const Route = createFileRoute("/api/public/webhooks/twilio-smart-answer")({
  server: { handlers: { POST: ({ request }) => handleTwilioSmartAnswer(request) } },
});
