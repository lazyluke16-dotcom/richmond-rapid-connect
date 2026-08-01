import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import Stripe from "stripe";

function required(env, name) {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export async function runNewAccountCheckoutSmoke(env = process.env) {
  if (env.DEPLOYMENT_TARGET !== "staging" || env.STRIPE_MODE !== "test") {
    throw new Error("New-account checkout smoke is restricted to staging test mode");
  }
  const baseUrl = new URL(required(env, "CERTIFICATION_BASE_URL"));
  if (baseUrl.protocol !== "https:" || !baseUrl.hostname.includes("staging")) {
    throw new Error("CERTIFICATION_BASE_URL must be an HTTPS staging origin");
  }
  const supabaseUrl = required(env, "STAGING_SUPABASE_URL");
  const admin = createClient(supabaseUrl, required(env, "STAGING_SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const userClient = createClient(supabaseUrl, required(env, "STAGING_SUPABASE_PUBLISHABLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const stripeKey = required(env, "STRIPE_SECRET_KEY");
  if (!/^(?:sk|rk)_test_|^sk_org_test_/.test(stripeKey)) {
    throw new Error("A Stripe test key is required");
  }
  const stripeContext = env.STRIPE_CONTEXT?.trim() || undefined;
  const stripe = new Stripe(stripeKey, {
    apiVersion: "2026-06-24.dahlia",
    ...(stripeContext ? { stripeContext } : {}),
  });

  const suffix = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  const email = `rapid-connect-cert-${suffix}@example.invalid`;
  let userId;
  let businessId;
  let customerId;
  let checkoutSessionId;
  try {
    const { data: created, error: createError } = await admin.auth.admin.createUser({
      email,
      email_confirm: true,
      password: `${randomUUID()}Aa1!`,
      user_metadata: {
        first_name: "Staging",
        last_name: "Certification",
        business_name: `Rapid Connect certification ${suffix}`,
        business_phone_e164: "+61400000000",
        contact_mobile_e164: "+61400000000",
        acquisition_plan: "missed_call_recovery",
        acquisition_pricing_mode: "offer",
        acquisition_promo_code: "FOUNDINGPLUMBER",
        acquisition_source: "guarded_staging_certification",
        business_contact_email: email,
        services_offered: "Emergency plumbing, blocked drains and hot water",
        service_area: "Richmond VIC",
        business_hours: "Mon-Fri 08:00-17:00",
        acquisition_demo_variant: "demo-real-world-v2",
      },
    });
    if (createError || !created.user) throw new Error("Could not create isolated staging identity");
    userId = created.user.id;

    // Generate an unsent, short-lived link and exchange it through the same
    // Supabase token-hash API used by the confirmation recovery path.
    const { data: link, error: linkError } = await admin.auth.admin.generateLink({
      type: "magiclink",
      email,
    });
    const tokenHash = link?.properties?.hashed_token;
    if (linkError || !tokenHash) throw new Error("Could not generate isolated staging session");
    const { data: verified, error: verifyError } = await userClient.auth.verifyOtp({
      token_hash: tokenHash,
      type: "magiclink",
    });
    const accessToken = verified.session?.access_token;
    if (verifyError || !accessToken)
      throw new Error("Could not establish isolated staging session");

    const response = await fetch(new URL("/api/public/billing/checkout", baseUrl), {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const responseText = await response.text();
    const payload = (() => {
      try {
        return JSON.parse(responseText);
      } catch {
        return {};
      }
    })();
    if (!response.ok || typeof payload.url !== "string") {
      const code = typeof payload.code === "string" ? payload.code : "unknown_checkout_failure";
      const requestId =
        typeof payload.requestId === "string" ? payload.requestId : "no-correlation-id";
      const contentType = response.headers.get("content-type")?.split(";")[0] || "absent";
      const cloudflareRay = response.headers.get("cf-ray")?.split("-")[0] || "absent";
      throw new Error(
        `Authenticated checkout failed safely: ${code} (${requestId}); HTTP ${response.status}; content-type ${contentType}; cf-ray ${cloudflareRay}`,
      );
    }
    const checkoutUrl = new URL(payload.url);
    if (checkoutUrl.protocol !== "https:" || checkoutUrl.hostname !== "checkout.stripe.com") {
      throw new Error("Authenticated endpoint did not return a Stripe-hosted Checkout URL");
    }

    const { data: business, error: businessError } = await admin
      .from("businesses")
      .select("id,promotion_code,setup_fee_waived_cents")
      .eq("owner_user_id", userId)
      .single();
    if (businessError || business?.promotion_code !== "FOUNDINGPLUMBER") {
      throw new Error("Recovered tenant did not retain the founding offer");
    }
    businessId = business.id;
    if (Number(business.setup_fee_waived_cents) !== 49_900) {
      throw new Error("Recovered tenant did not retain the A$499 waiver");
    }
    const { data: billing, error: billingError } = await admin
      .from("business_billing")
      .select("stripe_customer_id,selected_plan,billing_status")
      .eq("business_id", businessId)
      .single();
    if (billingError || billing?.selected_plan !== "missed_call_recovery") {
      throw new Error("Recovered billing ownership or plan is invalid");
    }
    customerId = billing.stripe_customer_id;
    const sessions = await stripe.checkout.sessions.list({ customer: customerId, limit: 10 });
    const checkout = sessions.data.find(
      (candidate) =>
        candidate.livemode === false &&
        candidate.mode === "subscription" &&
        candidate.status === "open" &&
        candidate.metadata?.business_id === businessId,
    );
    if (!checkout) throw new Error("No tenant-owned Stripe test Checkout Session was found");
    checkoutSessionId = checkout.id;

    return {
      authenticated: true,
      newIdentity: true,
      tenantRecovered: true,
      foundingOfferPreserved: true,
      checkoutEndpointReturnedStripeTestUrl: true,
      noSubscriptionCreated: true,
    };
  } finally {
    if (userId && !businessId) {
      const { data: recoveredBusiness } = await admin
        .from("businesses")
        .select("id")
        .eq("owner_user_id", userId)
        .maybeSingle();
      businessId = recoveredBusiness?.id;
    }
    if (businessId && !customerId) {
      const { data: recoveredBilling } = await admin
        .from("business_billing")
        .select("stripe_customer_id")
        .eq("business_id", businessId)
        .maybeSingle();
      customerId = recoveredBilling?.stripe_customer_id;
    }
    if (customerId && !checkoutSessionId) {
      const sessions = await stripe.checkout.sessions.list({ customer: customerId, limit: 10 });
      checkoutSessionId = sessions.data.find((candidate) => candidate.status === "open")?.id;
    }
    if (checkoutSessionId) await stripe.checkout.sessions.expire(checkoutSessionId).catch(() => {});
    if (customerId) await stripe.customers.del(customerId).catch(() => {});
    if (businessId) await admin.from("businesses").delete().eq("id", businessId);
    if (userId) await admin.auth.admin.deleteUser(userId);
  }
}

runNewAccountCheckoutSmoke()
  .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
  .catch((error) => {
    console.error(error instanceof Error ? error.message : "New-account checkout smoke failed");
    process.exitCode = 1;
  });
