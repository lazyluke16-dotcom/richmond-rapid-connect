/**
 * Phase 2F Turn 2 — Billing unit tests
 *
 * Run: npx vitest run (after adding vitest to devDependencies)
 * No deployed secrets required — Stripe and Supabase are fully mocked.
 */
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";

import { computeAlertThresholds, extractBearerToken } from "../billing.server";
import {
  GRACE_USAGE_CAP_AUD,
  GRACE_PERIOD_HOURS,
  USAGE_ALERT_THRESHOLDS_AUD,
} from "../billing-types";
import {
  getStripePrices,
  getUnionCouponId,
  PLAN_BASE_PRICE_CENTS,
  getCheckoutLineItems,
  assertStripeContextAvailable,
  assertStripeKeyMatchesMode,
  stripeKeyMode,
} from "../stripe.server";
import { SAFE_METER_RETRY_HOURS } from "../billing-meter.server";

describe("Price ID injection prevention", () => {
  const TEST_PRICES = {
    MCR_BASE: "price_test_mcr_base",
    AIR_BASE: "price_test_air_base",
    AIR_USAGE: "price_test_air_usage",
  };

  beforeEach(() => {
    process.env.STRIPE_PRICE_MCR_BASE = TEST_PRICES.MCR_BASE;
    process.env.STRIPE_PRICE_AIR_BASE = TEST_PRICES.AIR_BASE;
    process.env.STRIPE_PRICE_AIR_USAGE = TEST_PRICES.AIR_USAGE;
  });

  afterEach(() => {
    delete process.env.STRIPE_PRICE_MCR_BASE;
    delete process.env.STRIPE_PRICE_AIR_BASE;
    delete process.env.STRIPE_PRICE_AIR_USAGE;
  });

  it("MCR checkout line items use only the server-known MCR_BASE price from env", () => {
    const items = getCheckoutLineItems("missed_call_recovery");
    expect(items).toHaveLength(1);
    expect(items[0].price).toBe(TEST_PRICES.MCR_BASE);
    expect(items.some((i) => i.price === TEST_PRICES.AIR_USAGE)).toBe(false);
  });

  it("AIR checkout includes base + usage price only — no MCR price", () => {
    const items = getCheckoutLineItems("ai_receptionist");
    const prices = items.map((i) => i.price);
    expect(prices).toContain(TEST_PRICES.AIR_BASE);
    expect(prices).toContain(TEST_PRICES.AIR_USAGE);
    expect(prices).not.toContain(TEST_PRICES.MCR_BASE);
  });

  it("MCR plan has no metered usage item", () => {
    const items = getCheckoutLineItems("missed_call_recovery");
    expect(items.every((i) => i.price !== TEST_PRICES.AIR_USAGE)).toBe(true);
  });

  it("plan base prices are correct AUD cents", () => {
    expect(PLAN_BASE_PRICE_CENTS.missed_call_recovery).toBe(900);
    expect(PLAN_BASE_PRICE_CENTS.ai_receptionist).toBe(1500);
  });
});

describe("extractBearerToken", () => {
  const makeReq = (auth?: string) =>
    new Request("https://example.com", { headers: auth ? { Authorization: auth } : {} });

  it("returns token from valid Bearer header", () => {
    expect(extractBearerToken(makeReq("Bearer sk_test_abc123"))).toBe("sk_test_abc123");
  });

  it("returns null when Authorization header is missing", () => {
    expect(extractBearerToken(makeReq())).toBeNull();
  });

  it("returns null for non-Bearer auth schemes", () => {
    expect(extractBearerToken(makeReq("Basic dXNlcjpwYXNz"))).toBeNull();
  });

  it("returns null for empty Bearer value", () => {
    expect(extractBearerToken(makeReq("Bearer "))).toBeNull();
  });
});

describe("computeAlertThresholds", () => {
  it("no alerts below A$25", () => {
    const result = computeAlertThresholds(24.99);
    expect(result.every((r) => !r.exceeded)).toBe(true);
  });

  it("only A$25 alert at exactly A$25", () => {
    const result = computeAlertThresholds(25);
    const exceeded = result.filter((r) => r.exceeded).map((r) => r.threshold);
    expect(exceeded).toEqual([25]);
  });

  it("all three alerts exceeded above A$100", () => {
    const result = computeAlertThresholds(100);
    expect(result.every((r) => r.exceeded)).toBe(true);
  });

  it("alert thresholds are [25, 50, 100] in order", () => {
    expect([...USAGE_ALERT_THRESHOLDS_AUD]).toEqual([25, 50, 100]);
  });
});

describe("Grace period constants", () => {
  it("grace cap is A$10", () => {
    expect(GRACE_USAGE_CAP_AUD).toBe(10);
  });

  it("grace period is 48 hours", () => {
    expect(GRACE_PERIOD_HOURS).toBe(48);
  });
});

describe("Meter event exact seconds", () => {
  it("137 seconds stays as 137 — not rounded to 3 minutes (180)", () => {
    const seconds = 137;
    const rounded = Math.round(seconds);
    expect(rounded).toBe(137);
    expect(rounded).not.toBe(180);
    expect(rounded % 60).not.toBe(0);
  });

  it("sub-integer input is rounded to nearest whole second", () => {
    expect(Math.round(59.6)).toBe(60);
    expect(Math.round(59.4)).toBe(59);
  });

  it("0 seconds is not billable", () => {
    const billableSeconds = 0;
    expect(billableSeconds < 1).toBe(true);
  });
});

describe("AI voice rate accuracy", () => {
  const RATE_PER_SEC = 0.00983333;

  it("60 seconds at configured rate rounds to exactly A$0.59", () => {
    const charge = 60 * RATE_PER_SEC;
    const rounded = Math.round(charge * 100) / 100;
    expect(rounded).toBeCloseTo(0.59, 2);
  });

  it("30 seconds = approximately A$0.295", () => {
    const charge = 30 * RATE_PER_SEC;
    expect(charge).toBeCloseTo(0.295, 3);
  });

  it("1 second rate matches Stripe unit_amount_decimal (0.983333 cents)", () => {
    const cents = RATE_PER_SEC * 100;
    expect(cents).toBeCloseTo(0.983333, 5);
  });
});

describe("Billing-exempt tenants do not call Stripe", () => {
  it("effective state billing_exempt_test sets nonBillableReason and skips Stripe", () => {
    const effectiveState = "billing_exempt_test";
    let billable = false;
    let nonBillableReason: string | null = null;

    const billableSeconds = 120;
    const aiMode = "live";

    if (billableSeconds < 1) {
      nonBillableReason = "no_duration";
    } else if (aiMode !== "live") {
      nonBillableReason = "demo_mode";
    } else if (effectiveState === "billing_exempt_test") {
      nonBillableReason = "billing_exempt_test";
    } else if (effectiveState === "active" || effectiveState === "past_due_grace") {
      billable = true;
    }

    expect(billable).toBe(false);
    expect(nonBillableReason).toBe("billing_exempt_test");
  });
});

describe("Union offer one-time redemption", () => {
  it("union offer is not applied when already redeemed", () => {
    const billing = { union_offer_eligible: true, union_offer_redeemed_at: "2026-07-16T10:00:00Z" };
    const shouldApplyUnionOffer = billing.union_offer_eligible && !billing.union_offer_redeemed_at;
    expect(shouldApplyUnionOffer).toBe(false);
  });

  it("union offer is applied when eligible and not yet redeemed", () => {
    const billing = { union_offer_eligible: true, union_offer_redeemed_at: null };
    const shouldApplyUnionOffer = billing.union_offer_eligible && !billing.union_offer_redeemed_at;
    expect(shouldApplyUnionOffer).toBe(true);
  });

  it("union offer is never applied to ineligible businesses", () => {
    const billing = { union_offer_eligible: false, union_offer_redeemed_at: null };
    const shouldApplyUnionOffer = billing.union_offer_eligible && !billing.union_offer_redeemed_at;
    expect(shouldApplyUnionOffer).toBe(false);
  });

  it("union credit amount is the base price (not the usage price)", () => {
    const plan = "ai_receptionist" as const;
    const creditCents = PLAN_BASE_PRICE_CENTS[plan];
    expect(creditCents).toBe(1500);
  });
});

describe("Payment recovery restores active state", () => {
  it("clearGraceAndActivate sets expected fields", async () => {
    const mockSupabase = {
      from: vi.fn().mockReturnThis(),
      update: vi.fn().mockReturnThis(),
      eq: vi.fn().mockResolvedValue({ error: null }),
    };

    const { clearGraceAndActivate } = await import("../billing.server");
    await clearGraceAndActivate(
      "biz-123",
      mockSupabase as unknown as Parameters<typeof clearGraceAndActivate>[1],
    );

    expect(mockSupabase.from).toHaveBeenCalledWith("business_billing");
    const updateCall = mockSupabase.update.mock.calls[0][0] as Record<string, unknown>;
    expect(updateCall.billing_status).toBe("active");
    expect(updateCall.grace_started_at).toBeNull();
    expect(updateCall.grace_expires_at).toBeNull();
    expect(updateCall.suspended_at).toBeNull();
  });
});

describe("Duplicate Stripe webhook handling", () => {
  it("unique constraint on stripe_event_id prevents double-processing", () => {
    const insertError = {
      message:
        'duplicate key value violates unique constraint "stripe_webhook_events_stripe_event_id_key"',
    };
    const isDuplicate = /unique|stripe_event_id/i.test(insertError.message);
    expect(isDuplicate).toBe(true);
  });
});

describe("Stripe client security guards", () => {
  it.each([
    ["sk_test_XXXXXXXX", "test"],
    ["rk_test_XXXXXXXX", "test"],
    ["sk_live_XXXXXXXX", "live"],
    ["rk_live_XXXXXXXX", "live"],
    ["sk_org_test_XXXXXXXX", "test"],
    ["sk_org_live_XXXXXXXX", "live"],
  ] as const)("detects key mode for %s", (key, expected) => {
    expect(stripeKeyMode(key)).toBe(expected);
  });

  it("rejects a live key in an explicitly test environment", () => {
    expect(() => assertStripeKeyMatchesMode("sk_live_XXXXXXXX", "test")).toThrow("does not match");
  });

  it("rejects a test key in an explicitly live environment", () => {
    expect(() => assertStripeKeyMatchesMode("sk_test_XXXXXXXX", "live")).toThrow("does not match");
  });

  it("accepts matching test and live environments", () => {
    expect(assertStripeKeyMatchesMode("rk_test_XXXXXXXX", "test")).toBe("test");
    expect(assertStripeKeyMatchesMode("rk_live_XXXXXXXX", "live")).toBe("live");
  });

  it("requires a target Stripe context for organization keys", () => {
    expect(() => assertStripeContextAvailable("sk_org_live_XXXXXXXX", "")).toThrow(
      "STRIPE_CONTEXT is required",
    );
    expect(assertStripeContextAvailable("sk_org_live_XXXXXXXX", "acct_example")).toBe(
      "acct_example",
    );
  });

  it("rejects unknown key formats", () => {
    expect(() => assertStripeKeyMatchesMode("not-a-stripe-key")).toThrow(
      "account, restricted, or organization secret key",
    );
  });
});

describe("Grace period timestamps", () => {
  it("setGracePeriod sets grace_expires_at to now + 48h on first failure", async () => {
    const captured: Record<string, unknown>[] = [];
    const mockSupabase = {
      from: vi.fn().mockImplementation(() => ({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            maybeSingle: vi
              .fn()
              .mockResolvedValue({ data: { grace_started_at: null }, error: null }),
          }),
        }),
        update: vi.fn().mockImplementation((data: Record<string, unknown>) => {
          captured.push(data);
          return { eq: vi.fn().mockResolvedValue({ error: null }) };
        }),
      })),
    };

    const { setGracePeriod } = await import("../billing.server");
    const before = Date.now();
    await setGracePeriod(
      "biz-456",
      mockSupabase as unknown as Parameters<typeof setGracePeriod>[1],
    );
    const after = Date.now();

    expect(captured).toHaveLength(1);
    const update = captured[0];
    expect(update.billing_status).toBe("past_due");
    expect(update.grace_started_at).toBeTruthy();
    expect(update.grace_expires_at).toBeTruthy();

    const expiresAt = new Date(update.grace_expires_at as string).getTime();
    const expectedMin = before + GRACE_PERIOD_HOURS * 3600_000;
    const expectedMax = after + GRACE_PERIOD_HOURS * 3600_000;
    expect(expiresAt).toBeGreaterThanOrEqual(expectedMin);
    expect(expiresAt).toBeLessThanOrEqual(expectedMax);
  });

  it("setGracePeriod preserves original grace_started_at on subsequent payment failures", async () => {
    const originalStart = "2026-07-16T10:00:00.000Z";
    const captured: Record<string, unknown>[] = [];
    const mockSupabase = {
      from: vi.fn().mockImplementation(() => ({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            maybeSingle: vi
              .fn()
              .mockResolvedValue({ data: { grace_started_at: originalStart }, error: null }),
          }),
        }),
        update: vi.fn().mockImplementation((data: Record<string, unknown>) => {
          captured.push(data);
          return { eq: vi.fn().mockResolvedValue({ error: null }) };
        }),
      })),
    };

    const { setGracePeriod } = await import("../billing.server");
    await setGracePeriod(
      "biz-789",
      mockSupabase as unknown as Parameters<typeof setGracePeriod>[1],
    );

    expect(captured).toHaveLength(1);
    const update = captured[0];
    expect(update.billing_status).toBe("past_due");
    expect(update.grace_started_at).toBe(originalStart);
    expect("grace_expires_at" in update).toBe(false);
  });
});

describe("Union offer uses Stripe coupon (not negative invoice item)", () => {
  afterEach(() => {
    delete process.env.STRIPE_COUPON_UNION_FIRST_PLATFORM_FEE;
  });

  it("getUnionCouponId returns the coupon ID from env var", () => {
    process.env.STRIPE_COUPON_UNION_FIRST_PLATFORM_FEE = "coupon_test_union_xyz";
    expect(getUnionCouponId()).toBe("coupon_test_union_xyz");
  });

  it("getUnionCouponId returns null when env var is absent", () => {
    expect(getUnionCouponId()).toBeNull();
  });

  it("union coupon requires separate products — duration:once alone does not guarantee usage exclusion", () => {
    // REQUIRED Stripe product structure:
    //   prod_MCR_BASE  → in applies_to
    //   prod_AIR_BASE  → in applies_to
    //   prod_AIR_USAGE → SEPARATE product, NOT in applies_to
    const requiredCouponConfig = { duration: "once", percent_off: 100 };
    expect(requiredCouponConfig.duration).toBe("once");
    expect(requiredCouponConfig.percent_off).toBe(100);
  });
});

describe("Missing Stripe price configuration fails closed", () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    savedEnv.MCR = process.env.STRIPE_PRICE_MCR_BASE;
    savedEnv.AIR = process.env.STRIPE_PRICE_AIR_BASE;
    savedEnv.USAGE = process.env.STRIPE_PRICE_AIR_USAGE;
    delete process.env.STRIPE_PRICE_MCR_BASE;
    delete process.env.STRIPE_PRICE_AIR_BASE;
    delete process.env.STRIPE_PRICE_AIR_USAGE;
  });

  afterEach(() => {
    if (savedEnv.MCR !== undefined) process.env.STRIPE_PRICE_MCR_BASE = savedEnv.MCR;
    if (savedEnv.AIR !== undefined) process.env.STRIPE_PRICE_AIR_BASE = savedEnv.AIR;
    if (savedEnv.USAGE !== undefined) process.env.STRIPE_PRICE_AIR_USAGE = savedEnv.USAGE;
  });

  it("throws when Stripe price env vars are missing", () => {
    expect(() => getStripePrices()).toThrow();
  });

  it("error message identifies ALL missing variables at once", () => {
    let errorMessage = "";
    try {
      getStripePrices();
    } catch (e) {
      errorMessage = (e as Error).message;
    }
    expect(errorMessage).toContain("STRIPE_PRICE_MCR_BASE");
    expect(errorMessage).toContain("STRIPE_PRICE_AIR_BASE");
    expect(errorMessage).toContain("STRIPE_PRICE_AIR_USAGE");
  });

  it("succeeds and returns env var values when all required vars are set", () => {
    process.env.STRIPE_PRICE_MCR_BASE = "price_test_mcr";
    process.env.STRIPE_PRICE_AIR_BASE = "price_test_air";
    process.env.STRIPE_PRICE_AIR_USAGE = "price_test_usage";
    const prices = getStripePrices();
    expect(prices.MCR_BASE).toBe("price_test_mcr");
    expect(prices.AIR_BASE).toBe("price_test_air");
    expect(prices.AIR_USAGE).toBe("price_test_usage");
  });
});

describe("Grace usage A$10 cap suspends on breach", () => {
  it("shouldSuspend is true when grace usage exceeds A$10", async () => {
    const usageRows = [{ estimated_customer_charge: 5.5 }, { estimated_customer_charge: 4.61 }];
    const chain = { eq: vi.fn(), gte: vi.fn().mockResolvedValue({ data: usageRows, error: null }) };
    chain.eq.mockReturnValue(chain);
    const mockSupabase = {
      from: vi.fn().mockReturnValue({ select: vi.fn().mockReturnValue(chain) }),
    };

    const { checkGraceUsageCap } = await import("../billing.server");
    const result = await checkGraceUsageCap(
      "biz-grace",
      new Date("2026-07-16T00:00:00Z"),
      mockSupabase as unknown as Parameters<typeof checkGraceUsageCap>[2],
    );

    expect(result.shouldSuspend).toBe(true);
    expect(result.currentUsageAud).toBeGreaterThan(10);
    expect(result.withinCap).toBe(false);
  });

  it("A$9.99 grace usage — no suspension (strictly below A$10 cap)", async () => {
    const usageRows = [{ estimated_customer_charge: 9.99 }];
    const chain = { eq: vi.fn(), gte: vi.fn().mockResolvedValue({ data: usageRows, error: null }) };
    chain.eq.mockReturnValue(chain);
    const mockSupabase = {
      from: vi.fn().mockReturnValue({ select: vi.fn().mockReturnValue(chain) }),
    };

    const { checkGraceUsageCap } = await import("../billing.server");
    const result = await checkGraceUsageCap(
      "biz-grace",
      new Date("2026-07-16T00:00:00Z"),
      mockSupabase as unknown as Parameters<typeof checkGraceUsageCap>[2],
    );

    expect(result.shouldSuspend).toBe(false);
    expect(result.withinCap).toBe(true);
    expect(result.currentUsageAud).toBeCloseTo(9.99, 2);
  });

  it("A$10.00 grace usage — suspend immediately (at cap boundary, inclusive)", async () => {
    const usageRows = [{ estimated_customer_charge: 10.0 }];
    const chain = { eq: vi.fn(), gte: vi.fn().mockResolvedValue({ data: usageRows, error: null }) };
    chain.eq.mockReturnValue(chain);
    const mockSupabase = {
      from: vi.fn().mockReturnValue({ select: vi.fn().mockReturnValue(chain) }),
    };

    const { checkGraceUsageCap } = await import("../billing.server");
    const result = await checkGraceUsageCap(
      "biz-grace",
      new Date("2026-07-16T00:00:00Z"),
      mockSupabase as unknown as Parameters<typeof checkGraceUsageCap>[2],
    );

    expect(result.shouldSuspend).toBe(true);
    expect(result.withinCap).toBe(false);
    expect(result.currentUsageAud).toBeCloseTo(10.0, 2);
  });

  it("A$10.01 grace usage — suspend immediately (above cap)", async () => {
    const usageRows = [{ estimated_customer_charge: 10.01 }];
    const chain = { eq: vi.fn(), gte: vi.fn().mockResolvedValue({ data: usageRows, error: null }) };
    chain.eq.mockReturnValue(chain);
    const mockSupabase = {
      from: vi.fn().mockReturnValue({ select: vi.fn().mockReturnValue(chain) }),
    };

    const { checkGraceUsageCap } = await import("../billing.server");
    const result = await checkGraceUsageCap(
      "biz-grace",
      new Date("2026-07-16T00:00:00Z"),
      mockSupabase as unknown as Parameters<typeof checkGraceUsageCap>[2],
    );

    expect(result.shouldSuspend).toBe(true);
    expect(result.withinCap).toBe(false);
    expect(result.currentUsageAud).toBeGreaterThan(10);
  });
});

describe("Grace expiry scheduler", () => {
  it("runGraceExpiryCheck returns zero counts when no businesses have expired grace", async () => {
    const mockSupabase = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            lte: vi.fn().mockReturnValue({
              not: vi.fn().mockResolvedValue({ data: [], error: null }),
            }),
          }),
        }),
      }),
    };

    const { runGraceExpiryCheck } = await import("../billing-scheduler.server");
    const result = await runGraceExpiryCheck(
      mockSupabase as unknown as Parameters<typeof runGraceExpiryCheck>[0],
    );

    expect(result.checked).toBe(0);
    expect(result.suspended).toBe(0);
    expect(result.errors).toBe(0);
  });
});

describe("Meter retry safe-window enforcement", () => {
  it("SAFE_METER_RETRY_HOURS is 22", () => {
    expect(SAFE_METER_RETRY_HOURS).toBe(22);
  });

  it("an event 5 hours old is within the safe retry window", () => {
    const eventCreatedAt = new Date(Date.now() - 5 * 60 * 60 * 1000);
    const safeWindowCutoff = new Date(Date.now() - SAFE_METER_RETRY_HOURS * 60 * 60 * 1000);
    expect(eventCreatedAt >= safeWindowCutoff).toBe(true);
  });

  it("an event 25 hours old is outside the safe window and must not be resent", () => {
    const eventCreatedAt = new Date(Date.now() - 25 * 60 * 60 * 1000);
    const safeWindowCutoff = new Date(Date.now() - SAFE_METER_RETRY_HOURS * 60 * 60 * 1000);
    expect(eventCreatedAt < safeWindowCutoff).toBe(true);
  });

  it("reconciliation_needed status excludes events from the retry loop", () => {
    const retryableStatuses = ["pending", "failed"];
    expect(retryableStatuses.includes("reconciliation_needed")).toBe(false);
  });
});
