import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

// @ts-expect-error Executable deployment scripts intentionally do not ship declarations.
import { validateFoundingCoupon } from "../../../scripts/configure-staging-founding-coupon.mjs";
import { validateStripeCheckoutResources } from "../../../scripts/verify-stripe-checkout-config.mjs";

function resources() {
  return {
    account: { id: "acct_test" },
    prices: {
      MCR_BASE: {
        object: "price",
        livemode: false,
        active: true,
        currency: "aud",
        unit_amount: 900,
        product: "prod_mcr",
        recurring: { interval: "month", usage_type: "licensed" },
      },
      AIR_BASE: {
        object: "price",
        livemode: false,
        active: true,
        currency: "aud",
        unit_amount: 1500,
        product: "prod_air_base",
        recurring: { interval: "month", usage_type: "licensed" },
      },
      AIR_USAGE: {
        object: "price",
        livemode: false,
        active: true,
        currency: "aud",
        unit_amount: null,
        unit_amount_decimal: "0.983333000000",
        product: "prod_air_usage",
        recurring: { interval: "month", usage_type: "metered" },
      },
    },
    coupon: {
      object: "coupon",
      livemode: false,
      valid: true,
      percent_off: 100,
      duration: "once",
      applies_to: { products: ["prod_air_base", "prod_mcr"] },
    },
    foundingCoupon: {
      object: "coupon",
      livemode: false,
      valid: true,
      percent_off: 100,
      amount_off: null,
      duration: "repeating",
      duration_in_months: 3,
      applies_to: { products: ["prod_air_base", "prod_mcr"] },
    },
  };
}

describe("Stripe checkout staging resource validation", () => {
  it("requires the runtime verifier to expand the coupon product scope", () => {
    const source = readFileSync("scripts/verify-stripe-checkout-config.mjs", "utf8");
    expect(source).toContain('expand: ["applies_to"]');
  });

  it("accepts the exact test-mode prices and base-product-scoped waiver", () => {
    expect(validateStripeCheckoutResources(resources())).toEqual({
      mode: "test",
      accountId: "acct_test",
      priceCount: 3,
      couponScopedToBaseProducts: true,
      foundingCouponThreeMonths: true,
      usageProductsExcludedFromFoundingCoupon: true,
      commercialPricing: {
        mcrMonthlyAud: 9,
        aiMonthlyAud: 15,
        aiUsageAudPerSecond: 0.00983333,
        aiUsageAudPerMinute: 0.5899998,
        taxBehavior: { mcr: "unspecified", ai: "unspecified", aiUsage: "unspecified" },
      },
    });
  });

  it("rejects the currently observed unscoped coupon", () => {
    const input = resources();
    input.coupon.applies_to = null as unknown as { products: string[] };
    expect(() => validateStripeCheckoutResources(input)).toThrow(
      "must apply only to both base Products",
    );
  });

  it("rejects a waiver that can discount metered usage", () => {
    const input = resources();
    input.coupon.applies_to.products.push("prod_air_usage");
    expect(() => validateStripeCheckoutResources(input)).toThrow();
  });

  it("rejects live or incorrectly structured prices", () => {
    const input = resources();
    input.prices.MCR_BASE.livemode = true;
    expect(() => validateStripeCheckoutResources(input)).toThrow("must be a test-mode Price");
  });

  it("accepts Stripe decimal normalization but rejects a materially different AI rate", () => {
    const input = resources();
    input.prices.AIR_USAGE.unit_amount_decimal = "1.000000000000";
    expect(() => validateStripeCheckoutResources(input)).toThrow(
      "AI usage must resolve to A$0.59/minute",
    );
  });
});

describe("staging FOUNDINGPLUMBER coupon safety", () => {
  function foundingResources() {
    const input = resources();
    return {
      prices: input.prices,
      coupon: input.foundingCoupon,
    };
  }

  it("accepts exactly three free months scoped to both platform products", () => {
    expect(validateFoundingCoupon(foundingResources())).toEqual({
      couponScopedToTwoPlatformProducts: true,
      usageProductsExcluded: true,
    });
  });

  it("refuses a coupon that also discounts metered usage", () => {
    const input = foundingResources();
    input.coupon.applies_to.products.push("prod_air_usage");
    expect(() => validateFoundingCoupon(input)).toThrow("only to both platform-fee Products");
  });

  it("refuses live, one-off, or incorrectly priced resources", () => {
    const live = foundingResources();
    live.coupon.livemode = true;
    expect(() => validateFoundingCoupon(live)).toThrow("test-mode");

    const once = foundingResources();
    once.coupon.duration = "once";
    expect(() => validateFoundingCoupon(once)).toThrow("must repeat");

    const stalePrice = foundingResources();
    stalePrice.prices.MCR_BASE.unit_amount = 9900;
    expect(() => validateFoundingCoupon(stalePrice)).toThrow("A$9.00");
  });
});
