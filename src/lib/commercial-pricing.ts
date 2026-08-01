import type { AcquisitionPlan } from "./acquisition";

export const COMMERCIAL_PRICING = {
  currency: "AUD",
  gstRatePercent: 10,
  setupFeeCents: 49_900,
  foundingOffer: {
    code: "FOUNDINGPLUMBER",
    freePlatformBillingPeriods: 3,
    setupFeeCents: 0,
    usageStarts: "activation" as const,
  },
  services: {
    missed_call_recovery: {
      platformFeeCents: 900,
      usage: {
        unit: "accepted recovery SMS" as const,
        unitPriceCents: 25,
        taxBehavior: "exclusive" as const,
      },
    },
    ai_receptionist: {
      platformFeeCents: 1_500,
      usage: {
        unit: "AI voice minute" as const,
        unitPriceCents: 59,
        meteredPer: "second" as const,
        taxBehavior: "stripe-price" as const,
      },
    },
  },
} as const;

export function platformFeeCents(plan: AcquisitionPlan): number {
  if (plan === "both") {
    return (
      COMMERCIAL_PRICING.services.missed_call_recovery.platformFeeCents +
      COMMERCIAL_PRICING.services.ai_receptionist.platformFeeCents
    );
  }
  return COMMERCIAL_PRICING.services[plan].platformFeeCents;
}

export function usageRateLines(plan: AcquisitionPlan): string[] {
  const lines: string[] = [];
  if (plan === "missed_call_recovery" || plan === "both") {
    lines.push("A$0.25 excluding GST for each recovery SMS accepted by the messaging provider.");
  }
  if (plan === "ai_receptionist" || plan === "both") {
    lines.push("A$0.59 per AI voice minute, metered to the nearest second.");
  }
  return lines;
}

export function usageWorkedExample(plan: AcquisitionPlan): string {
  if (plan === "missed_call_recovery") {
    return "Example: 20 accepted recovery SMS messages cost A$5.00 plus A$0.50 GST.";
  }
  if (plan === "ai_receptionist") {
    return "Example: 10 AI call minutes cost A$5.90 before any tax shown by Stripe.";
  }
  return "Example: 20 accepted recovery SMS messages plus 10 AI call minutes cost A$10.90 before applicable tax (A$5.00 SMS subtotal plus A$5.90 voice).";
}

export const COMMERCIAL_RATE_SOURCES = {
  platform:
    "Stripe staging base prices and billing_config: missed_call_base_monthly_aud / ai_receptionist_base_monthly_aud",
  sms: "20260727120000_text_link_sms_billable.sql (25 AUD cents, tax_behavior exclusive)",
  ai: "billing_config ai_voice_per_minute_aud=0.59 and Stripe metered seconds price",
  other:
    "billing_usage_events permits only outbound_sms and ai_voice_seconds; no separate model, phone-number, or inbound-call customer rate is implemented",
} as const;
