import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  assertAiAccess,
  loadTenantConfig,
  provisionAiAssistantForBusinessInternal,
  requireWrite,
  resolveVapiWebhookUrl,
} from "@/lib/ai-provisioning.core";

/**
 * Authenticated server functions for Vapi assistant provisioning.
 *
 * The heavy lifting lives in ai-provisioning.core.ts (runtime-free) so the same
 * canonical provisioning path is shared by these authenticated entry points and
 * by the guarded staging bootstrap script. These wrappers only add owner/admin
 * authorisation on top of the shared core.
 */

// Preserve existing import paths for callers of resolveVapiWebhookUrl.
export { resolveVapiWebhookUrl };

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

export const createAiAssistantForBusiness = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { businessId: string }) => d)
  .handler(async ({ data, context }) => {
    await assertCallerCanProvision(context as unknown as ProvisioningContext, data.businessId);
    return provisionAiAssistantForBusinessInternal(data.businessId);
  });

export const updateAiAssistantForBusiness = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { businessId: string }) => d)
  .handler(async ({ data, context }) => {
    await assertCallerCanProvision(context as unknown as ProvisioningContext, data.businessId);
    await assertAiAccess(data.businessId);
    const { resolveVapiServerCredentialId, updateVapiAssistant, vapiCredentialsAvailable } =
      await import("@/lib/vapi.server");
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
    const serverUrl = resolveVapiWebhookUrl();
    if (!serverUrl) {
      throw new Error("VAPI_WEBHOOK_URL or PUBLIC_JOB_REQUEST_URL is required");
    }
    const serverCredentialId = await resolveVapiServerCredentialId(serverUrl, assistantId);
    await updateVapiAssistant(assistantId, {
      name: `${cfg.business.name} Receptionist`,
      firstMessage: cfg.settings.first_message,
      systemPrompt: cfg.systemPrompt,
      language: cfg.settings.language,
      serverUrl,
      serverCredentialId,
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
    const { error: modeError } = await context.supabase.rpc(
      "set_my_call_handling_mode" as never,
      { _mode: "off" } as never,
    );
    if (modeError) throw new Error(`Failed to turn call handling off: ${modeError.message}`);
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
        .update({ status: "inactive" } as never)
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
