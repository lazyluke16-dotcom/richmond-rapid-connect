import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

// @ts-expect-error Executable deployment scripts intentionally do not ship declarations.
import { validateInclusiveGstResources } from "../../../scripts/configure-staging-commercial-gst.mjs";
import { COMMERCIAL_PRICING, platformFeeCents, usageRateLines } from "../commercial-pricing";
import { calculateGstMinor } from "../sms-invoicing.server";

function resources() {
  return {
    prices: {
      MCR_BASE: {
        object: "price",
        livemode: false,
        active: true,
        currency: "aud",
        unit_amount: 900,
        tax_behavior: "inclusive",
      },
      AIR_BASE: {
        object: "price",
        livemode: false,
        active: true,
        currency: "aud",
        unit_amount: 1500,
        tax_behavior: "inclusive",
      },
      AIR_USAGE: {
        object: "price",
        livemode: false,
        active: true,
        currency: "aud",
        unit_amount_decimal: "0.983333000000",
        tax_behavior: "inclusive",
      },
    },
    taxRate: {
      object: "tax_rate",
      livemode: false,
      active: true,
      inclusive: true,
      percentage: 10,
      country: "AU",
      jurisdiction: "AU",
    },
  };
}

describe("approved Australian GST contract", () => {
  it("keeps platform and AI headline totals GST-inclusive without adding 10 percent", () => {
    expect(platformFeeCents("missed_call_recovery")).toBe(900);
    expect(platformFeeCents("ai_receptionist")).toBe(1500);
    expect(platformFeeCents("both")).toBe(2400);
    expect(COMMERCIAL_PRICING.services.missed_call_recovery.platformTaxBehavior).toBe("inclusive");
    expect(COMMERCIAL_PRICING.services.ai_receptionist.platformTaxBehavior).toBe("inclusive");
    expect(COMMERCIAL_PRICING.services.ai_receptionist.usage).toMatchObject({
      unitPriceCents: 59,
      taxBehavior: "inclusive",
    });
    expect(validateInclusiveGstResources(resources())).toMatchObject({
      headlineTotalsUnchanged: true,
      platformAndAiTaxBehavior: "inclusive",
    });
  });

  it("preserves the 25-cent SMS base and makes 27.5 cents including GST prominent", () => {
    expect(COMMERCIAL_PRICING.services.missed_call_recovery.usage).toMatchObject({
      unitPriceExGstCents: 25,
      unitPriceIncGstCents: 27.5,
      taxBehavior: "exclusive",
    });
    expect(usageRateLines("missed_call_recovery")[0]).toContain("27.5¢ including GST");
    expect(calculateGstMinor(100)).toBe(10);
    expect(calculateGstMinor(25)).toBe(3);
  });

  it("rejects live, exclusive, or economically changed Stripe resources", () => {
    const live = resources();
    live.prices.MCR_BASE.livemode = true;
    expect(() => validateInclusiveGstResources(live)).toThrow("test-mode");

    const exclusive = resources();
    exclusive.prices.AIR_BASE.tax_behavior = "exclusive";
    expect(() => validateInclusiveGstResources(exclusive)).toThrow("include GST");

    const increased = resources();
    increased.prices.MCR_BASE.unit_amount = 990;
    expect(() => validateInclusiveGstResources(increased)).toThrow("remain A$9.00");
  });

  it("wires Checkout to manual inclusive GST and keeps automatic tax off", () => {
    const checkout = readFileSync("src/routes/api/public/billing.checkout.ts", "utf8");
    expect(checkout).toContain("default_tax_rates: [inclusiveGstTaxRateId]");
    expect(checkout).toContain("automatic_tax: { enabled: false }");
    expect(checkout).toContain('"gst-inclusive-v1"');
  });

  it("keeps SMS invoice tax exclusive and separate from subscription GST", () => {
    const smsInvoice = readFileSync("src/lib/sms-invoice-stripe.server.ts", "utf8");
    expect(smsInvoice).toContain('tax_behavior: "exclusive"');
    expect(smsInvoice).toContain("STRIPE_SMS_GST_TAX_RATE_ID");
    expect(smsInvoice).not.toContain("STRIPE_GST_INCLUSIVE_TAX_RATE_ID");
  });

  it("writes environment secrets through stdin instead of storing a literal dash", () => {
    const gstConfigurator = readFileSync("scripts/configure-staging-commercial-gst.mjs", "utf8");
    const couponConfigurator = readFileSync(
      "scripts/configure-staging-founding-coupon.mjs",
      "utf8",
    );
    expect(gstConfigurator).not.toContain('"--body", "-"');
    expect(couponConfigurator).not.toContain('"--body", "-"');
    expect(gstConfigurator).toContain('"secret", "set", INCLUSIVE_TAX_RATE_SECRET');
    expect(couponConfigurator).toContain('"secret", "set", COUPON_SECRET_NAME');
  });
});
