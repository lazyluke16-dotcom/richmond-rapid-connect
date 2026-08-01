import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import Stripe from "stripe";

const STRIPE_API_VERSION = "2026-06-24.dahlia";
const COUPON_ID = "foundingplumber_three_month_platform_fees_test_v1";
const COUPON_SECRET_NAME = "STRIPE_COUPON_FOUNDING_THREE_MONTH_PLATFORM_FEES";
const CONFIGURATION_TOKEN_NAME = "STAGING_CONFIGURATION_TOKEN";

function required(env, name) {
  const value = env[name]?.trim();
  if (!value) throw new Error(`Missing required configuration variable: ${name}`);
  return value;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sorted(values) {
  return [...new Set(values)].sort();
}

export function validateFoundingCoupon({ coupon, prices }) {
  const mcrBase = prices.MCR_BASE;
  const airBase = prices.AIR_BASE;
  const airUsage = prices.AIR_USAGE;

  for (const [name, price] of Object.entries(prices)) {
    assert(price?.object === "price", `${name} is not a Stripe Price`);
    assert(price.livemode === false, `${name} must be test-mode`);
    assert(price.active === true, `${name} must be active`);
    assert(price.currency === "aud", `${name} must use AUD`);
    assert(price.recurring?.interval === "month", `${name} must recur monthly`);
    assert(price.tax_behavior === "inclusive", `${name} must include GST in its Stripe total`);
  }

  assert(mcrBase.unit_amount === 900, "Missed-Call Recovery must be A$9.00 per month");
  assert(mcrBase.recurring?.usage_type === "licensed", "MCR base must be licensed");
  assert(airBase.unit_amount === 1500, "AI Receptionist must be A$15.00 per month");
  assert(airBase.recurring?.usage_type === "licensed", "AI base must be licensed");
  assert(airUsage.recurring?.usage_type === "metered", "AI usage must be metered");

  const expectedProducts = sorted([mcrBase.product, airBase.product]);
  assert(expectedProducts.length === 2, "The two platform Prices must use separate Products");
  assert(!expectedProducts.includes(airUsage.product), "AI usage must use a separate Product");

  assert(coupon?.object === "coupon", "Founding offer is not a Stripe Coupon");
  assert(coupon.livemode === false, "Founding offer Coupon must be test-mode");
  assert(coupon.valid === true, "Founding offer Coupon must be valid");
  assert(coupon.percent_off === 100, "Founding offer Coupon must be 100 percent off");
  assert(coupon.duration === "repeating", "Founding offer Coupon must repeat");
  assert(coupon.duration_in_months === 3, "Founding offer Coupon must cover three months");
  assert(coupon.amount_off == null, "Founding offer Coupon must not use a fixed amount");

  const scopedProducts = sorted(coupon.applies_to?.products ?? []);
  assert(
    JSON.stringify(scopedProducts) === JSON.stringify(expectedProducts),
    "Founding offer Coupon must apply only to both platform-fee Products",
  );
  assert(!scopedProducts.includes(airUsage.product), "Founding offer Coupon must exclude AI usage");

  return { couponScopedToTwoPlatformProducts: true, usageProductsExcluded: true };
}

function runGh(args, { input, token, repository }) {
  const result = spawnSync("gh", [...args, "--repo", repository], {
    encoding: "utf8",
    input,
    env: { ...process.env, GH_TOKEN: token },
  });
  if (result.status !== 0) {
    throw new Error(`GitHub environment-secret operation failed (${args.slice(0, 3).join(" ")})`);
  }
}

export async function configureStagingFoundingCoupon(env = process.env) {
  const configurationToken = env.STAGING_CONFIGURATION_TOKEN?.trim();
  if (!configurationToken) {
    return { configured: false, reason: "one-time configuration token absent" };
  }

  assert(env.DEPLOYMENT_TARGET === "staging", "Coupon configuration is staging-only");
  assert(env.STRIPE_MODE === "test", "Coupon configuration requires Stripe test mode");

  const key = required(env, "STRIPE_SECRET_KEY");
  assert(
    /^(?:(?:sk|rk)_test_|sk_org_test_)/.test(key),
    "Coupon configuration refuses non-test Stripe keys",
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
  const [account, mcrBase, airBase, airUsage] = await Promise.all([
    stripe.accounts.retrieve(),
    stripe.prices.retrieve(priceIds.MCR_BASE),
    stripe.prices.retrieve(priceIds.AIR_BASE),
    stripe.prices.retrieve(priceIds.AIR_USAGE),
  ]);
  assert(account?.object === "account", "Could not verify the staging Stripe account context");

  const expectedProducts = sorted([mcrBase.product, airBase.product]);
  const prices = { MCR_BASE: mcrBase, AIR_BASE: airBase, AIR_USAGE: airUsage };
  let coupon;
  try {
    coupon = await stripe.coupons.retrieve(COUPON_ID, { expand: ["applies_to"] });
    if (coupon.deleted)
      throw new Error("The deterministic founding Coupon ID was previously deleted");
  } catch (error) {
    if (
      error instanceof Stripe.errors.StripeInvalidRequestError &&
      error.code === "resource_missing"
    ) {
      coupon = await stripe.coupons.create({
        id: COUPON_ID,
        name: "FOUNDINGPLUMBER — 3 months free",
        percent_off: 100,
        duration: "repeating",
        duration_in_months: 3,
        applies_to: { products: expectedProducts },
        metadata: { offer: "FOUNDINGPLUMBER", offer_version: "2026-08-three-months" },
      });
    } else {
      throw error;
    }
  }

  validateFoundingCoupon({ coupon, prices });

  const repository = required(env, "GITHUB_REPOSITORY");
  runGh(["secret", "set", COUPON_SECRET_NAME, "--env", "staging", "--body", "-"], {
    input: coupon.id,
    token: configurationToken,
    repository,
  });
  runGh(["secret", "delete", CONFIGURATION_TOKEN_NAME, "--env", "staging"], {
    token: configurationToken,
    repository,
  });

  return {
    configured: true,
    mode: "test",
    accountVerified: true,
    priceCount: 3,
    couponScopedToTwoPlatformProducts: true,
    usageProductsExcluded: true,
    configurationTokenRemoved: true,
  };
}

const isDirect = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirect) {
  configureStagingFoundingCoupon()
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
