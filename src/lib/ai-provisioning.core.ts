// Server-only provisioning CORE, free of @tanstack/react-start so it can be
// shared by the authenticated server functions (ai-provisioning.functions.ts)
// AND by a bundled staging bootstrap script. This file must not import any
// browser/runtime framework code.
//
// All Vapi API calls run server-side using VAPI_API_KEY (never exposed to the
// browser). A successful create writes the returned provider_assistant_id into
// both business_ai_receptionist_settings and ai_provider_mappings so the
// webhook's trusted-mapping resolution can identify the tenant.
import { buildReceptionistInstructions } from "@/lib/ai-receptionist.instructions";

export async function loadTenantConfig(businessId: string) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const [{ data: biz }, { data: settings }, { data: services }, { data: areas }, { data: hours }] =
    await Promise.all([
      supabaseAdmin
        .from("businesses")
        .select("id,name,slug,public_phone,selected_plan,trial_ends_at,active")
        .eq("id", businessId)
        .maybeSingle(),
      supabaseAdmin
        .from("business_ai_receptionist_settings")
        .select("*")
        .eq("business_id", businessId)
        .maybeSingle(),
      supabaseAdmin
        .from("business_services")
        .select("service_key,display_name")
        .eq("business_id", businessId),
      supabaseAdmin.from("business_service_areas").select("suburb").eq("business_id", businessId),
      supabaseAdmin
        .from("business_hours")
        .select("day_of_week,open_time,close_time,closed")
        .eq("business_id", businessId),
    ]);
  if (!biz) throw new Error("Business not found");
  if (!settings) throw new Error("AI settings missing");
  const s = settings as unknown as {
    assistant_name: string;
    first_message: string;
    tone: string;
    language: string;
    callback_message: string;
    pricing_response: string;
    human_request_response: string;
    emergency_response: string;
    recording_enabled: boolean;
    max_call_duration_seconds: number;
  };
  const b = biz as {
    id: string;
    name: string;
    slug: string;
    public_phone: string | null;
    selected_plan: string | null;
    trial_ends_at: string | null;
    active: boolean;
  };
  const svcs = ((services ?? []) as { service_key: string; display_name: string }[]).map((r) => ({
    key: r.service_key,
    label: r.display_name,
  }));
  const ars = ((areas ?? []) as { suburb: string }[]).map((r) => ({ name: r.suburb }));
  const hrs = (
    (hours ?? []) as {
      day_of_week: number;
      open_time: string | null;
      close_time: string | null;
      closed: boolean;
    }[]
  ).map((h) => ({ day: h.day_of_week, open: h.open_time, close: h.close_time, closed: h.closed }));
  const systemPrompt = buildReceptionistInstructions({
    business: { name: b.name, public_phone: b.public_phone },
    services: svcs,
    areas: ars,
    hours: hrs,
    settings: s,
  });
  return { business: b, settings: s, systemPrompt };
}

export function resolveVapiWebhookUrl(env: NodeJS.ProcessEnv = process.env): string {
  return (
    env.VAPI_WEBHOOK_URL ??
    (env.PUBLIC_JOB_REQUEST_URL
      ? `${env.PUBLIC_JOB_REQUEST_URL.replace(/\/$/, "")}/api/public/webhooks/vapi-inbound`
      : "")
  );
}

export async function assertAiAccess(businessId: string) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data } = await supabaseAdmin.rpc("has_ai_receptionist_access", {
    _business_id: businessId,
  } as never);
  if (!data) throw new Error("Tenant does not have AI receptionist access (plan or trial gate).");
}

export async function requireWrite(
  operation: PromiseLike<{ error: { message: string } | null }>,
  label: string,
): Promise<void> {
  const { error } = await operation;
  if (error) throw new Error(`${label}: ${error.message}`);
}

/**
 * Canonical standard-receptionist provisioning. Assumes the CALLER has already
 * authorised the operation (owner/admin for the interactive path; explicit
 * staging guards for the bootstrap path). Verifies AI entitlement, creates the
 * Vapi assistant, and persists both the assistant id and the trusted provider
 * mapping — rolling back the remote assistant if the mapping cannot be stored.
 */
export async function provisionAiAssistantForBusinessInternal(
  businessId: string,
): Promise<
  | { provisioned: false; reason: string; requiredSecret: string }
  | { provisioned: true; providerAssistantId: string }
> {
  await assertAiAccess(businessId);
  const { createVapiAssistant, resolveVapiServerCredentialId, vapiCredentialsAvailable } =
    await import("@/lib/vapi.server");
  if (!vapiCredentialsAvailable()) {
    return {
      provisioned: false,
      reason: "VAPI_API_KEY not configured server-side",
      requiredSecret: "VAPI_API_KEY",
    };
  }
  const cfg = await loadTenantConfig(businessId);
  const serverUrl = resolveVapiWebhookUrl();
  if (!serverUrl) {
    throw new Error("VAPI_WEBHOOK_URL or PUBLIC_JOB_REQUEST_URL is required");
  }
  const serverCredentialId = await resolveVapiServerCredentialId(serverUrl);
  const created = await createVapiAssistant({
    name: `${cfg.business.name} Receptionist`,
    firstMessage: cfg.settings.first_message,
    systemPrompt: cfg.systemPrompt,
    language: cfg.settings.language,
    serverUrl,
    serverCredentialId,
    recordingEnabled: cfg.settings.recording_enabled,
    maxDurationSeconds: cfg.settings.max_call_duration_seconds,
  });
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  await requireWrite(
    supabaseAdmin
      .from("business_ai_receptionist_settings")
      .update({
        provider_assistant_id: created.id,
        status: "active",
        provider: "vapi",
        activated_at: new Date().toISOString(),
      } as never)
      .eq("business_id", businessId),
    "Failed to persist assistant settings",
  );
  try {
    // A freshly created Vapi assistant always has a new provider_assistant_id,
    // so this is an insert. The unique index on (provider, provider_assistant_id)
    // is PARTIAL (WHERE provider_assistant_id IS NOT NULL), which Postgres cannot
    // use for ON CONFLICT inference — so a plain insert is used, and any genuine
    // duplicate surfaces as a unique violation that triggers the cleanup below.
    await requireWrite(
      supabaseAdmin.from("ai_provider_mappings").insert({
        business_id: businessId,
        provider: "vapi",
        provider_assistant_id: created.id,
        active: true,
      } as never),
      "Failed to persist assistant mapping",
    );
  } catch (error) {
    // Do not leave an apparently usable but untrusted provider resource. Best-
    // effort remote cleanup, then a local error state for operator reconcile.
    const cleanupFailed = await (async () => {
      try {
        const { deleteVapiAssistant } = await import("@/lib/vapi.server");
        await deleteVapiAssistant(created.id);
        return false;
      } catch {
        return true;
      }
    })();
    await supabaseAdmin
      .from("business_ai_receptionist_settings")
      .update({
        status: "error",
        provider_assistant_id: cleanupFailed ? created.id : null,
      } as never)
      .eq("business_id", businessId);
    throw error;
  }
  return { provisioned: true, providerAssistantId: created.id };
}
