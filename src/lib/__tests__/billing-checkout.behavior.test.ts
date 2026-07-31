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
      code: "billing_configuration_error",
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
      code: "billing_configuration_error",
    });
    expect(consoleError).not.toHaveBeenCalledWith(expect.stringContaining("SECRET_DETAIL"));
    consoleError.mockRestore();
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
    expect(source).toContain(
      "billing?.union_offer_eligible === true && !billing?.union_offer_redeemed_at",
    );
    expect(source).toContain("{ idempotencyKey: idempotencyKeys.customer }");
    expect(source).toContain("{ idempotencyKey: idempotencyKeys.session }");
    expect(source).not.toContain("isFirstCheckout");
  });
});
