import { appendFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import Stripe from "stripe";

const STRIPE_API_VERSION = "2026-06-24.dahlia";
const INCLUSIVE_TAX_RATE_SECRET = "STRIPE_GST_INCLUSIVE_TAX_RATE_ID";
const TAX_POLICY_VERSION = "australian-gst-inclusive-v1";

function required(env, name) {
  const value = env[name]?.trim();
  if (!value) throw new Error(`Missing required staging GST variable: ${name}`);
  return value;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function runGh(args, { input, token, repository }) {
  const result = spawnSync("gh", [...args, "--repo", repository], {
    encoding: "utf8",
    input,
    env: { ...process.env, GH_TOKEN: token },
  });
  if (result.status !== 0) throw new Error("GitHub staging GST secret update failed");
}

function publishTaxRateOutput(taxRateId, env) {
  assert(/^txr_[A-Za-z0-9]+$/.test(taxRateId), "Inclusive GST Tax Rate ID is invalid");
  if (env.GITHUB_OUTPUT) {
    process.stdout.write(`::add-mask::${taxRateId}\n`);
    appendFileSync(env.GITHUB_OUTPUT, `tax_rate_id=${taxRateId}\n`, "utf8");
  }
}

export function validateInclusiveGstResources({ prices, taxRate }) {
  const mcrBase = prices.MCR_BASE;
  const airBase = prices.AIR_BASE;
  const airUsage = prices.AIR_USAGE;
  for (const [name, price] of Object.entries(prices)) {
    assert(price?.object === "price", `${name} is not a Stripe Price`);
    assert(price.livemode === false, `${name} must be test-mode`);
    assert(price.active === true, `${name} must be active`);
    assert(price.currency === "aud", `${name} must use AUD`);
    assert(price.tax_behavior === "inclusive", `${name} must include GST in its displayed total`);
  }
  assert(mcrBase.unit_amount === 900, "Missed-Call Recovery must remain A$9.00 including GST");
  assert(airBase.unit_amount === 1500, "AI Receptionist must remain A$15.00 including GST");
  const aiUsageCentsPerSecond = Number(airUsage.unit_amount_decimal);
  assert(
    Number.isFinite(aiUsageCentsPerSecond) &&
      Math.abs(aiUsageCentsPerSecond - 0.983333) <= 0.000001,
    "AI usage must remain A$0.59/minute including GST at the configured precision",
  );
  assert(taxRate?.object === "tax_rate", "Inclusive Australian GST is not a Stripe Tax Rate");
  assert(taxRate.livemode === false, "Inclusive Australian GST Tax Rate must be test-mode");
  assert(taxRate.active === true, "Inclusive Australian GST Tax Rate must be active");
  assert(taxRate.inclusive === true, "Australian subscription GST must be inclusive");
  assert(Number(taxRate.percentage) === 10, "Australian subscription GST must be 10 percent");
  assert(taxRate.country === "AU", "Inclusive GST Tax Rate must be restricted to Australia");
  assert(taxRate.jurisdiction === "AU", "Inclusive GST jurisdiction must be AU");
  return {
    headlineTotalsUnchanged: true,
    platformAndAiTaxBehavior: "inclusive",
    smsTaxBehavior: "exclusive",
    gstRatePercent: 10,
  };
}

function assertMutablePrice(price, name) {
  assert(price.livemode === false, `${name} must be test-mode`);
  assert(price.tax_behavior !== "exclusive", `${name} is already immutable as GST-exclusive`);
}

function matchesApplicationSubscription(subscription, priceIds) {
  if (
    subscription.livemode !== false ||
    subscription.status === "canceled" ||
    subscription.status === "incomplete_expired" ||
    !subscription.metadata?.business_id ||
    !["missed_call_recovery", "ai_receptionist", "both"].includes(subscription.metadata?.plan)
  ) {
    return false;
  }
  const itemPriceIds = subscription.items.data.map((item) => item.price.id);
  return itemPriceIds.length > 0 && itemPriceIds.every((id) => priceIds.includes(id));
}

export async function configureStagingCommercialGst(env = process.env) {
  assert(env.DEPLOYMENT_TARGET === "staging", "Commercial GST configuration is staging-only");
  assert(env.STRIPE_MODE === "test", "Commercial GST configuration requires Stripe test mode");
  const key = required(env, "STRIPE_SECRET_KEY");
  assert(
    /^(?:(?:sk|rk)_test_|sk_org_test_)/.test(key),
    "Commercial GST configuration refuses non-test Stripe keys",
  );
  const stripeContext = env.STRIPE_CONTEXT?.trim() || undefined;
  if (key.startsWith("sk_org_test_") && !stripeContext) {
    throw new Error("STRIPE_CONTEXT is required for an organization test key");
  }
  const stripe = new Stripe(key, {
    apiVersion: STRIPE_API_VERSION,
    ...(stripeContext ? { stripeContext } : {}),
  });
  const priceIds = {
    MCR_BASE: required(env, "STRIPE_PRICE_MCR_BASE"),
    AIR_BASE: required(env, "STRIPE_PRICE_AIR_BASE"),
    AIR_USAGE: required(env, "STRIPE_PRICE_AIR_USAGE"),
  };
  const [account, initialMcr, initialAir, initialUsage] = await Promise.all([
    stripe.accounts.retrieve(),
    stripe.prices.retrieve(priceIds.MCR_BASE),
    stripe.prices.retrieve(priceIds.AIR_BASE),
    stripe.prices.retrieve(priceIds.AIR_USAGE),
  ]);
  assert(account?.object === "account", "Could not verify the staging Stripe account context");

  const configurationToken = env.STAGING_CONFIGURATION_TOKEN?.trim();
  if (!configurationToken) {
    const taxRateId = required(env, INCLUSIVE_TAX_RATE_SECRET);
    const taxRate = await stripe.taxRates.retrieve(taxRateId);
    const prices = { MCR_BASE: initialMcr, AIR_BASE: initialAir, AIR_USAGE: initialUsage };
    validateInclusiveGstResources({ prices, taxRate });
    publishTaxRateOutput(taxRateId, env);
    return {
      configured: false,
      verified: true,
      mode: "test",
      ...validateInclusiveGstResources({ prices, taxRate }),
    };
  }

  for (const [name, price] of Object.entries({
    MCR_BASE: initialMcr,
    AIR_BASE: initialAir,
    AIR_USAGE: initialUsage,
  })) {
    assertMutablePrice(price, name);
    if (price.tax_behavior === "unspecified") {
      await stripe.prices.update(price.id, {
        tax_behavior: "inclusive",
        metadata: { rapid_connect_tax_policy: TAX_POLICY_VERSION },
      });
    }
  }

  const activeTaxRates = await stripe.taxRates.list({ active: true, limit: 100 });
  let taxRate = activeTaxRates.data.find(
    (candidate) =>
      candidate.livemode === false &&
      candidate.inclusive === true &&
      Number(candidate.percentage) === 10 &&
      candidate.country === "AU" &&
      candidate.jurisdiction === "AU" &&
      candidate.metadata?.rapid_connect_tax_policy === TAX_POLICY_VERSION,
  );
  if (!taxRate) {
    taxRate = await stripe.taxRates.create({
      display_name: "GST",
      description: "Australian GST included in Rapid Connect platform and AI prices",
      inclusive: true,
      percentage: 10,
      country: "AU",
      jurisdiction: "AU",
      metadata: { rapid_connect_tax_policy: TAX_POLICY_VERSION },
    });
  }

  const [mcrBase, airBase, airUsage] = await Promise.all([
    stripe.prices.retrieve(priceIds.MCR_BASE),
    stripe.prices.retrieve(priceIds.AIR_BASE),
    stripe.prices.retrieve(priceIds.AIR_USAGE),
  ]);
  const prices = { MCR_BASE: mcrBase, AIR_BASE: airBase, AIR_USAGE: airUsage };
  const verification = validateInclusiveGstResources({ prices, taxRate });

  const subscriptions = await stripe.subscriptions
    .list({ status: "all", limit: 100 })
    .autoPagingToArray({ limit: 1_000 });
  const applicationPriceIds = Object.values(priceIds);
  const matchingSubscriptions = subscriptions.filter((subscription) =>
    matchesApplicationSubscription(subscription, applicationPriceIds),
  );
  for (const subscription of matchingSubscriptions) {
    await stripe.subscriptions.update(
      subscription.id,
      { default_tax_rates: [taxRate.id], proration_behavior: "none" },
      { idempotencyKey: `rapid-connect-inclusive-gst:${subscription.id}:v1` },
    );
  }

  runGh(["secret", "set", INCLUSIVE_TAX_RATE_SECRET, "--env", "staging"], {
    input: taxRate.id,
    token: configurationToken,
    repository: required(env, "GITHUB_REPOSITORY"),
  });
  publishTaxRateOutput(taxRate.id, env);
  return {
    configured: true,
    verified: true,
    mode: "test",
    existingTestSubscriptionsUpdatedWithoutProration: matchingSubscriptions.length,
    ...verification,
  };
}

const isDirect = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirect) {
  configureStagingCommercialGst()
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
