import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { classifySmartAnswerCaller } from "@/lib/smart-answer";

export interface SmartAnswerBypassNumber {
  id: string;
  phone: string;
  label: string | null;
  source: "manual" | "contact_sync" | "learned";
}

export interface SmartAnswerContext {
  businessId: string;
  enabled: boolean;
  ringFirstSeconds: number;
  forwardingStatus: string;
  answeringMode: string;
  aiOperational: boolean;
  sipReady: boolean;
  bypassNumbers: SmartAnswerBypassNumber[];
  unreadMessages: number;
}

export interface ReceptionMessage {
  id: string;
  source: "ai_receptionist" | "voicemail";
  callerPhone: string | null;
  callerName: string | null;
  callerCompany: string | null;
  messageText: string | null;
  callbackRequested: boolean;
  messageUrgency: "normal" | "urgent";
  recordingUrl: string | null;
  transcription: string | null;
  status: "unread" | "read" | "done";
  createdAt: string;
}

function cleanLabel(value: unknown): string | null {
  const label = String(value ?? "")
    // eslint-disable-next-line no-control-regex -- strips untrusted control bytes
    .replace(/[\u0000-\u001F]/g, "")
    .trim()
    .slice(0, 120);
  return label || null;
}

export const getMySmartAnswerContext = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<SmartAnswerContext> => {
    const { data, error } = await context.supabase.rpc("get_my_smart_answer_context" as never);
    if (error) throw new Error(error.message);
    const row = data as unknown as Partial<SmartAnswerContext> | null;
    if (!row?.businessId) throw new Error("Smart Answer context unavailable");
    return {
      businessId: row.businessId,
      enabled: Boolean(row.enabled),
      ringFirstSeconds: Number(row.ringFirstSeconds ?? 15),
      forwardingStatus: String(row.forwardingStatus ?? "unallocated"),
      answeringMode: String(row.answeringMode ?? "off"),
      aiOperational: Boolean(row.aiOperational),
      sipReady: Boolean(row.sipReady),
      bypassNumbers: Array.isArray(row.bypassNumbers) ? row.bypassNumbers : [],
      unreadMessages: Number(row.unreadMessages ?? 0),
    };
  });

export const getMyReceptionMessages = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<ReceptionMessage[]> => {
    const { data, error } = await context.supabase
      .from("reception_messages")
      .select(
        "id,source,caller_phone,caller_name,caller_company,message_text,callback_requested,message_urgency,recording_url,transcription,status,created_at",
      )
      .order("created_at", { ascending: false })
      .limit(25);
    if (error) throw new Error(error.message);
    return ((data ?? []) as unknown as Array<{
      id: string;
      source: "ai_receptionist" | "voicemail";
      caller_phone: string | null;
      caller_name: string | null;
      caller_company: string | null;
      message_text: string | null;
      callback_requested: boolean;
      message_urgency: "normal" | "urgent";
      recording_url: string | null;
      transcription: string | null;
      status: "unread" | "read" | "done";
      created_at: string;
    }>).map((row) => ({
      id: row.id,
      source: row.source,
      callerPhone: row.caller_phone,
      callerName: row.caller_name,
      callerCompany: row.caller_company,
      messageText: row.message_text,
      callbackRequested: row.callback_requested,
      messageUrgency: row.message_urgency,
      recordingUrl: row.recording_url,
      transcription: row.transcription,
      status: row.status,
      createdAt: row.created_at,
    }));
  });

export const markMyReceptionMessagesRead = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase.rpc("mark_my_reception_messages_read" as never);
    if (error) throw new Error(error.message);
    return { success: true, changed: Number(data ?? 0) };
  });

export const setMySmartAnswerSettings = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { enabled: boolean; ringFirstSeconds: number }) => d)
  .handler(async ({ data, context }) => {
    const seconds = Math.round(Number(data.ringFirstSeconds));
    if (!Number.isFinite(seconds) || seconds < 5 || seconds > 30) {
      throw new Error("Ring-first time must be between 5 and 30 seconds");
    }
    const { error } = await context.supabase.rpc(
      "set_my_smart_answer_settings" as never,
      { _enabled: Boolean(data.enabled), _ring_first_seconds: seconds } as never,
    );
    if (error) throw new Error(error.message);
    return { success: true };
  });

export const addMySmartAnswerBypass = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { phone: string; label?: string | null }) => d)
  .handler(async ({ data, context }) => {
    const caller = classifySmartAnswerCaller(data.phone);
    if (!caller.e164 || !["mobile", "geographic"].includes(caller.kind)) {
      throw new Error("Enter a normal Australian mobile or landline number");
    }
    const { data: id, error } = await context.supabase.rpc(
      "add_my_call_bypass_number" as never,
      { _phone_e164: caller.e164, _label: cleanLabel(data.label) } as never,
    );
    if (error) throw new Error(error.message);
    return { success: true, id: String(id ?? ""), phone: caller.e164 };
  });

export const removeMySmartAnswerBypass = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { id: string }) => d)
  .handler(async ({ data, context }) => {
    if (!data.id) throw new Error("Bypass id is required");
    const { error } = await context.supabase.rpc(
      "remove_my_call_bypass_number" as never,
      { _id: data.id } as never,
    );
    if (error) throw new Error(error.message);
    return { success: true };
  });
