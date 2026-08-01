import { createClient } from "@supabase/supabase-js";
import Stripe from "stripe";

const routes = [
  "/dashboard",
  "/leads",
  "/call-handling",
  "/ai-receptionist",
  "/billing",
  "/usage",
  "/settings",
  "/setup-guide",
  "/account",
  "/onboarding",
];

function required(env, name) {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function jsonResponse(response, label) {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${label} returned HTTP ${response.status}`);
  return payload;
}

export async function runAuthenticatedCheckoutSmoke(env = process.env) {
  if (env.DEPLOYMENT_TARGET !== "staging" || env.STRIPE_MODE !== "test") {
    throw new Error("Authenticated checkout smoke is restricted to staging test mode");
  }
  const baseUrl = new URL(required(env, "CERTIFICATION_BASE_URL"));
  if (baseUrl.protocol !== "https:" || !baseUrl.hostname.includes("staging")) {
    throw new Error("CERTIFICATION_BASE_URL must be an HTTPS staging origin");
  }
  const supabaseUrl = required(env, "STAGING_SUPABASE_URL");
  const serviceRoleKey = required(env, "STAGING_SUPABASE_SERVICE_ROLE_KEY");
  const publishableKey = required(env, "STAGING_SUPABASE_PUBLISHABLE_KEY");
  const stripeKey = required(env, "STRIPE_SECRET_KEY");
  if (!stripeKey.startsWith("sk_test_")) throw new Error("A Stripe test secret key is required");

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const stripe = new Stripe(stripeKey, { apiVersion: "2026-06-24.dahlia" });
  const { data: businesses, error: businessError } = await admin
    .from("businesses")
    .select("id,owner_user_id,promotion_code,setup_fee_waived_cents")
    .eq("active", true)
    .eq("promotion_code", "FOUNDINGPLUMBER");
  if (businessError || !businesses?.length) throw new Error("Recovered staging business not found");

  const businessIds = businesses.map((business) => business.id);
  const { data: billingRows, error: billingError } = await admin
    .from("business_billing")
    .select("business_id,selected_plan,stripe_customer_id")
    .in("business_id", businessIds)
    .eq("selected_plan", "missed_call_recovery")
    .not("stripe_customer_id", "is", null);
  if (billingError || !billingRows?.length) throw new Error("Recovered billing record not found");

  const matches = [];
  for (const billing of billingRows) {
    const sessions = await stripe.checkout.sessions.list({
      customer: billing.stripe_customer_id,
      limit: 20,
    });
    const session = sessions.data.find(
      (candidate) =>
        !candidate.livemode &&
        candidate.mode === "subscription" &&
        candidate.status === "complete" &&
        (candidate.payment_status === "paid" ||
          candidate.payment_status === "no_payment_required") &&
        candidate.metadata?.business_id === billing.business_id &&
        candidate.metadata?.plan === "missed_call_recovery",
    );
    if (session) matches.push({ billing, session });
  }
  if (matches.length !== 1) {
    throw new Error(`Expected one recovered paid checkout; found ${matches.length}`);
  }

  const { billing, session } = matches[0];
  const business = businesses.find((candidate) => candidate.id === billing.business_id);
  if (!business?.owner_user_id || Number(business.setup_fee_waived_cents) !== 49900) {
    throw new Error("Recovered FOUNDINGPLUMBER ownership or waiver is invalid");
  }
  const { data: userData, error: userError } = await admin.auth.admin.getUserById(
    business.owner_user_id,
  );
  if (userError || !userData.user?.email) throw new Error("Recovered owner account not found");

  // Generate a short-lived, unsent staging magic link and exchange it in memory.
  // This proves the same authenticated boundary without changing the user's password.
  const { data: linkData, error: linkError } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email: userData.user.email,
  });
  const tokenHash = linkData?.properties?.hashed_token;
  if (linkError || !tokenHash) throw new Error("Could not create staging smoke session");
  const userClient = createClient(supabaseUrl, publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: sessionData, error: sessionError } = await userClient.auth.verifyOtp({
    token_hash: tokenHash,
    type: "magiclink",
  });
  const accessToken = sessionData.session?.access_token;
  if (sessionError || !accessToken)
    throw new Error("Could not authenticate recovered staging owner");
  const headers = { Authorization: `Bearer ${accessToken}` };

  const checkoutResult = await jsonResponse(
    await fetch(new URL("/api/public/billing/checkout-status", baseUrl), {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: session.id }),
    }),
    "Authenticated checkout return",
  );
  if (
    checkoutResult.verified !== true ||
    checkoutResult.status !== "active" ||
    checkoutResult.billingStatus !== "active" ||
    checkoutResult.plan !== "missed_call_recovery" ||
    checkoutResult.monthlyPriceAud !== 9 ||
    typeof checkoutResult.foundingBenefit !== "string"
  ) {
    throw new Error("Authenticated checkout return was not verified as the expected active plan");
  }

  const routeResults = [];
  for (const path of routes) {
    const response = await fetch(new URL(path, baseUrl), { headers, redirect: "manual" });
    if (response.status !== 200) throw new Error(`${path} returned HTTP ${response.status}`);
    routeResults.push({ path, status: response.status });
  }
  const summary = await jsonResponse(
    await fetch(new URL("/api/public/billing/summary", baseUrl), { headers }),
    "Account & Billing summary",
  );
  if (
    summary.billing?.billingStatus !== "active" ||
    summary.billing?.effectiveState !== "active" ||
    summary.billing?.hasStripeSubscription !== true
  ) {
    throw new Error("Account & Billing did not report an active subscription");
  }

  return {
    authenticated: true,
    checkoutVerified: true,
    plan: checkoutResult.plan,
    monthlyPriceAud: checkoutResult.monthlyPriceAud,
    foundingBenefit: true,
    billingStatus: summary.billing.billingStatus,
    effectiveState: summary.billing.effectiveState,
    routeResults,
  };
}

runAuthenticatedCheckoutSmoke()
  .then((result) => console.log(JSON.stringify(result)))
  .catch((error) => {
    console.error(error instanceof Error ? error.message : "Authenticated checkout smoke failed");
    process.exitCode = 1;
  });
