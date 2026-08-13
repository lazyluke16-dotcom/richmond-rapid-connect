import { createFileRoute } from "@tanstack/react-router";
import {
  readVerifiedTwilioForm,
  recordReceptionMessage,
} from "@/lib/smart-answer.server";

const PATH = "/api/public/webhooks/twilio-smart-answer-transcribe";

export async function handleTwilioSmartAnswerTranscribe(request: Request): Promise<Response> {
  let params: URLSearchParams;
  try {
    params = await readVerifiedTwilioForm(request, PATH);
  } catch (error) {
    console.warn("[smart-answer/transcribe] rejected Twilio request", (error as Error).message);
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const requestUrl = new URL(request.url);
  const businessId = requestUrl.searchParams.get("businessId")?.trim() ?? "";
  const callSid = (params.get("CallSid") ?? "").trim();
  if (!businessId || !callSid) {
    return Response.json({ ok: true, ignored: true });
  }

  try {
    await recordReceptionMessage({
      businessId,
      provider: "twilio",
      providerCallId: callSid,
      source: "voicemail",
      transcription: (params.get("TranscriptionText") ?? "").trim() || null,
      recordingUrl: (params.get("RecordingUrl") ?? "").trim() || null,
      recordingSid: (params.get("RecordingSid") ?? "").trim() || null,
      metadata: {
        transcriptionStatus: (params.get("TranscriptionStatus") ?? "").trim() || null,
        transcriptionSid: (params.get("TranscriptionSid") ?? "").trim() || null,
      },
    });
  } catch (error) {
    console.error("[smart-answer/transcribe] persistence failed", error);
    return Response.json({ error: "Persistence failed" }, { status: 500 });
  }

  return Response.json({ ok: true });
}

export const Route = createFileRoute("/api/public/webhooks/twilio-smart-answer-transcribe")({
  server: { handlers: { POST: ({ request }) => handleTwilioSmartAnswerTranscribe(request) } },
});
