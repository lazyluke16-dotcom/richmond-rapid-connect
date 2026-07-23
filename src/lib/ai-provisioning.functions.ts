import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { buildReceptionistInstructions } from "@/lib/ai-receptionist.functions";

/**
 * Server-side provisioning helpers for Vapi assistants.
 *
 * All Vapi API calls run server-side using VAPI_API_KEY (never exposed to the
 * browser). Successful create/update writes the returned provider_assistant_id
 * into both business_ai_receptionist_settings and ai_provider_mappings so the
 * webhook's trusted-mapping resolution can identify the tenant.
 */

async function loadTenantConfig(businessId: string) {
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
    settings: s as never,
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

async function assertAiAccess(businessId: string) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data } = await supabaseAdmin.rpc("has_ai_receptionist_access", {
    _business_id: businessId,
  } as never);
  if (!data) throw new Error("Tenant does not have AI receptionist access (plan or trial gate).");
}

type ProvisioningContext = {
  userId: string;
  supabase: {
    from: (table: string) => {
      select: (columns: string) => {
        eq: (
          column: string,
          value: string,
        ) => {
          eq: (
            column: string,
            value: string,
          ) => {
            maybeSingle: () => Promise<{ data: unknown; error: { message: string } | null }>;
          };
        };
      };
    };
  };
};

export async function assertCallerCanProvision(
  context: ProvisioningContext,
  businessId: string,
): Promise<void> {
  const { data, error } = await context.supabase
    .from("business_users")
    .select("business_id,role")
    .eq("business_id", businessId)
    .eq("user_id", context.userId)
    .maybeSingle();
  if (error) throw new Error(`Unable to verify provisioning authority: ${error.message}`);
  const membership = data as { business_id: string; role: string } | null;
  if (!membership || !["owner", "admin"].includes(membership.role)) {
    throw new Error("Forbidden: owner or admin access is required");
  }
}

async function requireWrite(
  operation: PromiseLike<{ error: { message: string } | null }>,
  label: string,
): Promise<void> {
  const { error } = await operation;
  if (error) throw new Error(`${label}: ${error.message}`);
}

export const createAiAssistantForBusiness = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { businessId: string }) => d)
  .handler(async ({ data, context }) => {
    await assertCallerCanProvision(context as unknown as ProvisioningContext, data.businessId);
    await assertAiAccess(data.businessId);
    const { createVapiAssistant, vapiCredentialsAvailable } = await import("@/lib/vapi.server");
    if (!vapiCredentialsAvailable()) {
      return {
        provisioned: false,
        reason: "VAPI_API_KEY not configured server-side",
        requiredSecret: "VAPI_API_KEY",
      };
    }
    const cfg = await loadTenantConfig(data.businessId);
    const created = await createVapiAssistant({
      name: `${cfg.business.name} Receptionist`,
      firstMessage: cfg.settings.first_message,
      systemPrompt: cfg.systemPrompt,
      language: cfg.settings.language,
      serverUrl: resolveVapiWebhookUrl() || undefined,
      serverSecret: process.env.VAPI_SERVER_SECRET,
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
          enabled: true,
          mode: "live",
          activated_at: new Date().toISOString(),
        } as never)
        .eq("business_id", data.businessId),
      "Failed to persist assistant settings",
    );
    try {
      await requireWrite(
        supabaseAdmin.from("ai_provider_mappings").upsert(
          {
            business_id: data.businessId,
            provider: "vapi",
            provider_assistant_id: created.id,
            active: true,
          } as never,
          { onConflict: "provider,provider_assistant_id" } as never,
        ),
        "Failed to persist assistant mapping",
      );
    } catch (error) {
      // Do not leave an apparently usable but untrusted provider resource.
      // Best-effort remote cleanup is followed by a local error state so an
      // operator can see and reconcile the failure if cleanup also fails.
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
        .eq("business_id", data.businessId);
      throw error;
    }
    return { provisioned: true, providerAssistantId: created.id };
  });

export const updateAiAssistantForBusiness = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { businessId: string }) => d)
  .handler(async ({ data, context }) => {
    await assertCallerCanProvision(context as unknown as ProvisioningContext, data.businessId);
    await assertAiAccess(data.businessId);
    const { updateVapiAssistant, vapiCredentialsAvailable } = await import("@/lib/vapi.server");
    if (!vapiCredentialsAvailable()) {
      return {
        updated: false,
        reason: "VAPI_API_KEY not configured server-side",
        requiredSecret: "VAPI_API_KEY",
      };
    }
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: row } = await supabaseAdmin
      .from("business_ai_receptionist_settings")
      .select("provider_assistant_id")
      .eq("business_id", data.businessId)
      .maybeSingle();
    const assistantId = (row as { provider_assistant_id?: string } | null)?.provider_assistant_id;
    if (!assistantId) throw new Error("No provider_assistant_id — provision the assistant first");
    const cfg = await loadTenantConfig(data.businessId);
    await updateVapiAssistant(assistantId, {
      name: `${cfg.business.name} Receptionist`,
      firstMessage: cfg.settings.first_message,
      systemPrompt: cfg.systemPrompt,
      language: cfg.settings.language,
      serverUrl: resolveVapiWebhookUrl() || undefined,
      serverSecret: process.env.VAPI_SERVER_SECRET,
      recordingEnabled: cfg.settings.recording_enabled,
      maxDurationSeconds: cfg.settings.max_call_duration_seconds,
    });
    await requireWrite(
      supabaseAdmin
        .from("business_ai_receptionist_settings")
        .update({ status: "active", updated_at: new Date().toISOString() } as never)
        .eq("business_id", data.businessId),
      "Failed to record assistant update",
    );
    return { updated: true, providerAssistantId: assistantId };
  });

export const deactivateAiAssistantForBusiness = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { businessId: string }) => d)
  .handler(async ({ data, context }) => {
    await assertCallerCanProvision(context as unknown as ProvisioningContext, data.businessId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: row } = await supabaseAdmin
      .from("business_ai_receptionist_settings")
      .select("provider_assistant_id")
      .eq("business_id", data.businessId)
      .maybeSingle();
    const assistantId = (row as { provider_assistant_id?: string } | null)?.provider_assistant_id;
    // Mark inactive in mapping; delete remote assistant if possible.
    await requireWrite(
      supabaseAdmin
        .from("ai_provider_mappings")
        .update({ active: false } as never)
        .eq("business_id", data.businessId)
        .eq("provider", "vapi"),
      "Failed to deactivate assistant mapping",
    );
    await requireWrite(
      supabaseAdmin
        .from("business_ai_receptionist_settings")
        .update({ enabled: false, status: "inactive" } as never)
        .eq("business_id", data.businessId),
      "Failed to deactivate assistant settings",
    );
    if (assistantId) {
      const { deleteVapiAssistant, vapiCredentialsAvailable } = await import("@/lib/vapi.server");
      if (vapiCredentialsAvailable()) {
        try {
          await deleteVapiAssistant(assistantId);
        } catch (e) {
          console.warn("[vapi] delete failed", e);
        }
      }
    }
    return { deactivated: true };
  });
