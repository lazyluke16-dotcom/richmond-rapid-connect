import { createFileRoute } from "@tanstack/react-router";
import { fireOutboundWebhook } from "@/lib/webhooks";
import { normalizeVapiJobType } from "@/lib/enrichment.server";
import { recommendAction, scoreLead, summariseLead } from "@/lib/leads";
import type { Lead, Urgency } from "@/lib/leads";
import { recordReceptionMessage } from "@/lib/smart-answer.server";

interface SmartAnswerCapture {
  call_disposition?: string;
  customer_name?: string;
  callback_number?: string;
  suburb?: string;
  job_type?: string;
  job_description?: string;
  urgency?: string;
  callback_preference?: string;
  caller_company?: string;
  message_text?: string;
  callback_requested?: boolean;
  message_urgency?: string;
  ai_summary?: string;
}

type ToolCall = { id: string; name: string; parameters: unknown };

function text(value: unknown, max = 1200): string {
  return String(value ?? "").trim().slice(0, max);
}

function bool(value: unknown, fallback = true): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function parseCapture(value: unknown): SmartAnswerCapture {
  if (value && typeof value === "object") return value as SmartAnswerCapture;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (parsed && typeof parsed === "object") return parsed as SmartAnswerCapture;
    } catch {
      // Handled below as empty capture.
    }
  }
  return {};
}

export function extractSmartAnswerToolCalls(message: {
  toolCallList?: Array<{ id?: string; name?: string; parameters?: unknown }>;
  toolWithToolCallList?: Array<{
    name?: string;
    toolCall?: { id?: string; parameters?: unknown };
  }>;
}): ToolCall[] {
  if (message.toolCallList?.length) {
    return message.toolCallList.map((item) => ({
      id: item.id ?? "",
      name: item.name ?? "",
      parameters: item.parameters,
    }));
  }
  return (message.toolWithToolCallList ?? []).map((item) => ({
    id: item.toolCall?.id ?? "",
    name: item.name ?? "",
    parameters: item.toolCall?.parameters,
  }));
}

async function resolveTenant(assistantId: string) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data, error } = await supabaseAdmin.rpc(
    "resolve_smart_answer_assistant" as never,
    { _assistant_id: assistantId } as never,
  );
  if (error) throw new Error(error.message);
  const row = (Array.isArray(data) ? data[0] : data) as
    | {
        business_id?: string;
        business_name?: string;
        answering_mode?: string;
        ai_receptionist_enabled?: boolean;
        smart_answer_enabled?: boolean;
      }
    | null
    | undefined;
  if (!row?.business_id) return null;
  return {
    businessId: row.business_id,
    businessName: row.business_name ?? "the business",
    active:
      row.answering_mode === "ai_receptionist" &&
      Boolean(row.ai_receptionist_enabled) &&
      Boolean(row.smart_answer_enabled),
  };
}

async function capturePlumbingLead(input: {
  businessId: string;
  callId: string;
  callerPhone: string;
  capture: SmartAnswerCapture;
  transcript?: string | null;
  recordingUrl?: string | null;
}) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const jobType = normalizeVapiJobType(text(input.capture.job_type, 120));
  const urgencyRaw = text(input.capture.urgency, 30);
  const urgency: Urgency = ["now", "today", "few-days", "flexible"].includes(urgencyRaw)
    ? (urgencyRaw as Urgency)
    : "today";
  const lead: Lead = {
    id: `smart-${crypto.randomUUID()}`,
    createdAt: Date.now(),
    jobType,
    suburb: text(input.capture.suburb, 120) || "unknown",
    urgency,
    propertyType: "house",
    photos: [],
    name: text(input.capture.customer_name, 120) || "Unknown caller",
    phone: text(input.capture.callback_number, 40) || input.callerPhone,
    bestTime: text(input.capture.callback_preference, 80),
    chat: input.transcript
      ? [{ role: "ai", text: input.transcript.slice(0, 12000), ts: Date.now() }]
      : [],
    aiSummary: "",
    leadScore: 0,
    recommendedAction: "",
    status: "new",
    source: "ai_phone_agent",
    external_call_id: input.callId,
    call_recording_url: input.recordingUrl || undefined,
  };
  lead.aiSummary = text(input.capture.ai_summary, 1200) || summariseLead(lead);
  lead.leadScore = scoreLead(lead);
  lead.recommendedAction = recommendAction(lead.leadScore, lead.urgency);

  const { error } = await supabaseAdmin.from("leads").insert({
    id: lead.id,
    created_at: lead.createdAt,
    job_type: lead.jobType,
    suburb: lead.suburb,
    urgency: lead.urgency,
    property_type: lead.propertyType,
    photos: lead.photos,
    name: lead.name,
    phone: lead.phone,
    best_time: lead.bestTime,
    chat: lead.chat,
    ai_summary: lead.aiSummary,
    lead_score: lead.leadScore,
    recommended_action: lead.recommendedAction,
    status: lead.status,
    source: lead.source,
    external_call_id: lead.external_call_id,
    call_recording_url: lead.call_recording_url ?? null,
    business_id: input.businessId,
  } as never);
  if (error) {
    if (/duplicate key|leads_source_external_call_uk/i.test(error.message)) {
      const { data: existing } = await supabaseAdmin
        .from("leads")
        .select("id")
        .eq("business_id", input.businessId)
        .eq("external_call_id", input.callId)
        .maybeSingle();
      return { leadId: (existing as { id?: string } | null)?.id ?? null, deduped: true };
    }
    throw new Error(error.message);
  }

  try {
    await fireOutboundWebhook(lead);
  } catch (error) {
    console.warn("[vapi-smart-answer] outbound webhook failed", error);
  }
  return { leadId: lead.id, deduped: false };
}

export async function handleVapiSmartAnswer(request: Request): Promise<Response> {
  const expected = process.env.VAPI_SERVER_SECRET ?? "";
  if (!expected) return Response.json({ error: "Server misconfigured" }, { status: 503 });
  if ((request.headers.get("x-vapi-secret") ?? "") !== expected) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await request.json()) as {
    message?: {
      type?: string;
      call?: {
        id?: string;
        assistantId?: string;
        customer?: { number?: string };
        recordingUrl?: string;
      };
      transcript?: string;
      toolCallList?: Array<{ id?: string; name?: string; parameters?: unknown }>;
      toolWithToolCallList?: Array<{
        name?: string;
        toolCall?: { id?: string; parameters?: unknown };
      }>;
    };
  };
  const message = body.message;
  if (!message || message.type !== "tool-calls") {
    return Response.json({ ok: true, ignored: true });
  }

  const assistantId = text(message.call?.assistantId, 160);
  const callId = text(message.call?.id, 160);
  if (!assistantId || !callId) {
    return Response.json({ error: "Call identity is unavailable" }, { status: 400 });
  }

  const tenant = await resolveTenant(assistantId);
  if (!tenant) return Response.json({ error: "Unknown Smart Answer assistant" }, { status: 404 });
  if (!tenant.active) {
    return Response.json({ error: "Smart Answer is not active for this business" }, { status: 409 });
  }

  const calls = extractSmartAnswerToolCalls(message);
  const results = [] as Array<{ name: string; toolCallId: string; result: string }>;
  for (const toolCall of calls) {
    if (toolCall.name !== "capture_smart_answer_result") {
      results.push({
        name: toolCall.name || "unknown",
        toolCallId: toolCall.id,
        result: JSON.stringify({ ok: false, error: "Unsupported tool" }),
      });
      continue;
    }

    const capture = parseCapture(toolCall.parameters);
    const callerPhone =
      text(capture.callback_number, 40) || text(message.call?.customer?.number, 40);
    try {
      if (capture.call_disposition === "message") {
        const messageId = await recordReceptionMessage({
          businessId: tenant.businessId,
          provider: "vapi",
          providerCallId: callId,
          source: "ai_receptionist",
          callerPhone,
          callerName: text(capture.customer_name, 120) || null,
          callerCompany: text(capture.caller_company, 160) || null,
          messageText:
            text(capture.message_text, 2400) || text(capture.ai_summary, 1200) || "Message requested",
          callbackRequested: bool(capture.callback_requested, true),
          messageUrgency: capture.message_urgency === "urgent" ? "urgent" : "normal",
          recordingUrl: text(message.call?.recordingUrl, 1000) || null,
          transcription: text(message.transcript, 12000) || null,
          metadata: { disposition: "message", assistantId },
        });
        results.push({
          name: toolCall.name,
          toolCallId: toolCall.id,
          result: JSON.stringify({ ok: true, disposition: "message", messageId }),
        });
      } else if (capture.call_disposition === "plumbing_enquiry") {
        const saved = await capturePlumbingLead({
          businessId: tenant.businessId,
          callId,
          callerPhone,
          capture,
          transcript: message.transcript,
          recordingUrl: message.call?.recordingUrl,
        });
        results.push({
          name: toolCall.name,
          toolCallId: toolCall.id,
          result: JSON.stringify({ ok: true, disposition: "plumbing_enquiry", ...saved }),
        });
      } else {
        results.push({
          name: toolCall.name,
          toolCallId: toolCall.id,
          result: JSON.stringify({ ok: false, error: "Invalid call disposition" }),
        });
      }
    } catch (error) {
      console.error("[vapi-smart-answer] capture failed", error);
      results.push({
        name: toolCall.name,
        toolCallId: toolCall.id,
        result: JSON.stringify({ ok: false, error: "Could not save the call outcome" }),
      });
    }
  }

  return Response.json({ results });
}

// Vite/TanStack regenerates FileRoutesByPath from this filename during build.
export const Route = createFileRoute("/api/public/webhooks/vapi-smart-answer" as never)({
  server: { handlers: { POST: ({ request }) => handleVapiSmartAnswer(request) } },
});
