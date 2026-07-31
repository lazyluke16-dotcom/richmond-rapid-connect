import { pathToFileURL } from "node:url";

import Stripe from "stripe";

const STRIPE_API_VERSION = "2026-06-24.dahlia";

function required(env, name) {
  const value = env[name]?.trim();
  if (!value) throw new Error(`Missing required staging Stripe variable: ${name}`);
  return value;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sorted(values) {
  return [...new Set(values)].sort();
}

export function validateStripeCheckoutResources({ account, prices, coupon }) {
  const mcrBase = prices.MCR_BASE;
  const airBase = prices.AIR_BASE;
  const airUsage = prices.AIR_USAGE;

  for (const [name, price] of Object.entries(prices)) {
    assert(price && price.object === "price", `${name} is not a Stripe Price`);
    assert(price.livemode === false, `${name} must be a test-mode Price`);
    assert(price.active === true, `${name} must be active`);
    assert(price.currency === "aud", `${name} must use AUD`);
    assert(price.recurring?.interval === "month", `${name} must recur monthly`);
  }
  assert(mcrBase.unit_amount === 900, "STRIPE_PRICE_MCR_BASE must be A$9.00");
  assert(mcrBase.recurring?.usage_type === "licensed", "MCR base must be licensed");
  assert(airBase.unit_amount === 1500, "STRIPE_PRICE_AIR_BASE must be A$15.00");
  assert(airBase.recurring?.usage_type === "licensed", "AI base must be licensed");
  assert(airUsage.recurring?.usage_type === "metered", "AI usage must be metered");
  assert(
    new Set([mcrBase.product, airBase.product, airUsage.product]).size === 3,
    "Base and usage Prices must use three separate Stripe Products",
  );

  assert(coupon?.object === "coupon", "Union waiver is not a Stripe Coupon");
  assert(coupon.livemode === false, "Union waiver Coupon must be test-mode");
  assert(coupon.valid === true, "Union waiver Coupon must be valid");
  assert(coupon.percent_off === 100, "Union waiver Coupon must be 100 percent off");
  assert(coupon.duration === "once", "Union waiver Coupon must apply once");
  const expectedProducts = sorted([mcrBase.product, airBase.product]);
  const scopedProducts = sorted(coupon.applies_to?.products ?? []);
  assert(
    JSON.stringify(scopedProducts) === JSON.stringify(expectedProducts),
    "Union waiver Coupon must apply only to both base Products",
  );
  assert(!scopedProducts.includes(airUsage.product), "Union waiver Coupon must exclude AI usage");

  return {
    mode: "test",
    accountId: account.id,
    priceCount: Object.keys(prices).length,
    couponScopedToBaseProducts: true,
  };
}

export async function verifyStripeCheckoutConfig(env = process.env) {
  const key = required(env, "STRIPE_SECRET_KEY");
  assert(
    /^(?:(?:sk|rk)_test_|sk_org_test_)/.test(key),
    "Staging Stripe verification requires a test-mode key",
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
  const couponId = required(env, "STRIPE_COUPON_UNION_FIRST_PLATFORM_FEE");
  const [account, mcrBase, airBase, airUsage, coupon] = await Promise.all([
    stripe.accounts.retrieve(),
    stripe.prices.retrieve(priceIds.MCR_BASE),
    stripe.prices.retrieve(priceIds.AIR_BASE),
    stripe.prices.retrieve(priceIds.AIR_USAGE),
    stripe.coupons.retrieve(couponId, { expand: ["applies_to"] }),
  ]);

  return validateStripeCheckoutResources({
    account,
    prices: { MCR_BASE: mcrBase, AIR_BASE: airBase, AIR_USAGE: airUsage },
    coupon,
  });
}

const isDirect = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirect) {
  verifyStripeCheckoutConfig()
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
