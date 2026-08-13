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

export const provisionMySmartAnswerSip = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data: businessIdRaw, error: ownerError } = await context.supabase.rpc(
      "call_handling_admin_business" as never,
    );
    if (ownerError) throw new Error(ownerError.message);
    const businessId = String(businessIdRaw ?? "");
    if (!businessId) throw new Error("Owner or admin access is required");

    const { data: access, error: accessError } = await context.supabase.rpc(
      "has_ai_receptionist_access",
      { _business_id: businessId },
    );
    if (accessError) throw new Error(accessError.message);
    if (!access) throw new Error("AI Receptionist access is required");

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: provisioningData, error: provisioningError } = await supabaseAdmin.rpc(
      "get_smart_answer_provisioning" as never,
      { _business_id: businessId } as never,
    );
    if (provisioningError) throw new Error(provisioningError.message);
    const row = (Array.isArray(provisioningData) ? provisioningData[0] : provisioningData) as
      | {
          business_name?: string;
          assistant_id?: string | null;
          sip_phone_id?: string | null;
          sip_uri?: string | null;
        }
      | null
      | undefined;
    if (!row?.assistant_id) throw new Error("Provision the Vapi assistant before Smart Answer SIP");
    if (row.sip_phone_id && row.sip_uri) {
      return { provisioned: true, reused: true, sipUri: row.sip_uri };
    }

    const username = process.env.VAPI_SIP_AUTH_USERNAME?.trim() ?? "";
    const password = process.env.VAPI_SIP_AUTH_PASSWORD?.trim() ?? "";
    if (!username || !password) {
      return {
        provisioned: false,
        reason: "Secure SIP credentials are not configured server-side",
        requiredSecrets: ["VAPI_SIP_AUTH_USERNAME", "VAPI_SIP_AUTH_PASSWORD"],
      };
    }

    const {
      createVapiSipPhoneNumber,
      deleteVapiPhoneNumber,
      vapiCredentialsAvailable,
      vapiSipHost,
    } = await import("@/lib/vapi.server");
    if (!vapiCredentialsAvailable()) {
      return {
        provisioned: false,
        reason: "VAPI_API_KEY not configured server-side",
        requiredSecrets: ["VAPI_API_KEY"],
      };
    }

    const sipUser = `smart-${crypto.randomUUID().replaceAll("-", "")}`;
    const expectedSipUri = `sip:${sipUser}@${vapiSipHost()}`;
    const created = await createVapiSipPhoneNumber({
      assistantId: row.assistant_id,
      sipUser,
      name: `${row.business_name ?? "Business"} Smart Answer`,
      username,
      password,
    });
    const sipUri = created.sipUri ?? expectedSipUri;

    const { error: saveError } = await supabaseAdmin.rpc(
      "save_smart_answer_sip_endpoint" as never,
      {
        _business_id: businessId,
        _sip_phone_id: created.id,
        _sip_uri: sipUri,
      } as never,
    );
    if (saveError) {
      try {
        await deleteVapiPhoneNumber(created.id);
      } catch (cleanupError) {
        console.error("[smart-answer] orphaned SIP endpoint cleanup failed", cleanupError);
      }
      throw new Error(`Failed to persist Smart Answer SIP endpoint: ${saveError.message}`);
    }

    return { provisioned: true, reused: false, sipUri };
  });
