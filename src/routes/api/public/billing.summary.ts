import { createFileRoute } from '@tanstack/react-router';
import {
  extractBearerToken,
  requireAuthAndBusiness,
  computeAlertThresholds,
} from '@/lib/billing.server';
import { PLAN_BASE_PRICE_CENTS } from '@/lib/stripe.server';
import { GRACE_USAGE_CAP_AUD } from '@/lib/billing-types';
import type { EffectiveBillingState, SelectedPlan } from '@/lib/billing-types';

export const Route = createFileRoute('/api/public/billing/summary')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const token = extractBearerToken(request);
        if (!token) {
          return new Response(JSON.stringify({ error: 'Unauthorized' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' },
          });
        }

        const { supabaseAdmin } = await import('@/integrations/supabase/client.server');

        let businessId: string;
        try {
          ({ businessId } = await requireAuthAndBusiness(token, supabaseAdmin));
        } catch (e) {
          const err = e as { status?: number; message?: string };
          return new Response(JSON.stringify({ error: err.message ?? 'Auth failed' }), {
            status: err.status ?? 401,
            headers: { 'Content-Type': 'application/json' },
          });
        }

        // Direct service-role queries scoped to verified businessId.
        // Do NOT use get_my_billing_detail() here — that RPC uses current_business_id()
        // which requires an auth.uid() context only available on user-scoped clients.
        const [{ data: bizRow }, { data: billingRow }, effectiveStateResult] = await Promise.all([
          supabaseAdmin
            .from('businesses')
            .select('billing_exempt')
            .eq('id', businessId)
            .single(),
          supabaseAdmin
            .from('business_billing')
            .select(
              'selected_plan, billing_status, stripe_customer_id, stripe_subscription_id, union_offer_eligible, union_offer_redeemed_at, platform_fee_waiver_ends_at, current_period_start, current_period_end, grace_started_at, grace_expires_at, usage_limit_cents',
            )
            .eq('business_id', businessId)
            .maybeSingle(),
          // Call effective_billing_state with explicit _business_id — this RPC
          // accepts a UUID parameter and does not depend on auth.uid().
          supabaseAdmin.rpc('effective_billing_state', {
            _business_id: businessId,
          } as never),
        ]);

        if (!billingRow) {
          return new Response(JSON.stringify({ error: 'Billing record not found' }), {
            status: 404,
            headers: { 'Content-Type': 'application/json' },
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
        };

        const effectiveState = (effectiveStateResult.data as unknown as string) ?? 'unknown';
        const billingExempt = Boolean((bizRow as { billing_exempt?: boolean } | null)?.billing_exempt);
        const selectedPlan = (bb.selected_plan as SelectedPlan | null) ?? null;
        const periodStart = bb.current_period_start ? new Date(bb.current_period_start) : null;

        // ── Current-period usage ─────────────────────────────────────────────
        let usageQuery = supabaseAdmin
          .from('billing_usage_events')
          .select('estimated_customer_charge, billable_seconds, stripe_meter_event_status')
          .eq('business_id', businessId)
          .eq('billable', true);

        if (periodStart) {
          usageQuery = usageQuery.gte('created_at', periodStart.toISOString());
        }

        const { data: usageRows } = await usageQuery;
        const rows = (usageRows ?? []) as {
          estimated_customer_charge?: number | null;
          billable_seconds?: number | null;
          stripe_meter_event_status?: string | null;
        }[];

        const totalBillableSeconds = rows.reduce((s, r) => s + (Number(r.billable_seconds) || 0), 0);
        const estimatedChargeAud = rows.reduce((s, r) => s + (Number(r.estimated_customer_charge) || 0), 0);
        const pendingMeterEvents = rows.filter(
          (r) => r.stripe_meter_event_status === 'pending' || r.stripe_meter_event_status === 'failed',
        ).length;

        const alertThresholds = computeAlertThresholds(estimatedChargeAud);

        // ── Grace cap check ──────────────────────────────────────────────────
        let withinGraceCap = true;
        if (effectiveState === 'past_due_grace' && bb.grace_started_at) {
          const graceRows = (
            (
              await supabaseAdmin
                .from('billing_usage_events')
                .select('estimated_customer_charge')
                .eq('business_id', businessId)
                .eq('billable', true)
                .gte('created_at', bb.grace_started_at)
            ).data ?? []
          ) as { estimated_customer_charge?: number | null }[];

          const graceTotal = graceRows.reduce((s, r) => s + (Number(r.estimated_customer_charge) || 0), 0);
          withinGraceCap = graceTotal < GRACE_USAGE_CAP_AUD;
        }

        const platformFeeAud = selectedPlan ? (PLAN_BASE_PRICE_CENTS[selectedPlan] ?? 0) / 100 : 0;

        return new Response(
          JSON.stringify({
            billing: {
              businessId,
              selectedPlan,
              billingStatus: bb.billing_status ?? 'setup',
              effectiveState: effectiveState as EffectiveBillingState,
              billingExempt,
              unionOfferEligible: Boolean(bb.union_offer_eligible),
              unionOfferRedeemedAt: bb.union_offer_redeemed_at ?? null,
              platformFeeWaiverEndsAt: bb.platform_fee_waiver_ends_at ?? null,
              currentPeriodStart: bb.current_period_start ?? null,
              currentPeriodEnd: bb.current_period_end ?? null,
              graceExpiresAt: bb.grace_expires_at ?? null,
              hasStripeCustomer: Boolean(bb.stripe_customer_id),
              hasStripeSubscription: Boolean(bb.stripe_subscription_id),
            },
            usage: {
              periodStart: periodStart?.toISOString() ?? null,
              totalBillableSeconds,
              estimatedChargeAud,
              pendingMeterEvents,
              alertThresholds,
              withinGraceCap,
            },
            platformFeeAud,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      },
    },
  },
});