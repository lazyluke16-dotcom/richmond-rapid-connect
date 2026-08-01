import { createFileRoute } from "@tanstack/react-router";
import {
  extractBearerToken,
  requireAuthAndBusiness,
  recoverAcquisitionBusiness,
  computeAlertThresholds,
  sumUsageChargesMinor,
} from "@/lib/billing.server";
import { PLAN_BASE_PRICE_CENTS } from "@/lib/stripe.server";
import { GRACE_USAGE_CAP_AUD } from "@/lib/billing-types";
import type { EffectiveBillingState, SelectedPlan } from "@/lib/billing-types";

export const Route = createFileRoute("/api/public/billing/summary")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const token = extractBearerToken(request);
        if (!token) {
          return new Response(JSON.stringify({ error: "Unauthorized" }), {
            status: 401,
            headers: { "Content-Type": "application/json" },
          });
        }

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

        let businessId: string;
        try {
          ({ businessId } = await requireAuthAndBusiness(token, supabaseAdmin));
        } catch (e) {
          const err = e as { status?: number; message?: string };
          if (err.status === 404) {
            try {
              await recoverAcquisitionBusiness(token);
              ({ businessId } = await requireAuthAndBusiness(token, supabaseAdmin));
            } catch (recoveryCause) {
              const recoveryError = recoveryCause as { status?: number; message?: string };
              return new Response(
                JSON.stringify({ error: recoveryError.message ?? "No active business found" }),
                {
                  status: recoveryError.status ?? 404,
                  headers: { "Content-Type": "application/json" },
                },
              );
            }
          } else {
            return new Response(JSON.stringify({ error: err.message ?? "Auth failed" }), {
              status: err.status ?? 401,
              headers: { "Content-Type": "application/json" },
            });
          }
        }

        // Direct service-role queries scoped to verified businessId.
        // Do NOT use get_my_billing_detail() here — that RPC uses current_business_id()
        // which requires an auth.uid() context only available on user-scoped clients.
        const [
          { data: bizRow },
          { data: billingRow },
          effectiveStateResult,
          { data: telephonyRow },
          { data: aiRow },
        ] = await Promise.all([
          supabaseAdmin
            .from("businesses")
            .select(
              "name,public_email,public_phone,billing_exempt,promotion_code,setup_fee_waived_cents",
            )
            .eq("id", businessId)
            .single(),
          supabaseAdmin
            .from("business_billing")
            .select(
              "selected_plan, billing_status, stripe_customer_id, stripe_subscription_id, union_offer_eligible, union_offer_redeemed_at, platform_fee_waiver_ends_at, founding_offer_version, founding_offer_eligible, founding_offer_redeemed_at, founding_offer_ends_at, normal_billing_starts_at, current_period_start, current_period_end, grace_started_at, grace_expires_at, usage_limit_cents",
            )
            .eq("business_id", businessId)
            .maybeSingle(),
          // Call effective_billing_state with explicit _business_id — this RPC
          // accepts a UUID parameter and does not depend on auth.uid().
          supabaseAdmin.rpc("effective_billing_state", {
            _business_id: businessId,
          } as never),
          supabaseAdmin
            .from("business_telephony_settings")
            .select(
              "inbound_number,forwarding_setup_status,missed_call_recovery_enabled,ai_receptionist_enabled",
            )
            .eq("business_id", businessId)
            .maybeSingle(),
          supabaseAdmin
            .from("business_ai_receptionist_settings")
            .select("provider_assistant_id,status")
            .eq("business_id", businessId)
            .maybeSingle(),
        ]);

        if (!billingRow) {
          return new Response(JSON.stringify({ error: "Billing record not found" }), {
            status: 404,
            headers: { "Content-Type": "application/json" },
          });
        }

        const bb = billingRow as {
          selected_plan?: string | null;
          billing_status?: string;
          stripe_customer_id?: string | null;
          stripe_subscription_id?: string | null;
          union_offer_eligible?: boolean;
          union_offer_redeemed_at?: string | null;
          platform_fee_waiver_ends_at?: string | null;
          current_period_start?: string | null;
          current_period_end?: string | null;
          grace_started_at?: string | null;
          grace_expires_at?: string | null;
          usage_limit_cents?: number;
          founding_offer_version?: string | null;
          founding_offer_eligible?: boolean;
          founding_offer_redeemed_at?: string | null;
          founding_offer_ends_at?: string | null;
          normal_billing_starts_at?: string | null;
        };

        const effectiveState = (effectiveStateResult.data as unknown as string) ?? "unknown";
        const billingExempt = Boolean(
          (bizRow as { billing_exempt?: boolean } | null)?.billing_exempt,
        );
        const selectedPlan = (bb.selected_plan as SelectedPlan | null) ?? null;
        const periodStart = bb.current_period_start ? new Date(bb.current_period_start) : null;

        // ── Current-period usage ─────────────────────────────────────────────
        let usageQuery = supabaseAdmin
          .from("billing_usage_events")
          .select(
            "usage_type, quantity, billable, estimated_customer_charge, estimated_customer_charge_minor, billable_seconds, stripe_meter_event_status",
          )
          .eq("business_id", businessId);

        if (periodStart) {
          usageQuery = usageQuery.gte("created_at", periodStart.toISOString());
        }

        const { data: usageRows } = await usageQuery;
        const rows = (usageRows ?? []) as {
          usage_type?: string;
          quantity?: number | null;
          billable?: boolean;
          estimated_customer_charge?: number | null;
          estimated_customer_charge_minor?: number | null;
          billable_seconds?: number | null;
          stripe_meter_event_status?: string | null;
        }[];

        const billableVoiceRows = rows.filter(
          (row) => row.usage_type === "ai_voice_seconds" && row.billable,
        );
        const totalBillableSeconds = billableVoiceRows.reduce(
          (sum, row) => sum + (Number(row.billable_seconds) || 0),
          0,
        );
        const billableRows = rows.filter((row) => row.billable);
        const estimatedChargeAud = sumUsageChargesMinor(billableRows) / 100;
        const smsMessages = rows
          .filter((row) => row.usage_type === "outbound_sms")
          .reduce((sum, row) => sum + (Number(row.quantity) || 0), 0);
        const pendingMeterEvents = rows.filter(
          (r) =>
            r.stripe_meter_event_status === "pending" || r.stripe_meter_event_status === "failed",
        ).length;

        const alertThresholds = computeAlertThresholds(estimatedChargeAud);

        // ── Grace cap check ──────────────────────────────────────────────────
        let withinGraceCap = true;
        if (effectiveState === "past_due_grace" && bb.grace_started_at) {
          const graceRows = ((
            await supabaseAdmin
              .from("billing_usage_events")
              .select("estimated_customer_charge, estimated_customer_charge_minor")
              .eq("business_id", businessId)
              .eq("billable", true)
              .gte("created_at", bb.grace_started_at)
          ).data ?? []) as {
            estimated_customer_charge?: number | null;
            estimated_customer_charge_minor?: number | null;
          }[];

          const graceTotal = sumUsageChargesMinor(graceRows) / 100;
          withinGraceCap = graceTotal < GRACE_USAGE_CAP_AUD;
        }

        const platformFeeAud = selectedPlan ? (PLAN_BASE_PRICE_CENTS[selectedPlan] ?? 0) / 100 : 0;
        const business = (bizRow ?? {}) as {
          name?: string;
          public_email?: string | null;
          public_phone?: string | null;
          promotion_code?: string | null;
          setup_fee_waived_cents?: number | null;
        };
        const telephony = (telephonyRow ?? {}) as {
          inbound_number?: string | null;
          forwarding_setup_status?: string | null;
          missed_call_recovery_enabled?: boolean;
          ai_receptionist_enabled?: boolean;
        };
        const ai = (aiRow ?? {}) as {
          provider_assistant_id?: string | null;
          status?: string | null;
        };

        return new Response(
          JSON.stringify({
            account: {
              businessName: business.name ?? "",
              publicEmail: business.public_email ?? null,
              publicPhone: business.public_phone ?? null,
            },
            billing: {
              businessId,
              selectedPlan,
              billingStatus: bb.billing_status ?? "setup",
              effectiveState: effectiveState as EffectiveBillingState,
              billingExempt,
              unionOfferEligible: Boolean(bb.union_offer_eligible),
              unionOfferRedeemedAt: bb.union_offer_redeemed_at ?? null,
              platformFeeWaiverEndsAt: bb.platform_fee_waiver_ends_at ?? null,
              foundingOfferVersion: bb.founding_offer_version ?? null,
              foundingOfferEligible: Boolean(bb.founding_offer_eligible),
              foundingOfferRedeemedAt: bb.founding_offer_redeemed_at ?? null,
              foundingOfferEndsAt: bb.founding_offer_ends_at ?? null,
              normalBillingStartsAt: bb.normal_billing_starts_at ?? null,
              currentPeriodStart: bb.current_period_start ?? null,
              currentPeriodEnd: bb.current_period_end ?? null,
              graceExpiresAt: bb.grace_expires_at ?? null,
              hasStripeCustomer: Boolean(bb.stripe_customer_id),
              hasStripeSubscription: Boolean(bb.stripe_subscription_id),
              foundingPlumberBenefit:
                business.promotion_code === "FOUNDINGPLUMBER" &&
                Number(business.setup_fee_waived_cents) > 0
                  ? bb.founding_offer_version === "founding-2026-three-months"
                    ? `A$${(Number(business.setup_fee_waived_cents) / 100).toFixed(0)} sign-on fee waived and first three subscription months free`
                    : `A$${(Number(business.setup_fee_waived_cents) / 100).toFixed(0)} setup fee waived`
                  : null,
            },
            usage: {
              periodStart: periodStart?.toISOString() ?? null,
              totalBillableSeconds,
              estimatedChargeAud,
              smsMessages,
              smsBillable: true,
              pendingMeterEvents,
              alertThresholds,
              withinGraceCap,
            },
            platformFeeAud,
            estimatedCurrentTotalAud: platformFeeAud + estimatedChargeAud,
            connections: {
              stripe: Boolean(bb.stripe_customer_id),
              phoneNumber: telephony.inbound_number ?? null,
              phoneStatus: telephony.forwarding_setup_status ?? "unallocated",
              aiReceptionist: Boolean(ai.provider_assistant_id && ai.status === "active"),
              missedCallRecoveryEnabled: Boolean(telephony.missed_call_recovery_enabled),
              aiReceptionistEnabled: Boolean(telephony.ai_receptionist_enabled),
              sms: process.env.SMS_MODE === "twilio",
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      },
    },
  },
});
