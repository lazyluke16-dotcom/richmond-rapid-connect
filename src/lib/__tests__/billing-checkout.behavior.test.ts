import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import {
  billingCheckoutErrorResponse,
  checkoutIdempotencyKeys,
  classifyBillingCheckoutFailure,
} from "../../routes/api/public/billing.checkout";

describe("billing checkout failure responses", () => {
  it("maps configuration failures to safe structured JSON", async () => {
    const failure = classifyBillingCheckoutFailure(
      new Error("[stripe] Missing required Stripe price configuration: SECRET_DETAIL"),
    );
    expect(failure).toEqual({
      status: 503,
      code: "stripe_prices_not_configured",
      error: "Billing is temporarily unavailable. Please try again shortly.",
    });

    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = billingCheckoutErrorResponse(
      new Error("[stripe] Missing required Stripe price configuration: SECRET_DETAIL"),
    );
    expect(response.status).toBe(503);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.json()).toEqual({
      error: "Billing is temporarily unavailable. Please try again shortly.",
      code: "stripe_prices_not_configured",
    });
    expect(consoleError).not.toHaveBeenCalledWith(expect.stringContaining("SECRET_DETAIL"));
    consoleError.mockRestore();
  });

  it.each([
    [
      "[stripe] STRIPE_SECRET_KEY is not configured — configure it in the server runtime",
      "stripe_secret_not_configured",
    ],
    [
      "[stripe] STRIPE_SECRET_KEY must be a Stripe account, restricted, or organization secret key",
      "stripe_secret_invalid",
    ],
    [
      "[stripe] STRIPE_CONTEXT is required when STRIPE_SECRET_KEY is an organization API key",
      "stripe_context_not_configured",
    ],
    ['[stripe] STRIPE_MODE must be either "test" or "live"', "stripe_mode_invalid"],
    [
      "[stripe] STRIPE_MODE=test does not match the configured live-mode key",
      "stripe_mode_mismatch",
    ],
    ["Billing return URL must use HTTPS", "billing_return_url_invalid"],
  ])("classifies %s without exposing configuration values", (message, code) => {
    expect(classifyBillingCheckoutFailure(new Error(message))).toMatchObject({
      status: 503,
      code,
    });
  });

  it("maps Stripe SDK failures without leaking provider messages", async () => {
    const stripeFailure = Object.assign(new Error("No such price: price_wrong_account"), {
      name: "StripeInvalidRequestError",
      type: "StripeInvalidRequestError",
      code: "resource_missing",
      requestId: "req_test_123",
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = billingCheckoutErrorResponse(stripeFailure);
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: "Stripe could not start checkout. Please try again.",
      code: "stripe_request_failed",
    });
    expect(JSON.stringify(await classifyBillingCheckoutFailure(stripeFailure))).not.toContain(
      "price_wrong_account",
    );
    consoleError.mockRestore();
  });

  it("keeps unknown route failures JSON-shaped", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = billingCheckoutErrorResponse(new Error("unexpected"));
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ code: "billing_checkout_failed" });
    consoleError.mockRestore();
  });
});

describe("billing checkout idempotency and waiver ordering", () => {
  it("is stable for one tenant and isolated across tenants and plans", () => {
    const first = checkoutIdempotencyKeys("business-a", "missed_call_recovery", "coupon-test");
    expect(checkoutIdempotencyKeys("business-a", "missed_call_recovery", "coupon-test")).toEqual(
      first,
    );
    expect(
      checkoutIdempotencyKeys("business-b", "missed_call_recovery", "coupon-test"),
    ).not.toEqual(first);
    expect(checkoutIdempotencyKeys("business-a", "ai_receptionist", "coupon-test")).not.toEqual(
      first,
    );
    expect(checkoutIdempotencyKeys("business-a", "missed_call_recovery", null).customer).toBe(
      first.customer,
    );
    expect(checkoutIdempotencyKeys("business-a", "missed_call_recovery", null).session).not.toBe(
      first.session,
    );
  });

  it("validates the waiver before creating customers and applies it until redeemed", () => {
    const source = readFileSync("src/routes/api/public/billing.checkout.ts", "utf8");
    expect(source.indexOf("shouldApplyUnionOffer")).toBeLessThan(
      source.indexOf("stripe.customers.create"),
    );
    expect(source.indexOf("shouldApplyFoundingOffer")).toBeLessThan(
      source.indexOf("stripe.customers.create"),
    );
    expect(source).toContain('billing?.founding_offer_version === "founding-2026-three-months"');
    expect(source).toContain("getFoundingThreeMonthCouponId()");
    expect(source).toMatch(
      /billing\?\.union_offer_eligible === true\s*&&\s*!billing\?\.union_offer_redeemed_at/,
    );
    expect(source).toContain("{ idempotencyKey: idempotencyKeys.customer }");
    expect(source).toContain("{ idempotencyKey: idempotencyKeys.session }");
    expect(source).not.toContain("isFirstCheckout");
  });
});
