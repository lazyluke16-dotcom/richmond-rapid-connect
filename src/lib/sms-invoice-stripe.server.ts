import type Stripe from "stripe";

import { assertStripeKeyMatchesMode, getStripe } from "./stripe.server";
import type { SmsInvoiceProvider, SmsInvoiceProviderInput } from "./sms-invoicing.server";

const STAGING_ID_PATTERN = /^staging[-_][a-z0-9][a-z0-9_-]{2,63}$/i;
const PRODUCTION_LIKE = /(^|[-_.])(prod|production|live)([-_.]|$)/i;

export function assertStagingInvoiceEnvironment(env: NodeJS.ProcessEnv = process.env): {
  environmentId: string;
  gstTaxRateId: string;
} {
  const environmentId = env.CERTIFICATION_ENVIRONMENT_ID?.trim() ?? "";
  if (
    env.STAGING_CERTIFICATION_ENABLED !== "true" ||
    env.CERTIFICATION_TARGET !== "staging" ||
    !STAGING_ID_PATTERN.test(environmentId) ||
    PRODUCTION_LIKE.test(environmentId)
  ) {
    throw new Error(
      "SMS invoice provider is disabled: an explicit non-production staging target is required",
    );
  }
  if (env.STRIPE_MODE !== "test") {
    throw new Error("SMS invoice staging certification requires STRIPE_MODE=test");
  }
  const stripeKey = env.STRIPE_SECRET_KEY ?? "";
  if (assertStripeKeyMatchesMode(stripeKey, "test") !== "test") {
    throw new Error("SMS invoice staging certification requires a Stripe test key");
  }
  const gstTaxRateId = env.STRIPE_SMS_GST_TAX_RATE_ID?.trim() ?? "";
  if (!/^txr_[A-Za-z0-9]+$/.test(gstTaxRateId)) {
    throw new Error("STRIPE_SMS_GST_TAX_RATE_ID must identify the staging 10% exclusive GST rate");
  }
  return { environmentId, gstTaxRateId };
}

export class StripeDraftSmsInvoiceProvider implements SmsInvoiceProvider {
  constructor(
    private readonly stripe: Stripe,
    private readonly gstTaxRateId: string,
    private readonly environmentId: string,
  ) {}

  async createDraftInvoice(input: SmsInvoiceProviderInput): Promise<{ invoiceId: string }> {
    if (input.currency !== "AUD" || input.taxRateBps !== 1000) {
      throw new Error("Stripe SMS invoice policy mismatch");
    }

    const metadata = {
      billing_workflow: "text_link_sms",
      sms_invoice_batch_id: input.batchId,
      business_id: input.businessId,
      billing_period_start: input.periodStart,
      billing_period_end: input.periodEnd,
      base_amount_minor: String(input.baseAmountMinor),
      expected_gst_minor: String(input.gstAmountMinor),
      expected_total_minor: String(input.totalAmountMinor),
      certification_environment_id: this.environmentId,
    };
    const invoice = await this.stripe.invoices.create(
      {
        customer: input.customerId,
        currency: "aud",
        collection_method: "charge_automatically",
        auto_advance: false,
        pending_invoice_items_behavior: "exclude",
        default_tax_rates: [this.gstTaxRateId],
        discounts: "",
        description: "Text Link recovery SMS usage",
        metadata,
      },
      { idempotencyKey: `${input.idempotencyKey}:invoice` },
    );
    if (invoice.status !== "draft") {
      throw new Error("Stripe did not return an unfinalized draft invoice");
    }

    const invoiceItem = await this.stripe.invoiceItems.create(
      {
        customer: input.customerId,
        invoice: invoice.id,
        amount: input.baseAmountMinor,
        currency: "aud",
        description: `${input.usageEventIds.length} Text Link recovery SMS`,
        discountable: false,
        tax_behavior: "exclusive",
        tax_rates: [this.gstTaxRateId],
        metadata: {
          ...metadata,
          usage_event_count: String(input.usageEventIds.length),
          provider_sid_count: String(input.providerMessageSids.length),
        },
      },
      { idempotencyKey: `${input.idempotencyKey}:item` },
    );
    if (invoiceItem.invoice !== invoice.id || invoiceItem.amount !== input.baseAmountMinor) {
      throw new Error("Stripe draft invoice item failed audit validation");
    }
    return { invoiceId: invoice.id };
  }
}

export function getStagingStripeSmsInvoiceProvider(
  env: NodeJS.ProcessEnv = process.env,
): StripeDraftSmsInvoiceProvider {
  const { environmentId, gstTaxRateId } = assertStagingInvoiceEnvironment(env);
  return new StripeDraftSmsInvoiceProvider(getStripe(), gstTaxRateId, environmentId);
}
