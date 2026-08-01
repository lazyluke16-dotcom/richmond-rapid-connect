import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ACQUISITION_PLANS,
  acquisitionAreaRows,
  acquisitionHourRows,
  acquisitionServiceRows,
  acquisitionUserMetadata,
  calculateAcquisitionRoi,
  createDefaultAcquisitionDraft,
  getAcquisitionAttribution,
  normalBillingDate,
  normalizePromoCode,
  readSafeAcquisitionDraft,
  safeAcquisitionDraftForBrowser,
  recoverAcquisitionDraftFromUser,
} from "@/lib/acquisition";
import { acquisitionContextFromClaims } from "@/lib/acquisition.functions";

describe("acquisition funnel pricing and attribution", () => {
  it("uses the approved A$499 waiver and authoritative recurring prices", () => {
    expect(ACQUISITION_PLANS.missed_call_recovery).toMatchObject({
      setupFeeCents: 49_900,
      platformFeeCents: 900,
    });
    expect(ACQUISITION_PLANS.ai_receptionist).toMatchObject({
      setupFeeCents: 49_900,
      platformFeeCents: 1_500,
    });
    expect(ACQUISITION_PLANS.both).toMatchObject({
      setupFeeCents: 49_900,
      platformFeeCents: 2_400,
    });
  });

  it("calculates editable ROI without treating variable usage as guaranteed income", () => {
    expect(calculateAcquisitionRoi(350, "missed_call_recovery")).toEqual({
      normalMonthlySubscriptionAud: 9,
      valueOfOneJobAud: 350,
      approximateAmountAheadAud: 341,
      monthsCovered: 38,
      excludesUsageCharges: true,
    });
  });

  it("turns the guided answers into deduplicated operational setup rows", () => {
    expect(acquisitionServiceRows("Blocked drains, blocked-drains, Hot water")).toEqual([
      { service_key: "blocked-drains", display_name: "Blocked drains", active: true },
      { service_key: "blocked-drains-2", display_name: "blocked-drains", active: true },
      { service_key: "hot-water", display_name: "Hot water", active: true },
    ]);
    expect(acquisitionAreaRows("Richmond, Burnley, Richmond")).toHaveLength(2);
    expect(acquisitionHourRows("Monday to Saturday, 8am–5pm")).toMatchObject([
      { day_of_week: 0, closed: true },
      { day_of_week: 1, closed: false, open_time: "08:00", close_time: "17:00" },
      {},
      {},
      {},
      {},
      { day_of_week: 6, closed: false },
    ]);
  });

  it("shows three calendar months, including an end-of-month activation", () => {
    expect(normalBillingDate(new Date(2026, 7, 1))).toContain("1 November 2026");
    expect(normalBillingDate(new Date(2026, 7, 31))).toContain("30 November 2026");
  });

  it("normalizes a human-entered promotion code to its server key", () => {
    expect(normalizePromoCode(" founding plumber!! ")).toBe("FOUNDINGPLUMBER");
    expect(normalizePromoCode("abc_123-test")).toBe("ABC_123-TEST");
  });

  it("captures explicit campaign parameters without inventing attribution", () => {
    const params = new URLSearchParams(
      "utm_source=sms&utm_medium=direct&utm_campaign=founders&utm_content=variant-a&ref=p-22",
    );
    expect(getAcquisitionAttribution(params)).toEqual({
      source: "sms",
      medium: "direct",
      campaign: "founders",
      content: "variant-a",
      referralCode: "p-22",
    });
    expect(getAcquisitionAttribution(new URLSearchParams())).toEqual({
      source: null,
      medium: null,
      campaign: null,
      content: null,
      referralCode: null,
    });
  });

  it("restores only non-identifying choices and never another browser user's details", () => {
    const old = createDefaultAcquisitionDraft({
      source: "email",
      medium: null,
      campaign: "old",
      content: null,
      referralCode: null,
    });
    old.businessName = "Harbour Plumbing";
    const current = createDefaultAcquisitionDraft({
      source: "sms",
      medium: "direct",
      campaign: "new",
      content: null,
      referralCode: null,
    });
    old.email = "alex@example.com";
    old.mobile = "+61411111111";
    old.plan = "ai_receptionist";
    const stored = safeAcquisitionDraftForBrowser(old);
    expect(stored).not.toHaveProperty("businessName");
    expect(stored).not.toHaveProperty("email");
    expect(stored).not.toHaveProperty("mobile");
    const restored = readSafeAcquisitionDraft(JSON.stringify(stored), current);
    expect(restored.businessName).toBe("");
    expect(restored.email).toBe("");
    expect(restored.plan).toBe("ai_receptionist");
    expect(restored.attribution).toMatchObject({
      source: "sms",
      medium: "direct",
      campaign: "new",
    });
  });

  it("puts continuity fields—but never the password—into auth metadata", () => {
    const draft = createDefaultAcquisitionDraft({
      source: "social",
      medium: "instagram",
      campaign: "launch",
      content: "reel",
      referralCode: "ref-1",
    });
    Object.assign(draft, {
      firstName: "Alex",
      lastName: "Smith",
      businessName: "Smith Plumbing",
      businessPhone: "+61411111111",
      mobile: "+61422222222",
      plan: "ai_receptionist",
    });
    const metadata = acquisitionUserMetadata(draft);
    expect(metadata).toMatchObject({
      business_name: "Smith Plumbing",
      acquisition_plan: "ai_receptionist",
      acquisition_promo_code: "FOUNDINGPLUMBER",
      acquisition_source: "social",
    });
    expect(metadata).not.toHaveProperty("password");
  });
});

describe("authenticated acquisition continuity", () => {
  it("recovers the saved plan and offer after confirmation followed by a manual login", () => {
    const fallback = createDefaultAcquisitionDraft({
      source: "direct",
      medium: null,
      campaign: "new-visit",
      content: null,
      referralCode: null,
    });
    const recovered = recoverAcquisitionDraftFromUser(
      {
        email: "alex@example.com",
        user_metadata: {
          first_name: "Alex",
          last_name: "Smith",
          business_name: "Smith Plumbing",
          business_phone_e164: "+61411111111",
          contact_mobile_e164: "+61422222222",
          acquisition_plan: "ai_receptionist",
          acquisition_promo_code: "foundingplumber",
          acquisition_source: "certification",
          acquisition_campaign: "staging-certification",
          call_handling_timing: "all_calls",
          current_answering_arrangement: "mobile",
        },
      },
      fallback,
    );

    expect(recovered).toMatchObject({
      email: "alex@example.com",
      businessName: "Smith Plumbing",
      plan: "ai_receptionist",
      promoCode: "FOUNDINGPLUMBER",
      handlingTiming: "all_calls",
      attribution: {
        source: "certification",
        campaign: "staging-certification",
      },
    });
  });

  it("does not treat an unrelated authenticated account as an interrupted acquisition signup", () => {
    const fallback = createDefaultAcquisitionDraft({
      source: null,
      medium: null,
      campaign: null,
      content: null,
      referralCode: null,
    });
    expect(
      recoverAcquisitionDraftFromUser(
        { email: "existing@example.com", user_metadata: { business_name: "Existing Business" } },
        fallback,
      ),
    ).toBeNull();
  });

  it("accepts only known plans from user metadata", () => {
    expect(
      acquisitionContextFromClaims({
        user_metadata: {
          business_name: "Smith Plumbing",
          acquisition_plan: "ai_receptionist",
          acquisition_promo_code: "foundingplumber",
          acquisition_source: "sms",
        },
      }),
    ).toMatchObject({
      businessName: "Smith Plumbing",
      plan: "ai_receptionist",
      promoCode: "FOUNDINGPLUMBER",
      attribution: { source: "sms" },
    });
    expect(
      acquisitionContextFromClaims({
        user_metadata: { acquisition_plan: "free_everything" },
      }).plan,
    ).toBeNull();
  });
});

describe("acquisition database boundary", () => {
  const migration = readFileSync(
    resolve("supabase/migrations/20260728140000_acquisition_funnel.sql"),
    "utf8",
  );
  const currentMigration = readFileSync(
    resolve("supabase/migrations/20260801130000_seamless_acquisition_activation.sql"),
    "utf8",
  );

  it("keeps promotion and analytics tables private", () => {
    expect(migration).toContain(
      "REVOKE ALL ON public.acquisition_promo_codes FROM anon, authenticated",
    );
    expect(migration).toContain("REVOKE ALL ON public.acquisition_events FROM anon, authenticated");
    expect(migration).toContain(
      "REVOKE ALL ON public.acquisition_promo_redemptions FROM anon, authenticated",
    );
  });

  it("redeems atomically against the authenticated user's business", () => {
    expect(migration).toContain("uid uuid := auth.uid()");
    expect(migration).toContain("FOR UPDATE");
    expect(migration).toContain("WHERE business_id = bid");
    expect(migration).toContain("redemption_count = redemption_count + 1");
    expect(migration).toContain("UNIQUE (promo_code_id, business_id)");
  });

  it("upgrades the approved public offer without retroactively enrolling old redemptions", () => {
    expect(migration).toContain("'FOUNDINGPLUMBER'");
    expect(currentMigration).toContain("founding-2026-three-months");
    expect(currentMigration).toContain(
      "subscription_promo_eligible boolean NOT NULL DEFAULT false",
    );
    expect(currentMigration).toContain("subscription_months_free = 3");
    expect(currentMigration).toContain("waived := 49900");
    expect(currentMigration).toContain("stripe_subscription_id IS NULL");
  });
});

describe("confirmed acquisition account recovery", () => {
  const recoveryMigration = readFileSync(
    resolve("supabase/migrations/20260801130000_seamless_acquisition_activation.sql"),
    "utf8",
  );
  const billingServer = readFileSync(resolve("src/lib/billing.server.ts"), "utf8");
  const billingSummary = readFileSync(resolve("src/routes/api/public/billing.summary.ts"), "utf8");

  it("serializes and idempotently recovers only the signed-in acquisition user", () => {
    const recoveryFunction = recoveryMigration.slice(
      recoveryMigration.indexOf(
        "CREATE OR REPLACE FUNCTION public.recover_my_acquisition_business",
      ),
    );
    expect(recoveryFunction).toContain("uid uuid := auth.uid()");
    expect(recoveryFunction).toContain("auth.jwt() -> 'user_metadata'");
    expect(recoveryFunction).toContain("pg_advisory_xact_lock");
    expect(recoveryFunction).toContain("IF bid IS NOT NULL THEN");
    expect(recoveryFunction).toContain("public.create_business_for_current_user");
    expect(recoveryFunction).toContain("public.redeem_acquisition_offer");
    expect(recoveryFunction).not.toMatch(/_user_id|_business_id/);
  });

  it("rejects unrelated accounts without complete acquisition metadata", () => {
    expect(recoveryMigration).toContain("business_name IS NULL");
    expect(recoveryMigration).toContain(
      "acquisition_plan NOT IN ('missed_call_recovery','ai_receptionist','both')",
    );
    expect(recoveryMigration).toContain("promotion_code !~ '^[A-Z0-9_-]{3,64}$'");
    expect(recoveryMigration).toContain("No recoverable acquisition signup found");
  });

  it("retries the billing lookup after server-side recovery", () => {
    expect(billingServer).toContain("recover_my_acquisition_business");
    expect(billingSummary).toContain("if (err.status === 404)");
    expect(billingSummary).toContain("await recoverAcquisitionBusiness(token)");
    expect(billingSummary.match(/requireAuthAndBusiness\(token, supabaseAdmin\)/g)).toHaveLength(2);
  });
});

describe("acquisition experience source", () => {
  const landing = readFileSync(resolve("src/routes/plumbers.tsx"), "utf8");
  const demo = readFileSync(resolve("src/components/acquisition/DemoCommercial.tsx"), "utf8");
  const wizard = readFileSync(resolve("src/components/acquisition/AcquisitionWizard.tsx"), "utf8");
  const onboarding = readFileSync(resolve("src/routes/_authenticated/onboarding.tsx"), "utf8");
  const checkout = readFileSync(resolve("src/routes/api/public/billing.checkout.ts"), "utf8");

  it("explains both services, exact prices, ROI and the founding offer before signup", () => {
    expect(landing).toContain("One follows up. One answers.");
    expect(landing).toContain("A$9/mo");
    expect(landing).toContain("A$15/mo");
    expect(landing).toContain("A$24/month normally");
    expect(landing).toContain("Cost of one missed job");
    expect(landing).toContain("First 3 subscription months free");
    expect(landing).toContain("Usage applies from day one");
  });

  it("uses a viewport demo with completion tracking and a persistent final call to action", () => {
    expect(demo).toContain("fixed inset-0");
    expect(demo).toContain('"demo_completed"');
    expect(demo).toContain("Set up my service");
    expect(demo).toContain("Safe simulated demo");
    expect(demo).toContain("Watch again");
    expect(demo).toContain("document.exitFullscreen()");
    expect(demo).toContain("onClose()");
    expect(demo).not.toContain("}, 1800)");
  });

  it("uses Stripe for card collection and does not collect card fields locally", () => {
    expect(wizard).toContain('"/api/public/billing/checkout"');
    expect(wizard).toContain("never receives or stores your raw card number");
    expect(wizard).not.toContain('name="card_number"');
  });

  it("requires an explicit tenant-scoped resume choice and never silently changes login identity", () => {
    expect(wizard).toContain("Continue as ${identity.email}");
    expect(wizard).toContain("Use a different account");
    expect(wizard).toContain("Start fresh with this signed-in account");
    expect(wizard).toContain("email: existingAuth.session.user.email");
    expect(wizard).not.toContain(
      "recoverAcquisitionDraftFromUser(existingAuth.session?.user, draft)",
    );
  });

  it("preserves the funnel plan when the customer later continues onboarding", () => {
    expect(onboarding).toContain('full.selected_plan === "missed_call_recovery"');
    expect(onboarding).toContain('full.selected_plan === "ai_receptionist"');
    expect(onboarding).toContain('full.selected_plan === "both"');
    expect(onboarding).toContain("setPlan(full.selected_plan)");
  });

  it("verifies the waiver before creating a Stripe customer and carries audit metadata", () => {
    expect(checkout.indexOf("setup_fee_waived_cents")).toBeLessThan(
      checkout.indexOf("stripe.customers.create"),
    );
    expect(checkout).toContain("promotion_code: acquisition.promotion_code");
    expect(checkout).toContain("...acquisitionMetadata");
    expect(checkout).toContain("getFoundingThreeMonthCouponId");
    expect(checkout).toContain("offer_version: shouldApplyFoundingOffer");
  });
});
