import type { SupabaseClient } from "@supabase/supabase-js";

export const SMS_INVOICE_CURRENCY = "AUD";
export const SMS_INVOICE_UNIT_PRICE_MINOR = 25;
export const SMS_INVOICE_GST_RATE_BPS = 1000;

export interface SmsInvoiceLine {
  id: string;
  invoiceBatchId: string;
  businessId: string;
  usageEventId: string;
  providerMessageSid: string;
  usageOccurredAt: string;
  unitPriceMinor: number;
  quantity: number;
  lineAmountMinor: number;
  currency: string;
  carriedForward: boolean;
}

export interface SmsInvoiceBatch {
  id: string;
  businessId: string;
  periodStart: string;
  periodEnd: string;
  currency: string;
  status: "claimed" | "submitting" | "submitted" | "failed" | "void";
  baseAmountMinor: number;
  taxRateBps: number;
  gstAmountMinor: number;
  totalAmountMinor: number;
  providerIdempotencyKey: string;
  providerInvoiceId: string | null;
  claimToken: string | null;
  lines: SmsInvoiceLine[];
}

export type SmsInvoiceClaim =
  | { action: "no_work" }
  | { action: "busy"; batchId: string }
  | { action: "void"; batchId: string }
  | { action: "submitted"; batchId: string; providerInvoiceId: string | null }
  | { action: "submit"; batchId: string; claimToken: string };

export interface SmsInvoiceRepository {
  claimPeriod(input: {
    businessId: string;
    periodStart: string;
    periodEnd: string;
    claimToken: string;
  }): Promise<SmsInvoiceClaim>;
  loadBatch(businessId: string, batchId: string): Promise<SmsInvoiceBatch>;
  getProviderCustomerId(businessId: string): Promise<string | null>;
  beginSubmission(input: {
    businessId: string;
    batchId: string;
    claimToken: string;
    providerCustomerId: string;
  }): Promise<boolean>;
  completeSubmission(input: {
    businessId: string;
    batchId: string;
    claimToken: string;
    providerInvoiceId: string;
  }): Promise<boolean>;
  failSubmission(input: {
    businessId: string;
    batchId: string;
    claimToken: string;
    error: string;
  }): Promise<boolean>;
}

export interface SmsInvoiceProviderInput {
  batchId: string;
  businessId: string;
  customerId: string;
  idempotencyKey: string;
  currency: "AUD";
  periodStart: string;
  periodEnd: string;
  baseAmountMinor: number;
  gstAmountMinor: number;
  totalAmountMinor: number;
  taxRateBps: 1000;
  usageEventIds: string[];
  providerMessageSids: string[];
}

export interface SmsInvoiceProvider {
  /**
   * Creates an unfinalized provider invoice. Implementations must use the
   * supplied idempotency key and must not automatically finalize or charge it.
   */
  createDraftInvoice(input: SmsInvoiceProviderInput): Promise<{ invoiceId: string }>;
}

export type SmsInvoiceProcessResult =
  | { status: "no_work" }
  | { status: "busy"; batchId: string }
  | { status: "void"; batchId: string }
  | { status: "already_submitted"; batchId: string; providerInvoiceId: string | null }
  | { status: "submitted"; batchId: string; providerInvoiceId: string }
  | { status: "failed"; batchId: string; error: string }
  | { status: "reconciliation_required"; batchId: string; providerInvoiceId: string };

export function calculateGstMinor(
  baseAmountMinor: number,
  taxRateBps = SMS_INVOICE_GST_RATE_BPS,
): number {
  if (!Number.isSafeInteger(baseAmountMinor) || baseAmountMinor < 0) {
    throw new Error("SMS invoice base amount must be a non-negative integer");
  }
  if (!Number.isSafeInteger(taxRateBps) || taxRateBps < 0) {
    throw new Error("SMS invoice tax rate must be a non-negative integer");
  }
  return Math.floor((baseAmountMinor * taxRateBps + 5000) / 10000);
}

function assertUtcPeriod(periodStart: string, periodEnd: string): void {
  const start = new Date(periodStart);
  const end = new Date(periodEnd);
  if (
    Number.isNaN(start.getTime()) ||
    Number.isNaN(end.getTime()) ||
    end.getTime() <= start.getTime() ||
    periodStart !== start.toISOString() ||
    periodEnd !== end.toISOString()
  ) {
    throw new Error("SMS invoice periods must be canonical UTC half-open boundaries");
  }
}

function assertBatch(
  batch: SmsInvoiceBatch,
  input: {
    businessId: string;
    periodStart: string;
    periodEnd: string;
    claimToken: string;
  },
): void {
  if (
    batch.businessId !== input.businessId ||
    batch.periodStart !== input.periodStart ||
    batch.periodEnd !== input.periodEnd ||
    batch.claimToken !== input.claimToken
  ) {
    throw new Error("SMS invoice batch identity or tenant boundary mismatch");
  }
  if (batch.currency !== SMS_INVOICE_CURRENCY || batch.taxRateBps !== SMS_INVOICE_GST_RATE_BPS) {
    throw new Error("SMS invoice currency or GST policy mismatch");
  }
  if (!batch.lines.length) throw new Error("SMS invoice batch cannot be empty");

  let baseAmountMinor = 0;
  const usageIds = new Set<string>();
  for (const line of batch.lines) {
    if (
      line.businessId !== batch.businessId ||
      line.invoiceBatchId !== batch.id ||
      line.currency !== SMS_INVOICE_CURRENCY ||
      line.unitPriceMinor !== SMS_INVOICE_UNIT_PRICE_MINOR ||
      line.quantity !== 1 ||
      line.lineAmountMinor !== SMS_INVOICE_UNIT_PRICE_MINOR ||
      !line.providerMessageSid
    ) {
      throw new Error("SMS invoice line failed commercial or tenant validation");
    }
    if (usageIds.has(line.usageEventId)) {
      throw new Error("SMS invoice batch contains a duplicate usage event");
    }
    usageIds.add(line.usageEventId);
    baseAmountMinor += line.lineAmountMinor;
  }
  const gstAmountMinor = calculateGstMinor(baseAmountMinor);
  if (
    batch.baseAmountMinor !== baseAmountMinor ||
    batch.gstAmountMinor !== gstAmountMinor ||
    batch.totalAmountMinor !== baseAmountMinor + gstAmountMinor
  ) {
    throw new Error("SMS invoice batch totals failed integer minor-unit validation");
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "SMS invoice provider failed";
}

export async function processSmsInvoicePeriod(input: {
  businessId: string;
  periodStart: string;
  periodEnd: string;
  repository: SmsInvoiceRepository;
  provider: SmsInvoiceProvider;
  claimToken?: string;
}): Promise<SmsInvoiceProcessResult> {
  assertUtcPeriod(input.periodStart, input.periodEnd);
  const claimToken = input.claimToken ?? crypto.randomUUID();
  const claim = await input.repository.claimPeriod({
    businessId: input.businessId,
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    claimToken,
  });

  if (claim.action === "no_work") return { status: "no_work" };
  if (claim.action === "busy") return { status: "busy", batchId: claim.batchId };
  if (claim.action === "void") return { status: "void", batchId: claim.batchId };
  if (claim.action === "submitted") {
    return {
      status: "already_submitted",
      batchId: claim.batchId,
      providerInvoiceId: claim.providerInvoiceId,
    };
  }

  const batch = await input.repository.loadBatch(input.businessId, claim.batchId);
  assertBatch(batch, {
    businessId: input.businessId,
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    claimToken,
  });

  const customerId = await input.repository.getProviderCustomerId(input.businessId);
  if (!customerId) {
    const message = "SMS invoice tenant has no Stripe customer";
    await input.repository.failSubmission({
      businessId: input.businessId,
      batchId: batch.id,
      claimToken,
      error: message,
    });
    return { status: "failed", batchId: batch.id, error: message };
  }

  const began = await input.repository.beginSubmission({
    businessId: input.businessId,
    batchId: batch.id,
    claimToken,
    providerCustomerId: customerId,
  });
  if (!began) return { status: "busy", batchId: batch.id };

  let providerInvoiceId: string;
  try {
    const providerResult = await input.provider.createDraftInvoice({
      batchId: batch.id,
      businessId: batch.businessId,
      customerId,
      idempotencyKey: batch.providerIdempotencyKey,
      currency: SMS_INVOICE_CURRENCY,
      periodStart: batch.periodStart,
      periodEnd: batch.periodEnd,
      baseAmountMinor: batch.baseAmountMinor,
      gstAmountMinor: batch.gstAmountMinor,
      totalAmountMinor: batch.totalAmountMinor,
      taxRateBps: SMS_INVOICE_GST_RATE_BPS,
      usageEventIds: batch.lines.map((line) => line.usageEventId),
      providerMessageSids: batch.lines.map((line) => line.providerMessageSid),
    });
    providerInvoiceId = providerResult.invoiceId;
    if (!providerInvoiceId) throw new Error("SMS invoice provider returned no invoice ID");
  } catch (error) {
    const message = errorMessage(error);
    await input.repository.failSubmission({
      businessId: input.businessId,
      batchId: batch.id,
      claimToken,
      error: message,
    });
    return { status: "failed", batchId: batch.id, error: message };
  }

  try {
    const completed = await input.repository.completeSubmission({
      businessId: input.businessId,
      batchId: batch.id,
      claimToken,
      providerInvoiceId,
    });
    if (!completed) {
      return { status: "reconciliation_required", batchId: batch.id, providerInvoiceId };
    }
  } catch {
    // The provider accepted an idempotent draft creation, but local
    // persistence is uncertain. Leave the durable claim for stale recovery;
    // a retry uses the same provider idempotency key and cannot double-create.
    return { status: "reconciliation_required", batchId: batch.id, providerInvoiceId };
  }

  return { status: "submitted", batchId: batch.id, providerInvoiceId };
}

interface RpcResult {
  action: SmsInvoiceClaim["action"];
  batchId?: string;
  claimToken?: string;
  providerInvoiceId?: string | null;
}

function requireNoDatabaseError(error: { message?: string } | null, operation: string): void {
  if (error) throw new Error(`${operation}: ${error.message ?? "database error"}`);
}

export class SupabaseSmsInvoiceRepository implements SmsInvoiceRepository {
  constructor(private readonly supabase: SupabaseClient) {}

  async claimPeriod(input: {
    businessId: string;
    periodStart: string;
    periodEnd: string;
    claimToken: string;
  }): Promise<SmsInvoiceClaim> {
    const { data, error } = await this.supabase.rpc("claim_sms_invoice_batch", {
      _business_id: input.businessId,
      _period_start: input.periodStart,
      _period_end: input.periodEnd,
      _claim_token: input.claimToken,
      _lease_seconds: 60,
    });
    requireNoDatabaseError(error, "claim SMS invoice batch");
    const result = data as unknown as RpcResult;
    if (result.action === "no_work") return { action: "no_work" };
    if (!result.batchId) throw new Error("SMS invoice claim returned no batch ID");
    if (result.action === "busy") return { action: "busy", batchId: result.batchId };
    if (result.action === "void") return { action: "void", batchId: result.batchId };
    if (result.action === "submitted") {
      return {
        action: "submitted",
        batchId: result.batchId,
        providerInvoiceId: result.providerInvoiceId ?? null,
      };
    }
    if (result.action !== "submit" || result.claimToken !== input.claimToken) {
      throw new Error("SMS invoice claim returned an invalid state");
    }
    return { action: "submit", batchId: result.batchId, claimToken: input.claimToken };
  }

  async loadBatch(businessId: string, batchId: string): Promise<SmsInvoiceBatch> {
    const { data: batchData, error: batchError } = await this.supabase
      .from("sms_invoice_batches")
      .select(
        "id,business_id,period_start,period_end,currency,status,base_amount_minor,tax_rate_bps,gst_amount_minor,total_amount_minor,provider_idempotency_key,provider_invoice_id,claim_token",
      )
      .eq("id", batchId)
      .eq("business_id", businessId)
      .single();
    requireNoDatabaseError(batchError, "load SMS invoice batch");

    const { data: lineData, error: lineError } = await this.supabase
      .from("sms_invoice_lines")
      .select(
        "id,invoice_batch_id,business_id,usage_event_id,provider_message_sid,usage_occurred_at,unit_price_minor,quantity,line_amount_minor,currency,carried_forward",
      )
      .eq("invoice_batch_id", batchId)
      .eq("business_id", businessId)
      .order("usage_occurred_at", { ascending: true })
      .order("usage_event_id", { ascending: true });
    requireNoDatabaseError(lineError, "load SMS invoice lines");

    const row = batchData as Record<string, unknown>;
    const lines = (lineData as Record<string, unknown>[]).map((line) => ({
      id: String(line.id),
      invoiceBatchId: String(line.invoice_batch_id),
      businessId: String(line.business_id),
      usageEventId: String(line.usage_event_id),
      providerMessageSid: String(line.provider_message_sid),
      usageOccurredAt: String(line.usage_occurred_at),
      unitPriceMinor: Number(line.unit_price_minor),
      quantity: Number(line.quantity),
      lineAmountMinor: Number(line.line_amount_minor),
      currency: String(line.currency),
      carriedForward: Boolean(line.carried_forward),
    }));
    return {
      id: String(row.id),
      businessId: String(row.business_id),
      periodStart: String(row.period_start),
      periodEnd: String(row.period_end),
      currency: String(row.currency),
      status: String(row.status) as SmsInvoiceBatch["status"],
      baseAmountMinor: Number(row.base_amount_minor),
      taxRateBps: Number(row.tax_rate_bps),
      gstAmountMinor: Number(row.gst_amount_minor),
      totalAmountMinor: Number(row.total_amount_minor),
      providerIdempotencyKey: String(row.provider_idempotency_key),
      providerInvoiceId: row.provider_invoice_id ? String(row.provider_invoice_id) : null,
      claimToken: row.claim_token ? String(row.claim_token) : null,
      lines,
    };
  }

  async getProviderCustomerId(businessId: string): Promise<string | null> {
    const { data, error } = await this.supabase
      .from("business_billing")
      .select("stripe_customer_id")
      .eq("business_id", businessId)
      .maybeSingle();
    requireNoDatabaseError(error, "load SMS invoice customer");
    const customerId = (data as { stripe_customer_id?: string | null } | null)?.stripe_customer_id;
    return customerId || null;
  }

  async beginSubmission(input: {
    businessId: string;
    batchId: string;
    claimToken: string;
    providerCustomerId: string;
  }): Promise<boolean> {
    const { data, error } = await this.supabase.rpc("begin_sms_invoice_submission", {
      _business_id: input.businessId,
      _batch_id: input.batchId,
      _claim_token: input.claimToken,
      _provider_customer_id: input.providerCustomerId,
      _lease_seconds: 120,
    });
    requireNoDatabaseError(error, "begin SMS invoice submission");
    return data === true;
  }

  async completeSubmission(input: {
    businessId: string;
    batchId: string;
    claimToken: string;
    providerInvoiceId: string;
  }): Promise<boolean> {
    const { data, error } = await this.supabase.rpc("complete_sms_invoice_submission", {
      _business_id: input.businessId,
      _batch_id: input.batchId,
      _claim_token: input.claimToken,
      _provider_invoice_id: input.providerInvoiceId,
    });
    requireNoDatabaseError(error, "complete SMS invoice submission");
    return data === true;
  }

  async failSubmission(input: {
    businessId: string;
    batchId: string;
    claimToken: string;
    error: string;
  }): Promise<boolean> {
    const { data, error } = await this.supabase.rpc("fail_sms_invoice_submission", {
      _business_id: input.businessId,
      _batch_id: input.batchId,
      _claim_token: input.claimToken,
      _error_message: input.error,
    });
    requireNoDatabaseError(error, "fail SMS invoice submission");
    return data === true;
  }
}
