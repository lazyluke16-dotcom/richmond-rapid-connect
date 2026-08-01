import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import {
  ACQUISITION_PLANS,
  acquisitionUserMetadata,
  createDefaultAcquisitionDraft,
  normalBillingDate,
  readSafeAcquisitionDraft,
  safeAcquisitionDraftForBrowser,
  standardBillingDate,
} from "../acquisition";
import { getCheckoutLineItems, STANDARD_SETUP_FEE_CENTS } from "../stripe.server";
import { validateStep, type PromoState } from "../../components/acquisition/AcquisitionWizard";

const source = (path: string) => readFileSync(path, "utf8");
const landing = source("src/routes/plumbers.tsx");
const wizard = source("src/components/acquisition/AcquisitionWizard.tsx");
const validator = source("src/routes/api/public/acquisition.ts");
const checkout = source("src/routes/api/public/billing.checkout.ts");
const migration = source("supabase/migrations/20260801210000_standard_acquisition_pricing.sql");

const attribution = {
  source: "certification",
  medium: "direct",
  campaign: "pr7-offer-retest",
  content: "campaign",
  referralCode: null,
};

const originalPrices = {
  STRIPE_PRICE_MCR_BASE: process.env.STRIPE_PRICE_MCR_BASE,
  STRIPE_PRICE_AIR_BASE: process.env.STRIPE_PRICE_AIR_BASE,
  STRIPE_PRICE_AIR_USAGE: process.env.STRIPE_PRICE_AIR_USAGE,
};

afterEach(() => {
  for (const [name, value] of Object.entries(originalPrices)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("campaign promotion state", () => {
  it("prefills only an explicit campaign code and keeps ordinary traffic standard", () => {
    const campaign = createDefaultAcquisitionDraft(attribution, "founding plumber");
    expect(campaign).toMatchObject({
      promoCode: "FOUNDINGPLUMBER",
      pricingMode: "offer",
    });

    const ordinary = createDefaultAcquisitionDraft({ ...attribution, campaign: null });
    expect(ordinary).toMatchObject({ promoCode: "", pricingMode: "standard" });
    expect(landing).toContain('normalizePromoCode(search.code ?? "")');
    expect(landing).not.toContain("search.code ?? DEFAULT_PROMO_CODE");
  });

  it("preserves the campaign code and pricing choice without persisting identity", () => {
    const campaign = createDefaultAcquisitionDraft(attribution, "FOUNDINGPLUMBER");
    Object.assign(campaign, {
      email: "private@example.com",
      businessName: "Private Plumbing",
      plan: "ai_receptionist" as const,
    });
    const recovered = readSafeAcquisitionDraft(
      JSON.stringify(safeAcquisitionDraftForBrowser(campaign)),
      createDefaultAcquisitionDraft(attribution, "FOUNDINGPLUMBER"),
    );
    expect(recovered).toMatchObject({
      promoCode: "FOUNDINGPLUMBER",
      pricingMode: "offer",
      plan: "ai_receptionist",
      email: "",
      businessName: "",
    });
    expect(acquisitionUserMetadata(campaign)).toMatchObject({
      acquisition_promo_code: "FOUNDINGPLUMBER",
      acquisition_pricing_mode: "offer",
    });
  });

  it("auto-validates and distinguishes every non-authoritative state", () => {
    expect(wizard).toContain('fetch("/api/public/acquisition"');
    expect(wizard).toContain('status: "validating"');
    expect(wizard).toContain('status: "no_code"');
    expect(wizard).toContain('status: "invalid"');
    expect(wizard).toContain('status: "unavailable"');
    expect(wizard).toContain("Try again");
    expect(wizard).toContain("Continue at standard price");
    expect(wizard).toContain("standardPricingChosen");
    expect(validator).toContain('state: "unavailable"');
    expect(validator).toContain('code: "promotion_validation_unavailable"');
    expect(validator).toContain('state: "invalid"');
    expect(validator).toContain('state: "valid"');
  });

  it("allows standard checkout after no or invalid code but blocks an unconfirmed discount", () => {
    const standard = createDefaultAcquisitionDraft(attribution);
    standard.step = 3;
    expect(validateStep(standard, "", false, { status: "no_code" }, false)).toBeNull();
    expect(
      validateStep(standard, "", false, { status: "invalid", message: "Not valid" }, false),
    ).toBeNull();

    const offer = createDefaultAcquisitionDraft(attribution, "FOUNDINGPLUMBER");
    offer.step = 3;
    const unavailable: PromoState = { status: "unavailable", message: "Unavailable" };
    expect(validateStep(offer, "", false, unavailable, false)).toContain("standard price");
    const valid: PromoState = {
      status: "valid",
      waivedSetupFeeCents: 49_900,
      subscriptionMonthsFree: 3,
      offerVersion: "founding-2026-three-months",
      expiresAt: null,
    };
    expect(validateStep(offer, "", false, valid, false)).toBeNull();

    standard.step = 4;
    expect(validateStep(standard, "", true, unavailable, true)).toBeNull();
  });

  it("shows the exact offer and standard dates and amounts", () => {
    const date = new Date(2026, 7, 1);
    expect(normalBillingDate(date)).toContain("1 November 2026");
    expect(standardBillingDate(date)).toContain("1 August 2026");
    expect(ACQUISITION_PLANS.missed_call_recovery).toMatchObject({
      setupFeeCents: 49_900,
      platformFeeCents: 900,
    });
    expect(wizard).toContain("first three monthly billing periods");
    expect(wizard).toContain("Usage charges apply from activation");
    expect(wizard).toContain("setup/sign-on fee including GST");
    expect(wizard).toContain("Due at Checkout");
  });
});

describe("server-owned standard and offer checkout", () => {
  it("adds an inclusive A$499 one-time Stripe item only for standard checkout", () => {
    process.env.STRIPE_PRICE_MCR_BASE = "price_test_mcr";
    process.env.STRIPE_PRICE_AIR_BASE = "price_test_ai";
    process.env.STRIPE_PRICE_AIR_USAGE = "price_test_ai_usage";

    const standard = getCheckoutLineItems("missed_call_recovery", { includeSetupFee: true });
    expect(STANDARD_SETUP_FEE_CENTS).toBe(49_900);
    expect(standard[0]).toMatchObject({
      quantity: 1,
      price_data: {
        currency: "aud",
        unit_amount: 49_900,
        tax_behavior: "inclusive",
      },
    });
    expect(standard[1]).toEqual({ price: "price_test_mcr", quantity: 1 });
    expect(getCheckoutLineItems("missed_call_recovery", { includeSetupFee: false })).toEqual([
      { price: "price_test_mcr", quantity: 1 },
    ]);
  });

  it("revalidates tenant redemption and pricing mode before any Stripe write", () => {
    expect(checkout.indexOf("foundingWaiverVerified")).toBeLessThan(
      checkout.indexOf("stripe.customers.create"),
    );
    expect(checkout.indexOf("standardPricingVerified")).toBeLessThan(
      checkout.indexOf("stripe.customers.create"),
    );
    expect(checkout).toContain('acquisition?.acquisition_pricing_mode === "offer"');
    expect(checkout).toContain('acquisition?.acquisition_pricing_mode === "standard"');
    expect(checkout).toContain("redemption?.plan === plan");
    expect(checkout).toContain("unionWaiverVerified &&");
    expect(checkout).toContain("includeSetupFee: !setupFeeWaived");
    expect(checkout).toContain('"pricing_selection_incomplete"');
  });

  it("selects standard pricing only for the authenticated tenant and blocks conversion", () => {
    expect(migration).toContain("uid uuid := auth.uid()");
    expect(migration).toContain("WHERE bu.user_id = uid");
    expect(migration).toContain("existing_subscription IS NOT NULL");
    expect(migration).toContain("acquisition_promo_redemptions WHERE business_id = bid");
    expect(migration).toContain("acquisition_pricing_mode = 'standard'");
    expect(migration).toContain("promotion_code = NULL");
    expect(migration).toContain("setup_fee_waived_cents = NULL");
    expect(migration).toContain("'setupFeeCents', 49900");
    expect(migration).toContain("pricing_mode = 'offer'");
    expect(migration).toContain("public.recover_my_acquisition_business()");
  });
});
