import { createFileRoute } from "@tanstack/react-router";
import type Stripe from "stripe";
import { extractBearerToken, requireAuthAndBusiness } from "@/lib/billing.server";
import { isCheckoutSessionId } from "@/lib/checkout-return";
import {
  getCheckoutLineItems,
  getStripe,
  PLAN_BASE_PRICE_CENTS,
  stripeEnvValue,
  stripeKeyMode,
  type StripePlan,
} from "@/lib/stripe.server";

const JSON_HEADERS = { "Content-Type": "application/json" };
const ACTIVE_SUBSCRIPTION_STATUSES = new Set(["active", "trialing"]);
const ALLOWED_PLANS = new Set<StripePlan>(["missed_call_recovery", "ai_receptionist"]);

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function stripeId(value: string | { id: string } | null): string | null {
  if (!value) return null;
  return typeof value === "string" ? value : value.id;
}

function subscriptionPeriod(subscription: Stripe.Subscription) {
  const start = new Date(subscription.billing_cycle_anchor * 1000);
  const end = new Date(start);
  const recurring = subscription.items.data[0]?.price.recurring;
  const count = recurring?.interval_count ?? 1;
  if (recurring?.interval === "year") end.setFullYear(end.getFullYear() + count);
  else if (recurring?.interval === "week") end.setDate(end.getDate() + 7 * count);
  else if (recurring?.interval === "day") end.setDate(end.getDate() + count);
  else end.setMonth(end.getMonth() + count);
  return { start: start.toISOString(), end: end.toISOString() };
}

function expectedPriceIds(plan: StripePlan) {
  return getCheckoutLineItems(plan).map((item) => String(item.price));
}

function sameIds(actual: string[], expected: string[]) {
  return actual.length === expected.length && expected.every((id) => actual.includes(id));
}

export const Route = createFileRoute("/api/public/billing/checkout-status")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const token = extractBearerToken(request);
        if (!token) return json({ error: "Unauthorized", code: "unauthorized" }, 401);

        let input: { sessionId?: unknown };
        try {
          input = (await request.json()) as { sessionId?: unknown };
        } catch {
          return json({ error: "Invalid request", code: "invalid_request" }, 400);
        }
        if (!isCheckoutSessionId(input.sessionId)) {
          return json({ error: "Invalid checkout return", code: "invalid_checkout_return" }, 400);
        }

        try {
          const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
          const { businessId } = await requireAuthAndBusiness(token, supabaseAdmin);
          const [{ data: billingRow }, { data: businessRow }] = await Promise.all([
            supabaseAdmin
              .from("business_billing")
              .select("selected_plan,stripe_customer_id,stripe_subscription_id")
              .eq("business_id", businessId)
              .maybeSingle(),
            supabaseAdmin
              .from("businesses")
              .select("promotion_code,setup_fee_waived_cents")
              .eq("id", businessId)
              .maybeSingle(),
          ]);

          const billing = billingRow as {
            selected_plan?: string | null;
            stripe_customer_id?: string | null;
            stripe_subscription_id?: string | null;
          } | null;
          const plan = billing?.selected_plan as StripePlan | null;
          if (!plan || !ALLOWED_PLANS.has(plan)) {
            return json({ error: "Billing setup is incomplete", code: "billing_not_ready" }, 409);
          }

          const stripe = getStripe();
          const session = await stripe.checkout.sessions.retrieve(input.sessionId);
          const sessionCustomerId = stripeId(session.customer);
          const configuredMode = stripeKeyMode(stripeEnvValue("STRIPE_SECRET_KEY") ?? "");

          if (
            session.metadata?.business_id !== businessId ||
            session.metadata?.plan !== plan ||
            session.mode !== "subscription" ||
            session.livemode !== (configuredMode === "live") ||
            (billing?.stripe_customer_id && sessionCustomerId !== billing.stripe_customer_id)
          ) {
            return json(
              { error: "Checkout return could not be verified", code: "checkout_mismatch" },
              403,
            );
          }

          if (session.status !== "complete" || !session.subscription) {
            return json({ verified: true, status: "processing", code: "checkout_processing" }, 202);
          }

          const subscriptionId = stripeId(session.subscription);
          if (!subscriptionId) {
            return json({ verified: true, status: "processing", code: "checkout_processing" }, 202);
          }
          const [subscription, lineItems] = await Promise.all([
            stripe.subscriptions.retrieve(subscriptionId),
            stripe.checkout.sessions.listLineItems(session.id, { limit: 20 }),
          ]);
          const actualPriceIds = lineItems.data
            .map((item) => item.price?.id)
            .filter((id): id is string => Boolean(id));
          const paid =
            session.payment_status === "paid" || session.payment_status === "no_payment_required";
          if (!ACTIVE_SUBSCRIPTION_STATUSES.has(subscription.status) || !paid) {
            return json(
              { verified: true, status: "processing", code: "activation_processing" },
              202,
            );
          }
          if (
            stripeId(subscription.customer) !== sessionCustomerId ||
            subscription.metadata.business_id !== businessId ||
            subscription.metadata.plan !== plan ||
            !sameIds(actualPriceIds, expectedPriceIds(plan))
          ) {
            return json(
              { error: "Checkout return could not be verified", code: "subscription_mismatch" },
              403,
            );
          }

          const period = subscriptionPeriod(subscription);
          const { error: updateError } = await supabaseAdmin
            .from("business_billing")
            .update({
              billing_status: "active",
              stripe_customer_id: sessionCustomerId,
              stripe_subscription_id: subscription.id,
              stripe_subscription_status: subscription.status,
              selected_plan: plan,
              billing_cycle_anchor: new Date(
                subscription.billing_cycle_anchor * 1000,
              ).toISOString(),
              current_period_start: period.start,
              current_period_end: period.end,
              grace_started_at: null,
              grace_expires_at: null,
              suspended_at: null,
              last_synced_at: new Date().toISOString(),
            })
            .eq("business_id", businessId);
          if (updateError) {
            throw new Error(`Billing activation persistence failed: ${updateError.message}`);
          }

          const business = businessRow as {
            promotion_code?: string | null;
            setup_fee_waived_cents?: number | null;
          } | null;
          const foundingBenefit =
            business?.promotion_code === "FOUNDINGPLUMBER" &&
            Number(business.setup_fee_waived_cents) > 0
              ? `A$${(Number(business.setup_fee_waived_cents) / 100).toFixed(0)} setup fee waived`
              : null;

          return json({
            verified: true,
            status: "active",
            billingStatus: "active",
            plan,
            planName: plan === "ai_receptionist" ? "AI Receptionist" : "Missed-call recovery",
            monthlyPriceAud: PLAN_BASE_PRICE_CENTS[plan] / 100,
            foundingBenefit,
          });
        } catch (cause) {
          const status = (cause as { status?: number }).status;
          if (status === 401 || status === 403 || status === 404) {
            return json(
              { error: "Checkout return could not be verified", code: "checkout_unavailable" },
              status,
            );
          }
          const record = cause as { type?: string; code?: string; requestId?: string };
          console.error("[billing.checkout-status] verification failed", {
            errorName: cause instanceof Error ? cause.name : "UnknownError",
            providerType: record.type,
            providerCode: record.code,
            requestId: record.requestId,
          });
          return json(
            {
              error: "We could not confirm billing yet. Please try again.",
              code: "verification_failed",
            },
            503,
          );
        }
      },
    },
  },
});
