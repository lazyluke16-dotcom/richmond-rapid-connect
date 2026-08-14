import { describe, expect, it, vi } from "vitest";

import {
  assertStagingInvoiceEnvironment,
  StripeDraftSmsInvoiceProvider,
} from "../sms-invoice-stripe.server";
import {
  calculateGstMinor,
  processSmsInvoicePeriod,
  type SmsInvoiceBatch,
  type SmsInvoiceClaim,
  type SmsInvoiceProvider,
  type SmsInvoiceProviderInput,
  type SmsInvoiceRepository,
} from "../sms-invoicing.server";

const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TENANT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const JAN_START = "2026-01-01T00:00:00.000Z";
const FEB_START = "2026-02-01T00:00:00.000Z";
const MAR_START = "2026-03-01T00:00:00.000Z";

interface FakeUsage {
  id: string;
  businessId: string;
  createdAt: string;
  usageType: string;
  provider: string;
  providerMessageSid: string;
  billable: boolean;
  unitPriceMinor: number;
  chargeMinor: number;
  currency: string;
  workflow: string;
  taxBehavior: string;
  billingCollection: string;
}

function acceptedSms(id: string, createdAt: string, businessId = TENANT_A): FakeUsage {
  return {
    id,
    businessId,
    createdAt,
    usageType: "outbound_sms",
    provider: "twilio",
    providerMessageSid: `SM${id.padStart(8, "0")}`,
    billable: true,
    unitPriceMinor: 25,
    chargeMinor: 25,
    currency: "AUD",
    workflow: "text_link",
    taxBehavior: "exclusive",
    billingCollection: "invoice_aggregation",
  };
}

class FakeInvoiceRepository implements SmsInvoiceRepository {
  readonly usage: FakeUsage[] = [];
  readonly batches = new Map<string, SmsInvoiceBatch>();
  readonly customers = new Map([
    [TENANT_A, "cus_tenant_a"],
    [TENANT_B, "cus_tenant_b"],
  ]);
  private readonly usageClaims = new Set<string>();
  private readonly periods = new Map<string, string>();
  throwOnCompleteOnce = false;
  completeAttempts = 0;

  constructor(usage: FakeUsage[] = []) {
    this.usage.push(...usage);
  }

  async claimPeriod(input: {
    businessId: string;
    periodStart: string;
    periodEnd: string;
    claimToken: string;
  }): Promise<SmsInvoiceClaim> {
    const periodKey = `${input.businessId}|${input.periodStart}|${input.periodEnd}`;
    const existingId = this.periods.get(periodKey);
    if (existingId) {
      const existing = this.batches.get(existingId)!;
      if (existing.status === "submitted") {
        return {
          action: "submitted",
          batchId: existing.id,
          providerInvoiceId: existing.providerInvoiceId,
        };
      }
      if (existing.status === "void") return { action: "void", batchId: existing.id };
      if (existing.status === "claimed" || existing.status === "submitting") {
        return { action: "busy", batchId: existing.id };
      }
      existing.status = "claimed";
      existing.claimToken = input.claimToken;
      return { action: "submit", batchId: existing.id, claimToken: input.claimToken };
    }

    const eligible = this.usage
      .filter(
        (event) =>
          event.businessId === input.businessId &&
          event.createdAt < input.periodEnd &&
          event.usageType === "outbound_sms" &&
          event.provider === "twilio" &&
          event.billable &&
          event.unitPriceMinor === 25 &&
          event.chargeMinor === 25 &&
          event.currency === "AUD" &&
          event.workflow === "text_link" &&
          event.taxBehavior === "exclusive" &&
          event.billingCollection === "invoice_aggregation" &&
          event.providerMessageSid &&
          !this.usageClaims.has(event.id),
      )
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    if (!eligible.length) return { action: "no_work" };

    const id = `batch-${this.batches.size + 1}`;
    for (const event of eligible) this.usageClaims.add(event.id);
    const baseAmountMinor = eligible.length * 25;
    const gstAmountMinor = calculateGstMinor(baseAmountMinor);
    const batch: SmsInvoiceBatch = {
      id,
      businessId: input.businessId,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      currency: "AUD",
      status: "claimed",
      baseAmountMinor,
      taxRateBps: 1000,
      gstAmountMinor,
      totalAmountMinor: baseAmountMinor + gstAmountMinor,
      providerIdempotencyKey: `sms-invoice:${id}`,
      providerInvoiceId: null,
      claimToken: input.claimToken,
      lines: eligible.map((event, index) => ({
        id: `${id}-line-${index + 1}`,
        invoiceBatchId: id,
        businessId: input.businessId,
        usageEventId: event.id,
        providerMessageSid: event.providerMessageSid,
        usageOccurredAt: event.createdAt,
        unitPriceMinor: 25,
        quantity: 1,
        lineAmountMinor: 25,
        currency: "AUD",
        carriedForward: event.createdAt < input.periodStart,
      })),
    };
    this.batches.set(id, batch);
    this.periods.set(periodKey, id);
    return { action: "submit", batchId: id, claimToken: input.claimToken };
  }

  async loadBatch(businessId: string, batchId: string): Promise<SmsInvoiceBatch> {
    const batch = this.batches.get(batchId);
    if (!batch || batch.businessId !== businessId) throw new Error("batch not found");
    return structuredClone(batch);
  }

  async getProviderCustomerId(businessId: string): Promise<string | null> {
    return this.customers.get(businessId) ?? null;
  }

  async beginSubmission(input: {
    businessId: string;
    batchId: string;
    claimToken: string;
    providerCustomerId: string;
  }): Promise<boolean> {
    const batch = this.batches.get(input.batchId);
    if (
      !batch ||
      batch.businessId !== input.businessId ||
      batch.claimToken !== input.claimToken ||
      batch.status !== "claimed" ||
      !input.providerCustomerId
    ) {
      return false;
    }
    batch.status = "submitting";
    return true;
  }

  async completeSubmission(input: {
    businessId: string;
    batchId: string;
    claimToken: string;
    providerInvoiceId: string;
  }): Promise<boolean> {
    this.completeAttempts += 1;
    if (this.throwOnCompleteOnce) {
      this.throwOnCompleteOnce = false;
      throw new Error("simulated persistence interruption");
    }
    const batch = this.batches.get(input.batchId);
    if (
      !batch ||
      batch.businessId !== input.businessId ||
      batch.claimToken !== input.claimToken ||
      batch.status !== "submitting"
    ) {
      return false;
    }
    batch.status = "submitted";
    batch.providerInvoiceId = input.providerInvoiceId;
    batch.claimToken = null;
    return true;
  }

  async failSubmission(input: {
    businessId: string;
    batchId: string;
    claimToken: string;
    error: string;
  }): Promise<boolean> {
    const batch = this.batches.get(input.batchId);
    if (
      !batch ||
      batch.businessId !== input.businessId ||
      batch.claimToken !== input.claimToken ||
      !input.error
    ) {
      return false;
    }
    batch.status = "failed";
    batch.claimToken = null;
    return true;
  }

  expireClaim(batchId: string): void {
    const batch = this.batches.get(batchId)!;
    batch.status = "failed";
    batch.claimToken = null;
  }
}

class IdempotentFakeInvoiceProvider implements SmsInvoiceProvider {
  readonly calls: SmsInvoiceProviderInput[] = [];
  readonly providerInvoices = new Map<string, string>();
  failNext = false;

  async createDraftInvoice(input: SmsInvoiceProviderInput): Promise<{ invoiceId: string }> {
    this.calls.push(structuredClone(input));
    if (this.failNext) {
      this.failNext = false;
      throw new Error("simulated provider failure");
    }
    let invoiceId = this.providerInvoices.get(input.idempotencyKey);
    if (!invoiceId) {
      invoiceId = `in_test_${this.providerInvoices.size + 1}`;
      this.providerInvoices.set(input.idempotencyKey, invoiceId);
    }
    return { invoiceId };
  }
}

function process(
  repository: FakeInvoiceRepository,
  provider: IdempotentFakeInvoiceProvider,
  overrides: Partial<{ businessId: string; periodStart: string; periodEnd: string }> = {},
) {
  return processSmsInvoicePeriod({
    businessId: overrides.businessId ?? TENANT_A,
    periodStart: overrides.periodStart ?? JAN_START,
    periodEnd: overrides.periodEnd ?? FEB_START,
    repository,
    provider,
  });
}

describe("commercial Text Link SMS invoice aggregation", () => {
  it("invoices one accepted SMS as 25 cents ex-GST with GST applied once", async () => {
    const repository = new FakeInvoiceRepository([acceptedSms("1", "2026-01-10T00:00:00.000Z")]);
    const provider = new IdempotentFakeInvoiceProvider();

    const result = await process(repository, provider);

    expect(result.status).toBe("submitted");
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]).toMatchObject({
      businessId: TENANT_A,
      customerId: "cus_tenant_a",
      currency: "AUD",
      baseAmountMinor: 25,
      gstAmountMinor: 3,
      totalAmountMinor: 28,
      taxRateBps: 1000,
      providerMessageSids: ["SM00000001"],
    });
  });

  it("aggregates four accepted messages as exactly 100 cents and 10 cents GST", async () => {
    const repository = new FakeInvoiceRepository(
      [1, 2, 3, 4].map((id) => acceptedSms(String(id), `2026-01-${id + 10}T00:00:00.000Z`)),
    );
    const provider = new IdempotentFakeInvoiceProvider();

    await process(repository, provider);

    expect(provider.calls[0].baseAmountMinor).toBe(100);
    expect(provider.calls[0].gstAmountMinor).toBe(10);
    expect(provider.calls[0].totalAmountMinor).toBe(110);
    expect(provider.calls[0].usageEventIds).toHaveLength(4);
  });

  it("allows only one worker to submit a period and one usage event", async () => {
    const repository = new FakeInvoiceRepository([acceptedSms("1", "2026-01-10T00:00:00.000Z")]);
    const provider = new IdempotentFakeInvoiceProvider();

    const results = await Promise.all([
      process(repository, provider),
      process(repository, provider),
      process(repository, provider),
    ]);

    expect(results.filter((result) => result.status === "submitted")).toHaveLength(1);
    expect(provider.calls).toHaveLength(1);
    expect(provider.providerInvoices).toHaveLength(1);
    expect([...repository.batches.values()][0].lines).toHaveLength(1);
  });

  it("retries a failed provider call using the frozen batch and idempotency key", async () => {
    const repository = new FakeInvoiceRepository([acceptedSms("1", "2026-01-10T00:00:00.000Z")]);
    const provider = new IdempotentFakeInvoiceProvider();
    provider.failNext = true;

    expect((await process(repository, provider)).status).toBe("failed");
    expect((await process(repository, provider)).status).toBe("submitted");
    expect(provider.calls).toHaveLength(2);
    expect(provider.calls[0].idempotencyKey).toBe(provider.calls[1].idempotencyKey);
    expect(provider.providerInvoices).toHaveLength(1);
  });

  it("recovers a post-provider persistence interruption without a second invoice or charge", async () => {
    const repository = new FakeInvoiceRepository([acceptedSms("1", "2026-01-10T00:00:00.000Z")]);
    repository.throwOnCompleteOnce = true;
    const provider = new IdempotentFakeInvoiceProvider();

    const interrupted = await process(repository, provider);
    expect(interrupted.status).toBe("reconciliation_required");
    if (interrupted.status !== "reconciliation_required") {
      throw new Error("expected reconciliation-required outcome");
    }
    repository.expireClaim(interrupted.batchId);
    const recovered = await process(repository, provider);

    expect(recovered.status).toBe("submitted");
    expect(provider.calls).toHaveLength(2);
    expect(provider.providerInvoices).toHaveLength(1);
    expect(provider.calls[0].idempotencyKey).toBe(provider.calls[1].idempotencyKey);
    expect([...repository.batches.values()][0].lines).toHaveLength(1);
  });

  it("uses a deterministic half-open cutoff and carries late eligible usage forward", async () => {
    const repository = new FakeInvoiceRepository([
      acceptedSms("jan", "2026-01-15T00:00:00.000Z"),
      acceptedSms("cutoff", FEB_START),
    ]);
    const provider = new IdempotentFakeInvoiceProvider();

    await process(repository, provider);
    expect(provider.calls[0].usageEventIds).toEqual(["jan"]);
    repository.usage.push(acceptedSms("late", "2025-12-20T00:00:00.000Z"));

    await process(repository, provider, { periodStart: FEB_START, periodEnd: MAR_START });
    expect(provider.calls[1].usageEventIds).toEqual(["late", "cutoff"]);
    const secondBatch = [...repository.batches.values()][1];
    expect(secondBatch.lines.find((line) => line.usageEventId === "late")?.carriedForward).toBe(
      true,
    );
    expect(secondBatch.lines.find((line) => line.usageEventId === "cutoff")?.carriedForward).toBe(
      false,
    );
  });

  it("cannot aggregate another tenant's accepted SMS", async () => {
    const repository = new FakeInvoiceRepository([
      acceptedSms("a", "2026-01-10T00:00:00.000Z", TENANT_A),
      acceptedSms("b", "2026-01-11T00:00:00.000Z", TENANT_B),
    ]);
    const provider = new IdempotentFakeInvoiceProvider();

    await process(repository, provider);

    expect(provider.calls[0].businessId).toBe(TENANT_A);
    expect(provider.calls[0].usageEventIds).toEqual(["a"]);
    expect(provider.calls[0].providerMessageSids).toEqual(["SM0000000a"]);
  });

  it("rejects a corrupted cross-tenant line before calling the provider", async () => {
    const repository = new FakeInvoiceRepository([acceptedSms("1", "2026-01-10T00:00:00.000Z")]);
    const originalLoad = repository.loadBatch.bind(repository);
    repository.loadBatch = async (businessId, batchId) => {
      const batch = await originalLoad(businessId, batchId);
      batch.lines[0].businessId = TENANT_B;
      return batch;
    };
    const provider = new IdempotentFakeInvoiceProvider();

    await expect(process(repository, provider)).rejects.toThrow("tenant validation");
    expect(provider.calls).toHaveLength(0);
  });

  it("does not invoice rejected, uncertain, invalid, Off, AI, voice, or lead outcomes", async () => {
    const rejected = { ...acceptedSms("rejected", "2026-01-10T00:00:00.000Z"), billable: false };
    const uncertain = {
      ...acceptedSms("uncertain", "2026-01-11T00:00:00.000Z"),
      billingCollection: "reconciliation_required",
    };
    const off = {
      ...acceptedSms("off", "2026-01-12T00:00:00.000Z"),
      workflow: "off",
    };
    const ai = {
      ...acceptedSms("ai", "2026-01-13T00:00:00.000Z"),
      workflow: "ai_receptionist",
    };
    const voice = {
      ...acceptedSms("voice", "2026-01-14T00:00:00.000Z"),
      usageType: "ai_voice_seconds",
      provider: "vapi",
    };
    const lead = {
      ...acceptedSms("lead", "2026-01-15T00:00:00.000Z"),
      usageType: "ai_lead",
      provider: "vapi",
    };
    const repository = new FakeInvoiceRepository([rejected, uncertain, off, ai, voice, lead]);
    const provider = new IdempotentFakeInvoiceProvider();

    expect((await process(repository, provider)).status).toBe("no_work");
    expect(provider.calls).toHaveLength(0);
  });

  it("charges a reconciliation-confirmed acceptance once and remains chargeable if undelivered", async () => {
    const repository = new FakeInvoiceRepository();
    const provider = new IdempotentFakeInvoiceProvider();
    expect((await process(repository, provider)).status).toBe("no_work");

    const reconciled = acceptedSms("reconciled", "2026-01-10T00:00:00.000Z");
    repository.usage.push(reconciled);
    expect((await process(repository, provider)).status).toBe("submitted");
    // A later provider delivery status does not mutate or reverse the accepted
    // immutable usage event.
    expect((await process(repository, provider)).status).toBe("already_submitted");
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0].providerMessageSids).toEqual(["SMreconciled"]);
  });

  it("fails safely before the provider when the tenant has no Stripe customer", async () => {
    const repository = new FakeInvoiceRepository([acceptedSms("1", "2026-01-10T00:00:00.000Z")]);
    repository.customers.delete(TENANT_A);
    const provider = new IdempotentFakeInvoiceProvider();

    const result = await process(repository, provider);

    expect(result.status).toBe("failed");
    expect(provider.calls).toHaveLength(0);
  });
});

describe("Stripe staging draft boundary", () => {
  it("rejects live or production-like Stripe invoice targets", () => {
    expect(() =>
      assertStagingInvoiceEnvironment({
        STAGING_CERTIFICATION_ENABLED: "true",
        CERTIFICATION_TARGET: "staging",
        CERTIFICATION_ENVIRONMENT_ID: "staging-production",
        STRIPE_MODE: "live",
        STRIPE_SECRET_KEY: "sk_live_XXXXXXXX",
        STRIPE_SMS_GST_TAX_RATE_ID: "txr_live_gst",
      }),
    ).toThrow("non-production staging target");
  });

  it("accepts only an explicit staging target with a Stripe test key and GST rate", () => {
    expect(
      assertStagingInvoiceEnvironment({
        STAGING_CERTIFICATION_ENABLED: "true",
        CERTIFICATION_TARGET: "staging",
        CERTIFICATION_ENVIRONMENT_ID: "staging-commercial-rc",
        STRIPE_MODE: "test",
        STRIPE_SECRET_KEY: "sk_test_XXXXXXXX",
        STRIPE_SMS_GST_TAX_RATE_ID: "txr_TESTGST",
      }),
    ).toEqual({
      environmentId: "staging-commercial-rc",
      gstTaxRateId: "txr_TESTGST",
    });
  });

  it("creates one unfinalized base item with exclusive GST and never finalizes or charges", async () => {
    const invoicesCreate = vi.fn().mockResolvedValue({ id: "in_test_123", status: "draft" });
    const invoiceItemsCreate = vi.fn().mockResolvedValue({
      id: "ii_test_123",
      invoice: "in_test_123",
      amount: 100,
    });
    const stripe = {
      invoices: { create: invoicesCreate, finalizeInvoice: vi.fn(), pay: vi.fn() },
      invoiceItems: { create: invoiceItemsCreate },
    };
    const provider = new StripeDraftSmsInvoiceProvider(
      stripe as never,
      "txr_test_gst",
      "staging-commercial-rc",
    );

    const result = await provider.createDraftInvoice({
      batchId: "batch-1",
      businessId: TENANT_A,
      customerId: "cus_test_a",
      idempotencyKey: "sms-invoice:batch-1",
      currency: "AUD",
      periodStart: JAN_START,
      periodEnd: FEB_START,
      baseAmountMinor: 100,
      gstAmountMinor: 10,
      totalAmountMinor: 110,
      taxRateBps: 1000,
      usageEventIds: ["usage-1", "usage-2", "usage-3", "usage-4"],
      providerMessageSids: ["SM1", "SM2", "SM3", "SM4"],
    });

    expect(result.invoiceId).toBe("in_test_123");
    expect(invoicesCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        customer: "cus_test_a",
        auto_advance: false,
        default_tax_rates: ["txr_test_gst"],
        discounts: "",
      }),
      { idempotencyKey: "sms-invoice:batch-1:invoice" },
    );
    expect(invoiceItemsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        invoice: "in_test_123",
        amount: 100,
        currency: "aud",
        tax_behavior: "exclusive",
        tax_rates: ["txr_test_gst"],
        discountable: false,
      }),
      { idempotencyKey: "sms-invoice:batch-1:item" },
    );
    expect(stripe.invoices.finalizeInvoice).not.toHaveBeenCalled();
    expect(stripe.invoices.pay).not.toHaveBeenCalled();
  });
});
