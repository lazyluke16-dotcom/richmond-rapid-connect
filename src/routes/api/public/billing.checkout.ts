import { createFileRoute } from "@tanstack/react-router";
import {
  getStripe,
  getCheckoutLineItems,
  getUnionCouponId,
  type StripePlan,
} from "@/lib/stripe.server";
import type Stripe from "stripe";
import { extractBearerToken, requireAuthAndBusiness } from "@/lib/billing.server";

const ALLOWED_PLANS = new Set<StripePlan>(["missed_call_recovery", "ai_receptionist"]);
const STRIPE_INTEGRATION_IDENTIFIER = "plumbing_ai_receptionist_vqkhtnra";

export function resolveBillingReturnOrigin(
  request: Request,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const configured = env.PUBLIC_JOB_REQUEST_URL?.trim();
  const url = new URL(configured || request.url);
  const isLocalHttp =
    url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
  if (url.protocol !== "https:" && !isLocalHttp) {
    throw new Error("Billing return URL must use HTTPS");
  }
  return url.origin;
}

export const Route = createFileRoute("/api/public/billing/checkout")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const token = extractBearerToken(request);
        if (!token) {
          return new Response(JSON.stringify({ error: "Unauthorized" }), {
            status: 401,
            headers: { "Content-Type": "application/json" },
          });
        }

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

        let userId: string, businessId: string;
        try {
          ({ userId, businessId } = await requireAuthAndBusiness(token, supabaseAdmin));
        } catch (e) {
          const err = e as { status?: number; message?: string };
          return new Response(JSON.stringify({ error: err.message ?? "Auth failed" }), {
            status: err.status ?? 401,
            headers: { "Content-Type": "application/json" },
          });
        }

        // Load billing row — source of truth for plan and subscription state.
        const { data: billingData, error: billingErr } = await supabaseAdmin
          .from("business_billing")
          .select(
            "selected_plan, billing_status, stripe_customer_id, stripe_subscription_id, union_offer_eligible, union_offer_redeemed_at",
          )
          .eq("business_id", businessId)
          .maybeSingle();

        if (billingErr) {
          return new Response(JSON.stringify({ error: "Billing lookup failed" }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
        }

        const billing = billingData as {
          selected_plan?: string | null;
          billing_status?: string;
          stripe_customer_id?: string | null;
          stripe_subscription_id?: string | null;
          union_offer_eligible?: boolean;
          union_offer_redeemed_at?: string | null;
        } | null;

        // Server selects the plan from DB — client cannot inject a plan.
        const plan = (billing?.selected_plan ?? null) as StripePlan | null;
        if (!plan || !ALLOWED_PLANS.has(plan)) {
          return new Response(
            JSON.stringify({ error: "No valid plan selected. Complete onboarding first." }),
            {
              status: 400,
              headers: { "Content-Type": "application/json" },
            },
          );
        }

        // Guard: already subscribed — do not create duplicate checkout.
        if (billing?.stripe_subscription_id) {
          return new Response(
            JSON.stringify({ error: "Already subscribed", code: "already_subscribed" }),
            {
              status: 409,
              headers: { "Content-Type": "application/json" },
            },
          );
        }

        const stripe = getStripe();
        const origin = resolveBillingReturnOrigin(request);

        // Reuse existing Stripe customer or create one.
        let customerId = billing?.stripe_customer_id ?? undefined;
        const isFirstCheckout = !customerId && (billing?.billing_status ?? "setup") === "setup";

        if (!customerId) {
          const { data: bizData } = await supabaseAdmin
            .from("businesses")
            .select("name")
            .eq("id", businessId)
            .maybeSingle();
          const bizName = (bizData as { name?: string } | null)?.name;

          const { data: userRow } = await supabaseAdmin.auth.admin.getUserById(userId);
          const email = userRow?.user?.email;

          const customer = await stripe.customers.create({
            email: email ?? undefined,
            name: bizName ?? undefined,
            metadata: { business_id: businessId, plan },
          });
          customerId = customer.id;

          // Persist customer ID immediately so retries reuse the same customer.
          const { error: customerPersistError } = await supabaseAdmin
            .from("business_billing")
            .update({
              stripe_customer_id: customerId,
              billing_status: "checkout_pending",
            })
            .eq("business_id", businessId);
          if (customerPersistError) {
            return new Response(
              JSON.stringify({
                error: "Could not save billing setup. No checkout session was created.",
                code: "billing_persistence_failed",
              }),
              {
                status: 500,
                headers: { "Content-Type": "application/json" },
              },
            );
          }
        }

        // Union offer: apply a Stripe coupon that discounts the first month's base
        // platform fee to $0. The coupon must be pre-configured in Stripe with:
        //   - percent_off: 100, duration: 'once'
        //   - applies_to: { products: [MCR_BASE_PRODUCT_ID, AIR_BASE_PRODUCT_ID] }
        //
        // REQUIRED STRIPE PRODUCT STRUCTURE:
        //   prod_MCR_BASE  — Missed Call Recovery Base     → in applies_to
        //   prod_AIR_BASE  — AI Receptionist Base          → in applies_to
        //   prod_AIR_USAGE — AI Receptionist Voice Usage   → SEPARATE product, NOT in applies_to
        //
        // Stripe product-scoped coupons apply at Product level. AI Receptionist Voice
        // Usage must be on a separate product that is omitted from applies_to — that
        // is the structural guarantee usage is never discounted. duration:'once' adds a
        // secondary constraint (first invoice only) but does not substitute for the
        // product-level separation.
        //
        // payment_method_collection:'always' ensures a card is saved even when
        // the first invoice total is $0 (required for future usage billing).
        //
        // Guard: only on the very first checkout (setup → checkout_pending transition)
        // to prevent applying the discount on retry sessions.
        const unionEligible = billing?.union_offer_eligible === true;
        const unionNotRedeemed = !billing?.union_offer_redeemed_at;
        let checkoutDiscounts: Stripe.Checkout.SessionCreateParams.Discount[] | undefined;
        if (unionEligible && unionNotRedeemed && isFirstCheckout) {
          const couponId = getUnionCouponId();
          if (!couponId) {
            return new Response(
              JSON.stringify({
                error:
                  "Union offer is not configured — set STRIPE_COUPON_UNION_FIRST_PLATFORM_FEE in environment variables",
                code: "union_coupon_not_configured",
              }),
              { status: 500, headers: { "Content-Type": "application/json" } },
            );
          }
          checkoutDiscounts = [{ coupon: couponId }];
        }

        const session = await stripe.checkout.sessions.create({
          integration_identifier: STRIPE_INTEGRATION_IDENTIFIER,
          customer: customerId,
          mode: "subscription",
          payment_method_collection: "always",
          line_items: getCheckoutLineItems(plan),
          ...(checkoutDiscounts ? { discounts: checkoutDiscounts } : {}),
          subscription_data: {
            metadata: { business_id: businessId, plan },
          },
          customer_update: { address: "auto" },
          tax_id_collection: { enabled: false },
          success_url: `${origin}/dashboard?billing=success&session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${origin}/dashboard?billing=cancelled`,
          metadata: { business_id: businessId, plan },
        });

        return new Response(JSON.stringify({ url: session.url }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    },
  },
});
