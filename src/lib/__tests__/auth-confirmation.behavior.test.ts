import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  confirmedAcquisitionDestination,
  confirmationFailureMessage,
  readConfirmationParameters,
  safeConfirmationNext,
  safeEmailOtpType,
} from "../auth-confirmation";
import { checkoutFailureMessage } from "../checkout-errors";

const source = (path: string) => readFileSync(path, "utf8");

describe("Rapid Connect email confirmation", () => {
  it("owns a branded, accessible hosted confirmation template", () => {
    const template = source("supabase/templates/confirmation.html");
    expect(template).toContain("Confirm your Rapid Connect account");
    expect(template).toContain("Confirm my email");
    expect(template).toContain("{{ .ConfirmationURL }}");
    expect(template).toContain("copy and paste this link");
    expect(template).toMatch(/This inbox is not\s+monitored/);
    expect(template).not.toContain("Supabase Auth");
    expect(source("scripts/configure-staging-auth-email.mjs")).toContain(
      "mailer_subjects_confirmation",
    );
    expect(source("scripts/configure-staging-auth-email.mjs")).toContain(
      'boundary: "supabase_default_email_provider"',
    );
  });

  it("accepts code, token-hash and implicit same/new-tab confirmation responses", () => {
    const implicit = readConfirmationParameters(
      new URL(
        "https://staging.example/auth/confirm?next=%2Fplumbers#access_token=a&refresh_token=r",
      ),
    );
    expect(implicit).toMatchObject({ accessToken: "a", refreshToken: "r" });
    const pkce = readConfirmationParameters(
      new URL("https://staging.example/auth/confirm?code=one-time-code"),
    );
    expect(pkce.code).toBe("one-time-code");
    expect(safeEmailOtpType("email")).toBe("email");
    expect(safeEmailOtpType("not-an-email-flow")).toBeNull();
  });

  it("prevents open redirects and returns verified acquisition users to payment", () => {
    expect(safeConfirmationNext("https://evil.example")).toBe("/plumbers?resume=payment");
    expect(safeConfirmationNext("//evil.example")).toBe("/plumbers?resume=payment");
    expect(confirmedAcquisitionDestination("/plumbers?code=FOUNDINGPLUMBER")).toBe(
      "/plumbers?code=FOUNDINGPLUMBER&resume=payment&confirmation=verified",
    );
  });

  it("handles expired or reused links without exposing provider details", () => {
    expect(confirmationFailureMessage("otp_expired")).toContain("expired or has already been used");
    const page = source("src/routes/auth_.confirm.tsx");
    expect(page).toContain("Sign in to continue");
    expect(page).toContain("Try again");
    expect(page).toContain("window.history.replaceState");
  });
});

describe("verified acquisition checkout recovery", () => {
  it("restores signed metadata and automatically waits for tenant readiness", () => {
    const wizard = source("src/components/acquisition/AcquisitionWizard.tsx");
    expect(wizard).toContain("confirmationRecoveryStarted");
    expect(wizard).toContain("recoverAcquisitionDraftFromUser(data.session?.user, draft)");
    expect(wizard).toContain("Email confirmed — finishing your secure setup");
    expect(wizard).toContain("await continueAuthenticatedSignup");
    expect(
      wizard.lastIndexOf("sessionStorage.removeItem(ACQUISITION_SAFE_STORAGE_KEY)"),
    ).toBeGreaterThan(wizard.indexOf("if (!response.ok || !payload.url)"));
  });

  it("recovers only the authenticated business and keeps Checkout idempotent", () => {
    const checkout = source("src/routes/api/public/billing.checkout.ts");
    expect(checkout).toContain("await recoverAcquisitionBusiness(token)");
    expect(checkout).toContain("requireAuthAndBusiness(token, supabaseAdmin)");
    expect(checkout).toContain("idempotencyKeys.customer");
    expect(checkout).toContain("idempotencyKeys.session");
    expect(checkout).toContain("correlationId: requestId");
  });

  it("renders safe failure categories with a correlation reference", () => {
    expect(
      checkoutFailureMessage({
        code: "business_setup_incomplete",
        requestId: "corr-123",
      }),
    ).toContain("business setup is not ready");
    expect(
      checkoutFailureMessage({ code: "stripe_request_rejected", requestId: "corr-123" }),
    ).toContain("Reference: corr-123");
  });

  it("certifies a newly verified tenant through the real authenticated endpoint", () => {
    const workflow = source(".github/workflows/staging-deployment.yml");
    const smoke = source("scripts/staging-new-account-checkout-smoke.mjs");
    expect(workflow).toContain("node scripts/staging-new-account-checkout-smoke.mjs");
    expect(smoke).toContain('new URL("/api/public/billing/checkout", baseUrl)');
    expect(smoke).not.toContain("checkout.sessions.create");
    expect(smoke).toContain("checkout.sessions.expire");
    expect(smoke).toContain("noSubscriptionCreated: true");
  });
});
