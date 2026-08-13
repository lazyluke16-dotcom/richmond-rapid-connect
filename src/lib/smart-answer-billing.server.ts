const AI_VOICE_FALLBACK_RATE_AUD_PER_SEC = 0.00983333;

export interface SmartAnswerVoiceUsageInput {
  businessId: string;
  twilioDialCallSid: string;
  parentCallSid: string;
  seconds: number;
  dialStatus: string;
}

export async function recordSmartAnswerVoiceUsage(
  input: SmartAnswerVoiceUsageInput,
): Promise<{ recorded: boolean; billable: boolean; deduped?: boolean }> {
  const billableSeconds = Math.max(0, Math.round(Number(input.seconds) || 0));
  const externalCallId = input.twilioDialCallSid.trim();
  if (!input.businessId || !externalCallId) {
    throw new Error("Smart Answer billing identity is incomplete");
  }

  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const [{ data: rateRow }, { data: stateRow }, { data: aiSettings }] = await Promise.all([
    supabaseAdmin
      .from("billing_config")
      .select("value_numeric")
      .eq("key", "ai_voice_per_second_aud")
      .maybeSingle(),
    supabaseAdmin.rpc("effective_billing_state", { _business_id: input.businessId } as never),
    supabaseAdmin
      .from("business_ai_receptionist_settings")
      .select("mode")
      .eq("business_id", input.businessId)
      .maybeSingle(),
  ]);

  const customerRate = Number(
    (rateRow as { value_numeric?: number } | null)?.value_numeric ??
      AI_VOICE_FALLBACK_RATE_AUD_PER_SEC,
  );
  const effectiveState = (stateRow as unknown as string) ?? "unknown";
  const aiMode = (aiSettings as { mode?: string } | null)?.mode ?? "demo";

  let billable = false;
  let nonBillableReason: string | null = null;
  if (billableSeconds < 1) {
    nonBillableReason = "no_duration";
  } else if (input.dialStatus !== "completed") {
    nonBillableReason = `dial_status:${input.dialStatus || "unknown"}`;
  } else if (aiMode !== "live") {
    nonBillableReason = "demo_mode";
  } else if (effectiveState === "billing_exempt_test") {
    nonBillableReason = "billing_exempt_test";
  } else if (effectiveState === "active" || effectiveState === "past_due_grace") {
    billable = true;
  } else {
    nonBillableReason = `billing_state:${effectiveState}`;
  }

  const estimatedCharge = billable
    ? Math.round(billableSeconds * customerRate * 10000) / 10000
    : null;
  const identifier = `smart_twilio_${externalCallId}`;
  const endedAt = new Date().toISOString();

  const { error: ledgerError } = await supabaseAdmin.from("billing_usage_events").insert({
    business_id: input.businessId,
    usage_type: "ai_voice_seconds",
    provider: "twilio",
    provider_event_id: input.parentCallSid || null,
    external_call_id: externalCallId,
    quantity: billableSeconds,
    unit: "seconds",
    started_at: null,
    ended_at: endedAt,
    billable_seconds: billableSeconds,
    provider_cost_amount: null,
    provider_cost_currency: null,
    customer_rate: billable ? customerRate : null,
    customer_rate_currency: "AUD",
    estimated_customer_charge: estimatedCharge,
    billable,
    non_billable_reason: nonBillableReason,
    stripe_meter_event_identifier: identifier,
    stripe_meter_event_status: billable ? "pending" : "skipped",
    metadata: {
      route: "smart_answer",
      twilio_parent_call_sid: input.parentCallSid,
      twilio_dial_call_sid: externalCallId,
      dial_status: input.dialStatus,
      effective_state: effectiveState,
      ai_mode: aiMode,
    },
  } as never);

  if (ledgerError) {
    if (/duplicate key|billing_usage_events_provider_call_uk/i.test(ledgerError.message)) {
      return { recorded: true, billable, deduped: true };
    }
    throw new Error(`Smart Answer usage ledger insert failed: ${ledgerError.message}`);
  }

  if (!billable) return { recorded: true, billable: false };

  if (effectiveState === "past_due_grace") {
    try {
      const { data: billingRow } = await supabaseAdmin
        .from("business_billing")
        .select("grace_started_at")
        .eq("business_id", input.businessId)
        .maybeSingle();
      const graceStart = (billingRow as { grace_started_at?: string | null } | null)
        ?.grace_started_at;
      if (graceStart) {
        const { checkGraceUsageCap, suspendBusiness } = await import("@/lib/billing.server");
        const cap = await checkGraceUsageCap(
          input.businessId,
          new Date(graceStart),
          supabaseAdmin,
        );
        if (cap.shouldSuspend) await suspendBusiness(input.businessId, supabaseAdmin);
      }
    } catch (error) {
      console.warn("[smart-answer/billing] grace-cap check failed", error);
    }
  }

  try {
    const { data: billingRow } = await supabaseAdmin
      .from("business_billing")
      .select("stripe_customer_id")
      .eq("business_id", input.businessId)
      .maybeSingle();
    const stripeCustomerId = (billingRow as { stripe_customer_id?: string | null } | null)
      ?.stripe_customer_id;
    if (stripeCustomerId) {
      const { submitMeterEventByIdentifier } = await import("@/lib/billing-meter.server");
      const result = await submitMeterEventByIdentifier(
        input.businessId,
        identifier,
        stripeCustomerId,
        supabaseAdmin,
      );
      if (!result.success && !result.skipped) {
        console.warn("[smart-answer/billing] Stripe meter event queued for retry", result.error);
      }
    }
  } catch (error) {
    // Ledger is authoritative; the existing retry worker can recover a failed meter dispatch.
    console.warn("[smart-answer/billing] Stripe meter dispatch failed", error);
  }

  return { recorded: true, billable: true };
}
