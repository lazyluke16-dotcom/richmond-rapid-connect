import { createFileRoute } from "@tanstack/react-router";
import {
  getStripe,
  getCheckoutLineItems,
  getFoundingThreeMonthCouponId,
  getInclusiveGstTaxRateId,
  getUnionCouponId,
  type StripePlan,
} from "@/lib/stripe.server";
import type Stripe from "stripe";
import { extractBearerToken, requireAuthAndBusiness } from "@/lib/billing.server";

const ALLOWED_PLANS = new Set<StripePlan>(["missed_call_recovery", "ai_receptionist", "both"]);
const STRIPE_INTEGRATION_IDENTIFIER = "plumbing_ai_receptionist_vqkhtnra";
const JSON_HEADERS = { "Content-Type": "application/json" };

type BillingCheckoutFailure = {
  status: number;
  code:
    | "stripe_secret_not_configured"
    | "stripe_secret_invalid"
    | "stripe_context_not_configured"
    | "stripe_mode_invalid"
    | "stripe_mode_mismatch"
    | "stripe_prices_not_configured"
    | "stripe_tax_not_configured"
    | "billing_return_url_invalid"
    | "stripe_request_failed"
    | "billing_checkout_failed";
  error: string;
};

function errorRecord(error: unknown): Record<string, unknown> {
  return typeof error === "object" && error !== null ? (error as Record<string, unknown>) : {};
}

export function classifyBillingCheckoutFailure(error: unknown): BillingCheckoutFailure {
  const record = errorRecord(error);
  const message = error instanceof Error ? error.message : "";
  const name = error instanceof Error ? error.name : "";
  const providerType = typeof record.type === "string" ? record.type : "";

  const configurationCode = (() => {
    if (message.includes("STRIPE_SECRET_KEY is not configured")) {
      return "stripe_secret_not_configured" as const;
    }
    if (message.includes("STRIPE_SECRET_KEY must be a Stripe")) {
      return "stripe_secret_invalid" as const;
    }
    if (message.includes("STRIPE_CONTEXT is required")) {
      return "stripe_context_not_configured" as const;
    }
    if (message.includes('STRIPE_MODE must be either "test" or "live"')) {
      return "stripe_mode_invalid" as const;
    }
    if (message.includes("does not match the configured")) {
      return "stripe_mode_mismatch" as const;
    }
    if (message.includes("Missing required Stripe price configuration")) {
      return "stripe_prices_not_configured" as const;
    }
    if (
      message.includes("Missing required Stripe tax configuration") ||
      message.includes("STRIPE_GST_INCLUSIVE_TAX_RATE_ID is invalid")
    ) {
      return "stripe_tax_not_configured" as const;
    }
    if (message === "Billing return URL must use HTTPS") {
      return "billing_return_url_invalid" as const;
    }
    return null;
  })();
  if (configurationCode) {
    return {
      status: 503,
      code: configurationCode,
      error: "Billing is temporarily unavailable. Please try again shortly.",
    };
  }

  const isStripeFailure =
    name.startsWith("Stripe") || providerType.startsWith("Stripe") || "requestId" in record;
  if (isStripeFailure) {
    return {
      status: 502,
      code: "stripe_request_failed",
      error: "Stripe could not start checkout. Please try again.",
    };
  }

  return {
    status: 500,
    code: "billing_checkout_failed",
    error: "Billing checkout could not be started. Please try again.",
  };
}

export function billingCheckoutErrorResponse(error: unknown): Response {
  const failure = classifyBillingCheckoutFailure(error);
  const record = errorRecord(error);
  console.error("[billing.checkout] request failed", {
    code: failure.code,
    errorName: error instanceof Error ? error.name : "UnknownError",
    providerCode: typeof record.code === "string" ? record.code : undefined,
    requestId: typeof record.requestId === "string" ? record.requestId : undefined,
  });
  return new Response(JSON.stringify({ error: failure.error, code: failure.code }), {
    status: failure.status,
    headers: JSON_HEADERS,
  });
}

export function checkoutIdempotencyKeys(
  businessId: string,
  plan: StripePlan,
  couponId: string | null,
  taxPolicy = "gst-inclusive-v1",
): { customer: string; session: string } {
  const tenantPlan = `${businessId}:${plan}`;
  return {
    customer: `billing-checkout:customer:${tenantPlan}`,
    session: `billing-checkout:session:${tenantPlan}:${couponId ?? "standard"}:${taxPolicy}`,
  };
}

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
        try {
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
              "selected_plan, billing_status, stripe_customer_id, stripe_subscription_id, union_offer_eligible, union_offer_redeemed_at, founding_offer_version, founding_offer_eligible, founding_offer_redeemed_at",
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
            founding_offer_version?: string | null;
            founding_offer_eligible?: boolean;
            founding_offer_redeemed_at?: string | null;
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

          // Verify any setup-fee waiver before making the first Stripe write.
          // A database/schema failure must not leave an orphaned Stripe customer.
          const { data: acquisitionData, error: acquisitionError } = await supabaseAdmin
            .from("businesses")
            .select("promotion_code, setup_fee_waived_cents, acquisition_demo_variant")
            .eq("id", businessId)
            .maybeSingle();
          if (acquisitionError) {
            return new Response(
              JSON.stringify({
                error: "Could not verify setup-fee status. No checkout session was created.",
                code: "setup_fee_verification_failed",
              }),
              { status: 500, headers: { "Content-Type": "application/json" } },
            );
          }
          const acquisition = acquisitionData as {
            promotion_code?: string | null;
            setup_fee_waived_cents?: number | null;
            acquisition_demo_variant?: string | null;
          } | null;
          const acquisitionMetadata: Record<string, string> =
            acquisition?.promotion_code && acquisition.setup_fee_waived_cents != null
              ? {
                  promotion_code: acquisition.promotion_code,
                  setup_fee_waived_cents: String(acquisition.setup_fee_waived_cents),
                  ...(acquisition.acquisition_demo_variant
                    ? { demo_variant: acquisition.acquisition_demo_variant }
                    : {}),
                }
              : {};

          // Resolve the discount and all Stripe configuration before the first
          // provider write. A retry after a partial failure must keep the waiver.
          const shouldApplyFoundingOffer =
            billing?.founding_offer_version === "founding-2026-three-months" &&
            billing?.founding_offer_eligible === true &&
            !billing?.founding_offer_redeemed_at;
          const shouldApplyUnionOffer =
            !shouldApplyFoundingOffer &&
            billing?.union_offer_eligible === true &&
            !billing?.union_offer_redeemed_at;
          const couponId = shouldApplyFoundingOffer
            ? getFoundingThreeMonthCouponId()
            : shouldApplyUnionOffer
              ? getUnionCouponId()
              : null;
          if (shouldApplyFoundingOffer && !couponId) {
            return new Response(
              JSON.stringify({
                error: "Billing is temporarily unavailable. Please try again shortly.",
                code: "founding_coupon_not_configured",
              }),
              { status: 503, headers: JSON_HEADERS },
            );
          }
          if (shouldApplyUnionOffer && !couponId) {
            return new Response(
              JSON.stringify({
                error: "Billing is temporarily unavailable. Please try again shortly.",
                code: "union_coupon_not_configured",
              }),
              { status: 503, headers: JSON_HEADERS },
            );
          }
          const checkoutDiscounts: Stripe.Checkout.SessionCreateParams.Discount[] | undefined =
            couponId ? [{ coupon: couponId }] : undefined;
          const inclusiveGstTaxRateId = getInclusiveGstTaxRateId();
          const idempotencyKeys = checkoutIdempotencyKeys(
            businessId,
            plan,
            couponId,
            "gst-inclusive-v1",
          );
          const stripe = getStripe();
          const origin = resolveBillingReturnOrigin(request);

          // Reuse existing Stripe customer or create one.
          let customerId = billing?.stripe_customer_id ?? undefined;
          if (!customerId) {
            const { data: bizData } = await supabaseAdmin
              .from("businesses")
              .select("name")
              .eq("id", businessId)
              .maybeSingle();
            const bizName = (bizData as { name?: string } | null)?.name;

            const { data: userRow } = await supabaseAdmin.auth.admin.getUserById(userId);
            const email = userRow?.user?.email;

            const customer = await stripe.customers.create(
              {
                email: email ?? undefined,
                name: bizName ?? undefined,
                metadata: { business_id: businessId, plan },
              },
              { idempotencyKey: idempotencyKeys.customer },
            );
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

          // Founding offer: a test-mode, product-scoped repeating coupon discounts
          // exactly three monthly platform invoices. Union accounts retain their
          // separate one-invoice coupon. Neither coupon includes usage products.
          //
          // REQUIRED STRIPE PRODUCT STRUCTURE:
          //   prod_MCR_BASE  — Missed Call Recovery Base     → in applies_to
          //   prod_AIR_BASE  — AI Receptionist Base          → in applies_to
          //   prod_AIR_USAGE — AI Receptionist Voice Usage   → SEPARATE product, NOT in applies_to
          //
          // Stripe product-scoped coupons apply at Product level. AI Receptionist Voice
          // Usage must be on a separate product that is omitted from applies_to — that
          // is the structural guarantee usage is charged from activation.
          //
          // payment_method_collection:'always' ensures a card is saved even when
          // the first invoice total is $0 (required for future usage billing).
          //
          const session = await stripe.checkout.sessions.create(
            {
              integration_identifier: STRIPE_INTEGRATION_IDENTIFIER,
              customer: customerId,
              mode: "subscription",
              payment_method_collection: "always",
              line_items: getCheckoutLineItems(plan),
              ...(checkoutDiscounts ? { discounts: checkoutDiscounts } : {}),
              // The configured Price totals already include GST. This explicit manual tax policy
              // lets Stripe identify the embedded 10% without adding another 10% at Checkout.
              automatic_tax: { enabled: false },
              subscription_data: {
                default_tax_rates: [inclusiveGstTaxRateId],
                metadata: {
                  business_id: businessId,
                  plan,
                  offer_version: shouldApplyFoundingOffer
                    ? "founding-2026-three-months"
                    : shouldApplyUnionOffer
                      ? "union-first-platform-fee"
                      : "standard",
                  ...acquisitionMetadata,
                },
              },
              customer_update: { address: "auto" },
              tax_id_collection: { enabled: false },
              success_url: `${origin}/dashboard?billing=success&session_id={CHECKOUT_SESSION_ID}`,
              cancel_url: `${origin}/plumbers?resume=payment&billing=cancelled`,
              metadata: {
                business_id: businessId,
                plan,
                offer_version: shouldApplyFoundingOffer
                  ? "founding-2026-three-months"
                  : shouldApplyUnionOffer
                    ? "union-first-platform-fee"
                    : "standard",
                ...acquisitionMetadata,
              },
            },
            { idempotencyKey: idempotencyKeys.session },
          );

          return new Response(JSON.stringify({ url: session.url }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        } catch (error) {
          return billingCheckoutErrorResponse(error);
        }
      },
    },
  },
});
