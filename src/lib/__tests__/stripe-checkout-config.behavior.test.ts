import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

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
});
