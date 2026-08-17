import { validateTwilioSignature } from "@/lib/twilio-webhook";

export interface SmartAnswerTenant {
  businessId: string;
  businessName: string;
  businessSlug: string;
  publicPhone: string | null;
  answeringMode: string;
  aiReceptionistEnabled: boolean;
  smartAnswerEnabled: boolean;
  forwardingSetupStatus: string;
  providerAssistantId: string | null;
  smartAnswerSipUri: string | null;
}

function publicBaseUrl(): string {
  const base = (process.env.PUBLIC_JOB_REQUEST_URL ?? "").replace(/\/+$/, "");
  if (!base) throw new Error("PUBLIC_JOB_REQUEST_URL is required for Smart Answer");
  return base;
}

export function smartAnswerPublicUrl(path: string, query?: URLSearchParams): string {
  const suffix = query && query.size > 0 ? `?${query.toString()}` : "";
  return `${publicBaseUrl()}${path}${suffix}`;
}

export async function readVerifiedTwilioForm(
  request: Request,
  expectedPath: string,
): Promise<URLSearchParams> {
  const authToken = process.env.TWILIO_AUTH_TOKEN ?? "";
  if (!authToken) throw new Error("TWILIO_AUTH_TOKEN is required for Smart Answer");

  const rawBody = await request.text();
  const params = new URLSearchParams(rawBody);
  const requestUrl = new URL(request.url);
  const signedUrl = smartAnswerPublicUrl(
    expectedPath,
    requestUrl.search ? new URLSearchParams(requestUrl.search) : undefined,
  );
  const signature = request.headers.get("x-twilio-signature") ?? "";
  if (!validateTwilioSignature(authToken, signedUrl, params, signature)) {
    throw new Error("Invalid Twilio signature");
  }
  return params;
}

export function twimlResponse(xml: string, status = 200): Response {
  return new Response(xml, {
    status,
    headers: { "Content-Type": "text/xml; charset=utf-8" },
  });
}

export async function resolveSmartAnswerTenant(
  platformNumber: string,
): Promise<SmartAnswerTenant | null> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data, error } = await supabaseAdmin.rpc(
    "resolve_smart_answer_tenant" as never,
    { _platform_number: platformNumber } as never,
  );
  if (error) throw new Error(`Smart Answer tenant resolution failed: ${error.message}`);
  const row = (Array.isArray(data) ? data[0] : data) as
    | {
        business_id?: string;
        business_name?: string;
        business_slug?: string;
        public_phone?: string | null;
        answering_mode?: string;
        ai_receptionist_enabled?: boolean;
        smart_answer_enabled?: boolean;
        forwarding_setup_status?: string;
        provider_assistant_id?: string | null;
        smart_answer_sip_uri?: string | null;
      }
    | null
    | undefined;
  if (!row?.business_id) return null;
  return {
    businessId: row.business_id,
    businessName: row.business_name ?? "the business",
    businessSlug: row.business_slug ?? "",
    publicPhone: row.public_phone ?? null,
    answeringMode: row.answering_mode ?? "off",
    aiReceptionistEnabled: Boolean(row.ai_receptionist_enabled),
    smartAnswerEnabled: Boolean(row.smart_answer_enabled),
    forwardingSetupStatus: row.forwarding_setup_status ?? "unallocated",
    providerAssistantId: row.provider_assistant_id ?? null,
    smartAnswerSipUri: row.smart_answer_sip_uri ?? null,
  };
}

export async function isSmartAnswerBypassNumber(
  businessId: string,
  phoneE164: string,
): Promise<boolean> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data, error } = await supabaseAdmin.rpc(
    "is_smart_answer_bypass_number" as never,
    { _business_id: businessId, _phone_e164: phoneE164 } as never,
  );
  if (error) throw new Error(`Smart Answer bypass lookup failed: ${error.message}`);
  return Boolean(data);
}

export async function recordReceptionMessage(input: {
  businessId: string;
  provider: "twilio" | "vapi";
  providerCallId: string;
  source: "ai_receptionist" | "voicemail";
  callerPhone?: string | null;
  callerName?: string | null;
  callerCompany?: string | null;
  messageText?: string | null;
  callbackRequested?: boolean;
  messageUrgency?: "normal" | "urgent";
  recordingUrl?: string | null;
  recordingSid?: string | null;
  recordingDurationSeconds?: number | null;
  transcription?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<string> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data, error } = await supabaseAdmin.rpc(
    "record_reception_message" as never,
    {
      _business_id: input.businessId,
      _provider: input.provider,
      _provider_call_id: input.providerCallId,
      _source: input.source,
      _caller_phone: input.callerPhone ?? null,
      _caller_name: input.callerName ?? null,
      _caller_company: input.callerCompany ?? null,
      _message_text: input.messageText ?? null,
      _callback_requested: input.callbackRequested ?? true,
      _message_urgency: input.messageUrgency ?? "normal",
      _recording_url: input.recordingUrl ?? null,
      _recording_sid: input.recordingSid ?? null,
      _recording_duration_seconds: input.recordingDurationSeconds ?? null,
      _transcription: input.transcription ?? null,
      _metadata: input.metadata ?? {},
    } as never,
  );
  if (error) throw new Error(`Reception message persistence failed: ${error.message}`);
  return String(data ?? "");
}

export async function markSmartAnswerForwardingVerified(
  businessId: string,
  providerCallId: string,
): Promise<void> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { error } = await supabaseAdmin.rpc(
    "mark_forwarding_verified" as never,
    { _business_id: businessId, _provider_call_id: providerCallId } as never,
  );
  if (error) throw new Error(`Forwarding verification failed: ${error.message}`);
}
