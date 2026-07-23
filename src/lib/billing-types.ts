export type BillingStatus =
  | 'setup'
  | 'checkout_pending'
  | 'active'
  | 'past_due'
  | 'suspended'
  | 'canceled';

export type EffectiveBillingState =
  | 'unknown'
  | 'suspended'
  | 'billing_exempt_test'
  | 'setup'
  | 'canceled'
  | 'past_due_grace'
  | 'checkout_pending'
  | 'active';

export type SelectedPlan = 'missed_call_recovery' | 'ai_receptionist';

// Alert thresholds (AUD). Never expose Vapi wholesale cost in UI.
export const USAGE_ALERT_THRESHOLDS_AUD = [25, 50, 100] as const;
export type UsageAlertThreshold = (typeof USAGE_ALERT_THRESHOLDS_AUD)[number];

export const GRACE_PERIOD_HOURS = 48;
export const GRACE_USAGE_CAP_AUD = 10;
export const DEFAULT_MONTHLY_USAGE_CAP_AUD = 100;

export interface BillingStateSummary {
  businessId: string;
  selectedPlan: SelectedPlan | null;
  billingStatus: BillingStatus;
  effectiveState: EffectiveBillingState;
  billingExempt: boolean;
  unionOfferEligible: boolean;
  unionOfferRedeemedAt: string | null;
  platformFeeWaiverEndsAt: string | null;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  graceExpiresAt: string | null;
  hasStripeCustomer: boolean;
  hasStripeSubscription: boolean;
}

export interface UsageSummary {
  periodStart: string | null;
  totalBillableSeconds: number;
  estimatedChargeAud: number;
  pendingMeterEvents: number;
  alertThresholds: {
    threshold: UsageAlertThreshold;
    exceeded: boolean;
  }[];
  withinGraceCap: boolean;
}

export interface BillingDetailResponse {
  billing: BillingStateSummary;
  usage: UsageSummary;
  platformFeeAud: number;
}