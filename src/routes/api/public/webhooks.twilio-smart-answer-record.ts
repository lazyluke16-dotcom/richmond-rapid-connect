import { createFileRoute } from "@tanstack/react-router";
import { twimlHangup } from "@/lib/smart-answer";
import {
  readVerifiedTwilioForm,
  recordReceptionMessage,
  twimlResponse,
} from "@/lib/smart-answer.server";

const PATH = "/api/public/webhooks/twilio-smart-answer-record";

export async function handleTwilioSmartAnswerRecord(request: Request): Promise<Response> {
  let params: URLSearchParams;
  try {
    params = await readVerifiedTwilioForm(request, PATH);
  } catch (error) {
    console.warn("[smart-answer/record] rejected Twilio request", (error as Error).message);
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const requestUrl = new URL(request.url);
  const businessId = requestUrl.searchParams.get("businessId")?.trim() ?? "";
  const callSid = (params.get("CallSid") ?? "").trim();
  if (!businessId || !callSid) return twimlResponse(twimlHangup());

  const durationRaw = Number(params.get("RecordingDuration") ?? "");
  const duration = Number.isFinite(durationRaw) && durationRaw >= 0 ? Math.round(durationRaw) : null;
  try {
    await recordReceptionMessage({
      businessId,
      provider: "twilio",
      providerCallId: callSid,
      source: "voicemail",
      callerPhone: (params.get("From") ?? "").trim() || null,
      recordingUrl: (params.get("RecordingUrl") ?? "").trim() || null,
      recordingSid: (params.get("RecordingSid") ?? "").trim() || null,
      recordingDurationSeconds: duration,
      metadata: { recordingStatus: "captured" },
    });
  } catch (error) {
    console.error("[smart-answer/record] persistence failed", error);
  }

  return twimlResponse(twimlHangup());
}

// @ts-expect-error routeTree.gen.ts is regenerated from this literal route during Vite build.
export const Route = createFileRoute("/api/public/webhooks/twilio-smart-answer-record")({
  server: { handlers: { POST: ({ request }) => handleTwilioSmartAnswerRecord(request) } },
});
