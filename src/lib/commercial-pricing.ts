import type { AcquisitionPlan } from "./acquisition";

export const COMMERCIAL_PRICING = {
  currency: "AUD",
  gstRatePercent: 10,
  gstRateBps: 1_000,
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
      platformTaxBehavior: "inclusive" as const,
      usage: {
        unit: "accepted recovery SMS" as const,
        unitPriceCents: 25,
        unitPriceExGstCents: 25,
        unitPriceIncGstCents: 27.5,
        taxBehavior: "exclusive" as const,
      },
    },
    ai_receptionist: {
      platformFeeCents: 1_500,
      platformTaxBehavior: "inclusive" as const,
      usage: {
        unit: "AI voice minute" as const,
        unitPriceCents: 59,
        meteredPer: "second" as const,
        taxBehavior: "inclusive" as const,
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
    lines.push(
      "27.5¢ including GST per provider-accepted recovery SMS (25¢ excluding GST + 2.5¢ GST).",
    );
  }
  if (plan === "ai_receptionist" || plan === "both") {
    lines.push("A$0.59 including GST per AI voice minute, metered to the nearest second.");
  }
  return lines;
}

export function usageWorkedExample(plan: AcquisitionPlan): string {
  if (plan === "missed_call_recovery") {
    return "Example: 20 accepted recovery SMS messages cost A$5.50 including GST (A$5.00 excluding GST + A$0.50 GST).";
  }
  if (plan === "ai_receptionist") {
    return "Example: 10 AI call minutes cost A$5.90 including GST.";
  }
  return "Example: 20 accepted recovery SMS messages plus 10 AI call minutes cost A$11.40 including GST (A$5.50 SMS + A$5.90 voice).";
}

export const COMMERCIAL_RATE_SOURCES = {
  platform:
    "Stripe staging inclusive Prices and billing_config: missed_call_base_monthly_aud / ai_receptionist_base_monthly_aud",
  sms: "billing_config and the SMS invoice ledger: A$0.25 excluding GST, 10% GST, A$0.275 including GST",
  ai: "billing_config ai_voice_per_minute_aud=0.59 and the inclusive Stripe metered-seconds Price",
  other:
    "billing_usage_events permits only outbound_sms and ai_voice_seconds; no separate model, phone-number, or inbound-call customer rate is implemented",
} as const;
