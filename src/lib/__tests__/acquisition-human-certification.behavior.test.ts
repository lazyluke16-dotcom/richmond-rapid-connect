import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  createDefaultAcquisitionDraft,
  firstIncompleteAcquisitionStep,
  readSafeAcquisitionDraft,
  safeAcquisitionDraftForBrowser,
} from "../acquisition";
import { COMMERCIAL_PRICING, platformFeeCents, usageRateLines } from "../commercial-pricing";
import { DEFAULT_DEMO_VARIANT, resolveDemoVariant } from "../demo-variants";
import { validateBusinessLogo } from "../../routes/api/public/business-logo";

const source = (path: string) => readFileSync(path, "utf8");
const landing = source("src/routes/plumbers.tsx");
const wizard = source("src/components/acquisition/AcquisitionWizard.tsx");
const checkout = source("src/routes/api/public/billing.checkout.ts");
const originalDemo = source("src/components/acquisition/DemoCommercial.tsx");
const v2Demo = source("src/components/acquisition/DemoRealWorldV2.tsx");
const demoWrapper = source("src/components/acquisition/DemoExperience.tsx");
const logoRoute = source("src/routes/api/public/business-logo.ts");
const migration = source(
  "supabase/migrations/20260801190000_identity_safe_acquisition_profile.sql",
);

function fresh() {
  return createDefaultAcquisitionDraft({
    source: null,
    medium: null,
    campaign: null,
    content: null,
    referralCode: null,
  });
}

describe("human finding: optional demo and direct signup", () => {
  it("starts either service directly without making demo completion a prerequisite", () => {
    expect(landing).toContain('selectPlanAndStart("missed_call_recovery")');
    expect(landing).toContain('selectPlanAndStart("ai_receptionist")');
    expect(landing).toContain('track("service_card_clicked"');
    expect(landing).toContain("onClick={openDemo}");
    expect(landing).not.toMatch(/demo_completed[\s\S]{0,120}setWizardOpen/);
  });

  it("keeps keyboard-visible buttons rather than a complex clickable card", () => {
    expect(landing).toContain("Choose {title}");
    expect(landing).toContain("focus-visible:ring");
    expect(landing).toContain("onSelect={() => selectPlanAndStart(service)}");
  });
});

describe("human finding: explicit identity and resume semantics", () => {
  it("never persists unauthenticated identity or business details", () => {
    const draft = Object.assign(fresh(), {
      businessName: "Private Plumbing",
      firstName: "Pat",
      lastName: "Owner",
      email: "private@example.com",
      contactEmail: "billing@example.com",
      mobile: "+61400000000",
      businessPhone: "+61390000000",
      plan: "ai_receptionist" as const,
    });
    const safe = safeAcquisitionDraftForBrowser(draft);
    expect(Object.keys(safe).sort()).toEqual([
      "attribution",
      "demoVariant",
      "plan",
      "pricingMode",
      "promoCode",
      "version",
    ]);
    const resumed = readSafeAcquisitionDraft(JSON.stringify(safe), fresh());
    expect(resumed).toMatchObject({
      businessName: "",
      email: "",
      mobile: "",
      plan: "ai_receptionist",
    });
  });

  it("clears the legacy PII-bearing localStorage draft and requires an account choice", () => {
    expect(landing).toContain("localStorage.removeItem(ACQUISITION_STORAGE_KEY)");
    expect(wizard).toContain("Signed-in account");
    expect(wizard).toContain("Continue as ${identity.email}");
    expect(wizard).toContain("Use a different account");
    expect(wizard).toContain("Start fresh with this signed-in account");
  });

  it("keeps contact email separate and locks checkout to the authenticated email and business", () => {
    expect(wizard).toContain("Business contact email (optional)");
    expect(wizard).toContain("It does not change the signed-in login or Stripe ownership");
    expect(wizard).toContain("email: existingAuth.session.user.email");
    expect(checkout).toContain("requireAuthAndBusiness(token, supabaseAdmin)");
    expect(checkout).toContain("auth.admin.getUserById(userId)");
    expect(checkout).toContain("email: email ?? undefined");
    expect(checkout).not.toContain("draft.email");
  });

  it("resumes at the first missing stage rather than blindly restoring step five", () => {
    const draft = fresh();
    expect(firstIncompleteAcquisitionStep(draft)).toBe(1);
    Object.assign(draft, {
      businessName: "Safe Plumbing",
      firstName: "Sam",
      lastName: "Pipe",
      email: "sam@example.com",
      contactEmail: "sam@example.com",
      mobile: "+61400000000",
    });
    expect(firstIncompleteAcquisitionStep(draft)).toBe(2);
    Object.assign(draft, { businessPhone: "+61390000000", serviceArea: "Richmond" });
    expect(firstIncompleteAcquisitionStep(draft)).toBe(4);
  });
});

describe("human finding: wizard payment and authoritative pricing", () => {
  it("uses one pricing model for A$9, A$15, combined totals and usage", () => {
    expect(platformFeeCents("missed_call_recovery")).toBe(900);
    expect(platformFeeCents("ai_receptionist")).toBe(1500);
    expect(platformFeeCents("both")).toBe(2400);
    expect(COMMERCIAL_PRICING.services.missed_call_recovery.usage).toMatchObject({
      unitPriceCents: 25,
      unitPriceIncGstCents: 27.5,
      taxBehavior: "exclusive",
    });
    expect(COMMERCIAL_PRICING.services.ai_receptionist.usage).toMatchObject({
      unitPriceCents: 59,
      meteredPer: "second",
      taxBehavior: "inclusive",
    });
    expect(usageRateLines("both")).toHaveLength(2);
  });

  it("discloses the offer, normal billing date, exact usage, worked example and operational-off distinction", () => {
    expect(wizard).toContain("What you will pay");
    expect(wizard).toContain("See all usage rates");
    expect(wizard).toContain(
      "No separate AI-model, inbound-call or phone-number customer charge is implemented",
    );
    expect(wizard).toContain("Switching a service off");
    expect(wizard).toContain("normalBillingDate()");
    expect(wizard).toContain("including GST");
    expect(landing).toContain("27.5¢ including GST");
  });

  it("keeps Stripe-hosted collection in the wizard and returns cancellation to payment resume", () => {
    expect(wizard).toContain("Create account & continue to Stripe");
    expect(wizard).toContain('fetch("/api/public/billing/checkout"');
    expect(checkout).toContain("/plumbers?resume=payment&billing=cancelled");
    expect(checkout).toContain("stripe_subscription_id");
    expect(checkout).toContain("already_subscribed");
    expect(checkout).toContain("idempotencyKeys.session");
  });
});

describe("human finding: optional logo and licence", () => {
  it("validates safe logo bytes and rejects spoofed or oversized uploads", () => {
    expect(
      validateBusinessLogo({
        type: "image/png",
        size: 4,
        bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      }).ok,
    ).toBe(true);
    expect(
      validateBusinessLogo({
        type: "image/png",
        size: 4,
        bytes: new Uint8Array([0x3c, 0x73, 0x76, 0x67]),
      }).ok,
    ).toBe(false);
    expect(
      validateBusinessLogo({
        type: "image/svg+xml",
        size: 4,
        bytes: new Uint8Array([0x3c, 0x73, 0x76, 0x67]),
      }).ok,
    ).toBe(false);
    expect(
      validateBusinessLogo({
        type: "image/jpeg",
        size: 2_097_153,
        bytes: new Uint8Array([0xff, 0xd8, 0xff]),
      }).ok,
    ).toBe(false);
  });

  it("uses a private tenant path and keeps licence disclosure opt-in", () => {
    expect(logoRoute).toContain("`${owner.businessId}/${crypto.randomUUID()}");
    expect(logoRoute).toContain("requireAuthAndBusiness");
    expect(migration).toContain("public = false");
    expect(migration).toContain("public.current_business_id()::text");
    expect(wizard).toContain("Business logo (optional)");
    expect(wizard).toContain("Plumber licence / registration number (optional)");
    expect(wizard).toContain("licence_public: false");
  });
});

describe("versioned demo candidate", () => {
  it("preserves the original and selects exactly one stable variant", () => {
    expect(originalDemo).toContain("export function DemoCommercial");
    expect(v2Demo).toContain('data-demo-variant="demo-real-world-v2"');
    expect(demoWrapper).toContain('variant === "demo-original"');
    expect(DEFAULT_DEMO_VARIANT).toBe("demo-real-world-v2");
    expect(resolveDemoVariant("demo-original")).toBe("demo-original");
    expect(resolveDemoVariant("unknown")).toBe("demo-real-world-v2");
  });

  it("labels both service reconstructions, captions, transcript and billing-safe toggles", () => {
    expect(v2Demo).toContain("Rapid Connect does not answer it");
    expect(v2Demo).toContain("AI Receptionist answers the original call");
    expect(v2Demo).toContain("Read the full accessible transcript");
    expect(v2Demo).toContain("Switching a service off pauses its operation");
    expect(v2Demo).toMatch(/It does not cancel the Stripe\s+subscription/);
  });

  it("records variant-safe funnel analytics through subscription completion", () => {
    expect(landing).toContain("demoVariant: details?.demoVariant ?? demoVariant");
    expect(source("src/routes/api/public/acquisition.ts")).toContain(
      "demo_variant: event.demoVariant",
    );
    expect(source("src/routes/api/public/webhooks.stripe-inbound.ts")).toContain("demo_variant:");
    expect(migration).toContain("acquisition_events_demo_variant_check");
  });
});
