import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  checkoutAcknowledgementKey,
  checkoutSessionFromSearch,
  checkoutSetupRoute,
  isCheckoutSessionId,
} from "../checkout-return";
import { isPlumberNavigationItemActive, plumberNavigationItems } from "../plumber-navigation";

const source = (path: string) => readFileSync(path, "utf8");

describe("authenticated checkout return experience", () => {
  it("accepts only an explicit Stripe success return with a structurally valid session", () => {
    const sessionId = `cs_test_${"a".repeat(24)}`;
    expect(checkoutSessionFromSearch({ billing: "success", session_id: sessionId })).toBe(
      sessionId,
    );
    expect(isCheckoutSessionId(sessionId)).toBe(true);
    expect(checkoutSessionFromSearch({ billing: "success", session_id: "made-up" })).toBeNull();
    expect(checkoutSessionFromSearch({ billing: "cancelled", session_id: sessionId })).toBeNull();
    expect(checkoutSessionFromSearch({ session_id: sessionId })).toBeNull();
  });

  it("never treats the query parameter itself as proof of purchase", () => {
    const endpoint = source("src/routes/api/public/billing.checkout-status.ts");
    const panel = source("src/components/SubscriptionSuccess.tsx");
    expect(panel).toContain('fetch("/api/public/billing/checkout-status"');
    expect(panel).toContain("if (!token)");
    expect(endpoint).toContain("session.metadata?.business_id !== businessId");
    expect(endpoint).toContain("session.metadata?.plan !== plan");
    expect(endpoint).toContain('session.livemode !== (configuredMode === "live")');
    expect(endpoint).toContain("!sameIds(actualPriceIds, expectedPriceIds(plan))");
  });

  it("supports delayed webhook activation without claiming success early", () => {
    const endpoint = source("src/routes/api/public/billing.checkout-status.ts");
    const panel = source("src/components/SubscriptionSuccess.tsx");
    expect(endpoint).toContain('status: "processing"');
    expect(endpoint).toContain("checkout_processing");
    expect(endpoint).toContain("activation_processing");
    expect(panel).toContain("response.status === 202");
    expect(panel).toContain("2500");
    expect(panel).toContain("Check again");
  });

  it("acknowledges the verified success only once per Checkout Session", () => {
    expect(checkoutAcknowledgementKey("cs_test_example")).toBe(
      "rapid-connect:checkout-ack:cs_test_example",
    );
    const panel = source("src/components/SubscriptionSuccess.tsx");
    expect(panel).toContain("localStorage.getItem(checkoutAcknowledgementKey(sessionId))");
    expect(panel).toContain('localStorage.setItem(checkoutAcknowledgementKey(sessionId), "1")');
    expect(panel).toContain("You’re all set — your subscription is active.");
    expect(panel).toContain("FOUNDINGPLUMBER benefit:");
  });

  it("reconciles the authenticated billing record to Active after provider verification", () => {
    const endpoint = source("src/routes/api/public/billing.checkout-status.ts");
    expect(endpoint).toContain('billing_status: "active"');
    expect(endpoint).toContain("stripe_subscription_id: subscription.id");
    expect(endpoint).toContain("stripe_subscription_status: subscription.status");
    expect(endpoint).toContain('billingStatus: "active"');
    expect(checkoutSetupRoute("missed_call_recovery")).toBe("/call-handling");
    expect(checkoutSetupRoute("ai_receptionist")).toBe("/ai-receptionist");
  });
});

describe("authenticated plumber application shell", () => {
  it("contains every essential plumber-friendly destination", () => {
    expect(plumberNavigationItems.map((item) => item.label)).toEqual([
      "Home",
      "Missed jobs",
      "Call handling",
      "AI Receptionist",
      "Account & Billing",
      "Usage and costs",
      "Business profile",
      "Help & setup guide",
    ]);
    expect(source("src/components/AuthenticatedAppShell.tsx")).toContain("Log out");
  });

  it("provides a persistent desktop sidebar and accessible mobile drawer", () => {
    const shell = source("src/components/AuthenticatedAppShell.tsx");
    expect(shell).toContain("hidden w-72");
    expect(shell).toContain("lg:block");
    expect(shell).toContain("SheetTrigger");
    expect(shell).toContain("Open plumber workspace menu");
    expect(shell).toContain("Skip to page content");
  });

  it("marks the current route, including backward-compatible account and onboarding routes", () => {
    const billing = plumberNavigationItems.find((item) => item.to === "/billing")!;
    const help = plumberNavigationItems.find((item) => item.to === "/setup-guide")!;
    expect(isPlumberNavigationItemActive("/billing", billing)).toBe(true);
    expect(isPlumberNavigationItemActive("/account", billing)).toBe(true);
    expect(isPlumberNavigationItemActive("/onboarding", help)).toBe(true);
    expect(isPlumberNavigationItemActive("/dashboard", billing)).toBe(false);
    expect(source("src/components/AuthenticatedAppShell.tsx")).toContain(
      'aria-current={active ? "page"',
    );
  });

  it("has a real protected route for every navigation destination and no dead ends", () => {
    for (const item of plumberNavigationItems) {
      const name = item.to.slice(1);
      expect(existsSync(`src/routes/_authenticated/${name}.tsx`), item.to).toBe(true);
    }
    expect(source("src/routes/_authenticated/route.tsx")).toContain("AuthenticatedAppShell");
    expect(source("src/routes/_authenticated/dashboard.tsx")).toContain(
      "Your first job: connect call handling",
    );
  });
});

describe("isolated staging Stripe webhook repair", () => {
  it("updates one existing test endpoint after the exact hosted release and never creates one", () => {
    const workflow = source(".github/workflows/staging-deployment.yml");
    const script = source("scripts/configure-staging-stripe-webhook.mjs");
    expect(workflow.indexOf("Verify exact hosted release identity")).toBeLessThan(
      workflow.indexOf("Point the existing Stripe test webhook at isolated staging"),
    );
    expect(workflow).toContain("node scripts/configure-staging-stripe-webhook.mjs");
    expect(workflow).toContain("for attempt in 1 2 3 4 5");
    expect(script).toContain('env.DEPLOYMENT_TARGET !== "staging"');
    expect(script).toContain('env.STRIPE_MODE !== "test"');
    expect(script).toContain('key.startsWith("sk_test_")');
    expect(script).toContain("eligible.length !== 1");
    expect(script).toContain("stripe.webhookEndpoints.update");
    expect(script).not.toContain("stripe.webhookEndpoints.create");
  });

  it("smokes the recovered paid checkout through the authenticated staging endpoint", () => {
    const workflow = source(".github/workflows/staging-deployment.yml");
    const script = source("scripts/staging-authenticated-checkout-smoke.mjs");
    expect(workflow).toContain("Smoke the recovered authenticated checkout journey");
    expect(workflow).toContain("node scripts/staging-authenticated-checkout-smoke.mjs");
    expect(script).toContain('env.DEPLOYMENT_TARGET !== "staging"');
    expect(script).toContain('env.STRIPE_MODE !== "test"');
    expect(script).toContain('new URL("/api/public/billing/checkout-status", baseUrl)');
    expect(script).toContain('summary.billing?.billingStatus !== "active"');
    expect(script).toContain("routeResults");
    expect(script).not.toContain("checkout.sessions.create");
    expect(script).not.toContain("subscriptions.create");
    expect(script).not.toContain("paymentIntents.create");
  });
});
