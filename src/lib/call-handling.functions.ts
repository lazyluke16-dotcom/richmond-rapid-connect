import { createServerFn } from "@tanstack/react-start";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { Database } from "@/integrations/supabase/types";
import {
  CallHandlingModeSchema,
  entitlementsForPlan,
  normalizeAustralianPhone,
  type CallHandlingMode,
  type ServiceEntitlements,
} from "@/lib/call-handling";

export interface CallHandlingContext {
  business: {
    id: string;
    name: string;
    publicPhone: string | null;
    selectedPlan: "missed_call_recovery" | "ai_receptionist" | "both" | null;
  };
  mode: CallHandlingMode;
  operational: {
    missedCallRecovery: boolean;
    aiReceptionist: boolean;
  };
  entitlements: ServiceEntitlements;
  canManage: boolean;
  forwarding: {
    number: string | null;
    status: "unallocated" | "reserved" | "pending_verification" | "verified" | "error";
    verificationExpiresAt: string | null;
    verifiedAt: string | null;
  };
  provider: {
    aiReady: boolean;
    smsReady: boolean;
  };
  usage: {
    aiVoiceSeconds: number;
    smsMessages: number;
    smsBillable: true;
  };
}

async function requireOwnBusiness(context: { userId: string; supabase: SupabaseClient<Database> }) {
  const { data: business, error } = await context.supabase
    .from("businesses")
    .select("id,name,public_phone,selected_plan")
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!business) throw new Error("No business membership found");

  const { data: membership, error: membershipError } = await context.supabase
    .from("business_users")
    .select("role")
    .eq("business_id", business.id)
    .eq("user_id", context.userId)
    .maybeSingle();
  if (membershipError) throw new Error(membershipError.message);

  return {
    business: business as {
      id: string;
      name: string;
      public_phone: string | null;
      selected_plan: "missed_call_recovery" | "ai_receptionist" | "both" | null;
    },
    canManage: Boolean(
      membership && ["owner", "admin"].includes((membership as { role?: string }).role ?? ""),
    ),
  };
}

export const getMyCallHandlingContext = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<CallHandlingContext> => {
    const own = await requireOwnBusiness(context as never);
    const businessId = own.business.id;
    const [telephonyResult, aiResult, missedAccessResult, aiAccessResult, usageResult] =
      await Promise.all([
        context.supabase
          .from("business_telephony_settings")
          .select(
            "answering_mode,inbound_number,forwarding_setup_status,forwarding_verification_expires_at,forwarding_verified_at,missed_call_recovery_enabled,ai_receptionist_enabled",
          )
          .eq("business_id", businessId)
          .maybeSingle(),
        context.supabase
          .from("business_ai_receptionist_settings")
          .select("provider_assistant_id,status")
          .eq("business_id", businessId)
          .maybeSingle(),
        context.supabase.rpc("has_missed_call_access", { _business_id: businessId }),
        context.supabase.rpc("has_ai_receptionist_access", { _business_id: businessId }),
        context.supabase
          .from("billing_usage_events")
          .select("usage_type,quantity")
          .eq("business_id", businessId),
      ]);

    for (const result of [
      telephonyResult,
      aiResult,
      missedAccessResult,
      aiAccessResult,
      usageResult,
    ]) {
      if (result.error) throw new Error(result.error.message);
    }

    const telephony = (telephonyResult.data ?? {}) as {
      answering_mode?: string;
      inbound_number?: string | null;
      forwarding_setup_status?: CallHandlingContext["forwarding"]["status"];
      forwarding_verified_at?: string | null;
      forwarding_verification_expires_at?: string | null;
      missed_call_recovery_enabled?: boolean;
      ai_receptionist_enabled?: boolean;
    };
    const ai = aiResult.data as {
      provider_assistant_id?: string | null;
      status?: string;
    } | null;
    const entitlements = entitlementsForPlan(own.business.selected_plan, {
      missedCall: Boolean(missedAccessResult.data),
      aiReceptionist: Boolean(aiAccessResult.data),
    });
    const usageRows = (usageResult.data ?? []) as {
      usage_type: "ai_voice_seconds" | "outbound_sms";
      quantity: number | string;
    }[];

    return {
      business: {
        id: businessId,
        name: own.business.name,
        publicPhone: own.business.public_phone,
        selectedPlan: own.business.selected_plan,
      },
      mode: CallHandlingModeSchema.catch("off").parse(telephony.answering_mode),
      operational: {
        missedCallRecovery: Boolean(telephony.missed_call_recovery_enabled),
        aiReceptionist: Boolean(telephony.ai_receptionist_enabled),
      },
      entitlements,
      canManage: own.canManage,
      forwarding: {
        number: telephony.inbound_number ?? null,
        status: telephony.forwarding_setup_status ?? "unallocated",
        verificationExpiresAt: telephony.forwarding_verification_expires_at ?? null,
        verifiedAt: telephony.forwarding_verified_at ?? null,
      },
      provider: {
        aiReady: Boolean(ai?.provider_assistant_id && ai.status === "active"),
        smsReady: process.env.SMS_MODE === "twilio",
      },
      usage: {
        aiVoiceSeconds: usageRows
          .filter((row) => row.usage_type === "ai_voice_seconds")
          .reduce((sum, row) => sum + Number(row.quantity || 0), 0),
        smsMessages: usageRows
          .filter((row) => row.usage_type === "outbound_sms")
          .reduce((sum, row) => sum + Number(row.quantity || 0), 0),
        smsBillable: true,
      },
    };
  });

export const updateMyCustomerPhone = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { phone: string }) => data)
  .handler(async ({ data, context }) => {
    const phone = normalizeAustralianPhone(data.phone);
    const { error } = await context.supabase.rpc(
      "set_my_customer_phone" as never,
      {
        _phone_e164: phone,
      } as never,
    );
    if (error) throw new Error(error.message);
    return { success: true, phone };
  });

export const reserveMyForwardingNumber = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase.rpc("reserve_my_platform_phone" as never);
    if (error) throw new Error(error.message);
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) throw new Error("No forwarding number was allocated");
    const result = row as {
      inventory_id: string;
      forwarding_number: string;
      verification_status: string;
    };
    return {
      inventoryId: result.inventory_id,
      forwardingNumber: result.forwarding_number,
      verificationStatus: result.verification_status,
    };
  });

export const setMyCallHandlingMode = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { mode: CallHandlingMode }) => data)
  .handler(async ({ data, context }) => {
    const mode = CallHandlingModeSchema.parse(data.mode);
    const { error } = await context.supabase.rpc(
      "set_my_call_handling_mode" as never,
      {
        _mode: mode,
      } as never,
    );
    if (error) throw new Error(error.message);
    return { success: true, mode };
  });

export const setMyOperationalService = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (data: { service: "missed_call_recovery" | "ai_receptionist"; enabled: boolean }) => data,
  )
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase.rpc(
      "set_my_service_enabled" as never,
      { _service: data.service, _enabled: Boolean(data.enabled) } as never,
    );
    if (error) throw new Error(error.message);
    return { success: true, ...data };
  });

export const startMyForwardingVerification = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase.rpc("start_my_forwarding_verification" as never);
    if (error) throw new Error(error.message);
    return { success: true, expiresAt: data as unknown as string };
  });
