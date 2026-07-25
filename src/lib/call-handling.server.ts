import {
  buildNonBillableSmsUsage,
  CallHandlingModeSchema,
  selectInboundWorkflow,
  type InboundWorkflow,
} from "@/lib/call-handling";
import { renderSmsTemplate } from "@/lib/missed-call.functions";
import { sendSms } from "@/lib/sms";

function fromPendingMigration(client: unknown, table: "telephony_provider_events") {
  return (
    client as {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- generated DB types update after migration application
      from: (name: string) => any;
    }
  ).from(table);
}

export interface ResolvedInboundTenant {
  businessId: string;
  mode: "off" | "text_link" | "ai_receptionist";
  forwardingStatus: string;
  businessName: string;
  businessSlug: string;
  publicPhone: string | null;
  assistantId: string | null;
  smsTemplate: string;
  textLinkEntitled: boolean;
  aiReceptionistEntitled: boolean;
}

export async function resolveInboundTenant(input: {
  provider: string;
  phoneId?: string | null;
  phoneNumber?: string | null;
}): Promise<ResolvedInboundTenant | null> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data, error } = await supabaseAdmin.rpc(
    "resolve_call_handling_tenant" as never,
    {
      _provider: input.provider,
      _phone_id: input.phoneId ?? null,
      _phone_number: input.phoneNumber ?? null,
    } as never,
  );
  if (error) throw new Error(`Call-handling tenant resolution failed: ${error.message}`);
  const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null;
  if (!row) return null;
  return {
    businessId: String(row.business_id),
    mode: CallHandlingModeSchema.parse(row.answering_mode),
    forwardingStatus: String(row.forwarding_setup_status ?? "unallocated"),
    businessName: String(row.business_name),
    businessSlug: String(row.business_slug),
    publicPhone: typeof row.public_phone === "string" ? row.public_phone : null,
    assistantId: typeof row.assistant_id === "string" ? row.assistant_id : null,
    smsTemplate: String(row.sms_template ?? ""),
    textLinkEntitled: Boolean(row.text_link_entitled),
    aiReceptionistEntitled: Boolean(row.ai_receptionist_entitled),
  };
}

export function workflowForTenant(tenant: ResolvedInboundTenant): InboundWorkflow {
  return selectInboundWorkflow({
    mode: tenant.mode,
    textLinkEntitled: tenant.textLinkEntitled,
    aiReceptionistEntitled: tenant.aiReceptionistEntitled,
    assistantId: tenant.assistantId,
  });
}

export async function markForwardingVerified(
  businessId: string,
  providerCallId: string,
): Promise<void> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { error } = await supabaseAdmin.rpc(
    "mark_forwarding_verified" as never,
    {
      _business_id: businessId,
      _provider_call_id: providerCallId,
    } as never,
  );
  if (error) throw new Error(`Could not verify forwarding: ${error.message}`);
}

export interface RecoveryDispatchResult {
  deduped: boolean;
  missedCallId: string | null;
  smsEventId: string | null;
}

/**
 * Claim a provider call before sending. The unique provider event row and the
 * missed_calls source constraint make retries safe across concurrent workers.
 */
export async function dispatchTextLinkRecovery(input: {
  tenant: ResolvedInboundTenant;
  provider: string;
  providerEventId: string;
  callerPhone: string;
  publicBaseUrl: string;
}): Promise<RecoveryDispatchResult> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const missedCallId = crypto.randomUUID();
  const source = `${input.provider}:${input.providerEventId}`;

  const { error: claimError } = await fromPendingMigration(
    supabaseAdmin,
    "telephony_provider_events",
  ).insert({
    provider: input.provider,
    event_type: "inbound_call",
    provider_event_id: input.providerEventId,
    business_id: input.tenant.businessId,
    status: "processing",
    workflow: "text_link",
    missed_call_id: missedCallId,
  } as never);
  if (claimError) {
    if (/duplicate key|telephony_provider_events_replay_uk/i.test(claimError.message)) {
      const { data: existing } = await fromPendingMigration(
        supabaseAdmin,
        "telephony_provider_events",
      )
        .select("status,missed_call_id,sms_event_id")
        .eq("provider", input.provider)
        .eq("event_type", "inbound_call")
        .eq("provider_event_id", input.providerEventId)
        .maybeSingle();
      if ((existing as { status?: string } | null)?.status === "failed") {
        throw new Error("The prior recovery SMS attempt failed");
      }
      return {
        deduped: true,
        missedCallId:
          typeof (existing as { missed_call_id?: unknown } | null)?.missed_call_id === "string"
            ? (existing as { missed_call_id: string }).missed_call_id
            : null,
        smsEventId:
          typeof (existing as { sms_event_id?: unknown } | null)?.sms_event_id === "string"
            ? (existing as { sms_event_id: string }).sms_event_id
            : null,
      };
    }
    throw new Error(`Provider replay claim failed: ${claimError.message}`);
  }

  const recoveryLink = `${input.publicBaseUrl.replace(/\/+$/, "")}/b/${input.tenant.businessSlug}/request?source=missed_call&mcid=${missedCallId}`;
  const smsBody = renderSmsTemplate(input.tenant.smsTemplate, {
    business_name: input.tenant.businessName,
    recovery_link: recoveryLink,
    public_phone: input.tenant.publicPhone,
  });

  const { error: missedCallError } = await supabaseAdmin.from("missed_calls").insert({
    id: missedCallId,
    caller_phone: input.callerPhone,
    sms_sent: false,
    source,
    business_id: input.tenant.businessId,
  } as never);
  if (missedCallError) {
    await fromPendingMigration(supabaseAdmin, "telephony_provider_events")
      .update({ status: "failed", error_message: "missed_call_persistence_failed" } as never)
      .eq("provider", input.provider)
      .eq("event_type", "inbound_call")
      .eq("provider_event_id", input.providerEventId);
    throw new Error(`Missed-call persistence failed: ${missedCallError.message}`);
  }

  const smsResult = await sendSms(input.callerPhone, smsBody, input.tenant.businessId);
  if (smsResult.status !== "sent") {
    await fromPendingMigration(supabaseAdmin, "telephony_provider_events")
      .update({ status: "failed", error_message: "sms_delivery_failed" } as never)
      .eq("provider", input.provider)
      .eq("event_type", "inbound_call")
      .eq("provider_event_id", input.providerEventId);
    throw new Error("Recovery SMS delivery failed");
  }

  const [missedCallUpdate, eventUpdate, usageInsert] = await Promise.all([
    supabaseAdmin
      .from("missed_calls")
      .update({ sms_sent: true, sms_event_id: smsResult.id } as never)
      .eq("id", missedCallId)
      .eq("business_id", input.tenant.businessId),
    fromPendingMigration(supabaseAdmin, "telephony_provider_events")
      .update({ status: "processed", sms_event_id: smsResult.id } as never)
      .eq("provider", input.provider)
      .eq("event_type", "inbound_call")
      .eq("provider_event_id", input.providerEventId),
    supabaseAdmin.from("billing_usage_events").insert(
      buildNonBillableSmsUsage({
        businessId: input.tenant.businessId,
        provider: "twilio",
        providerEventId: smsResult.twilioSid ?? null,
        externalCallId: input.providerEventId,
        smsEventId: smsResult.id,
      }) as never,
    ),
  ]);
  if (missedCallUpdate.error) {
    throw new Error(`SMS sent but missed-call update failed: ${missedCallUpdate.error.message}`);
  }
  if (eventUpdate.error) {
    throw new Error(`SMS sent but provider event update failed: ${eventUpdate.error.message}`);
  }
  if (
    usageInsert.error &&
    !/duplicate key|billing_usage_events_provider_call_uk/i.test(usageInsert.error.message)
  ) {
    throw new Error(`SMS sent but usage persistence failed: ${usageInsert.error.message}`);
  }

  return { deduped: false, missedCallId, smsEventId: smsResult.id };
}
