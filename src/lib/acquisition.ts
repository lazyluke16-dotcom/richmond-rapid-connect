import { z } from "zod";

export const ACQUISITION_STORAGE_KEY = "rapid-connect:acquisition:v1";
export const ACQUISITION_SESSION_KEY = "rapid-connect:acquisition-session:v1";
export const DEFAULT_PROMO_CODE = "FOUNDINGPLUMBER";

export const AcquisitionPlanSchema = z.enum(["missed_call_recovery", "ai_receptionist"]);
export type AcquisitionPlan = z.infer<typeof AcquisitionPlanSchema>;

export const ACQUISITION_PLANS: Record<
  AcquisitionPlan,
  {
    name: string;
    shortName: string;
    setupFeeCents: number;
    platformFeeCents: number;
    usage: string;
    includes: string[];
  }
> = {
  missed_call_recovery: {
    name: "Text Receptionist",
    shortName: "Text",
    setupFeeCents: 49_900,
    platformFeeCents: 900,
    usage: "A$0.25 ex GST per accepted recovery SMS",
    includes: [
      "Instant text after a missed call",
      "Branded job questionnaire",
      "Complete lead summary in your dashboard",
    ],
  },
  ai_receptionist: {
    name: "Text + AI Receptionist",
    shortName: "Text + AI",
    setupFeeCents: 119_900,
    platformFeeCents: 1_500,
    usage: "A$0.59 per AI voice minute + SMS usage",
    includes: [
      "Everything in Text Receptionist",
      "Natural 24/7 AI call answering",
      "Urgency, job details and callback capture",
    ],
  },
};

export const AcquisitionEventNameSchema = z.enum([
  "landing_viewed",
  "demo_started",
  "demo_25",
  "demo_50",
  "demo_75",
  "demo_completed",
  "demo_closed",
  "signup_opened",
  "package_selected",
  "promo_validated",
  "wizard_step_viewed",
  "signup_submitted",
  "account_created",
  "email_confirmation_required",
  "checkout_opened",
  "checkout_failed",
]);
export type AcquisitionEventName = z.infer<typeof AcquisitionEventNameSchema>;

const OptionalShortText = z
  .string()
  .trim()
  .max(120)
  .optional()
  .nullable()
  .transform((value) => value || null);

export const AcquisitionAttributionSchema = z.object({
  source: OptionalShortText,
  medium: OptionalShortText,
  campaign: OptionalShortText,
  content: OptionalShortText,
  referralCode: OptionalShortText,
});
export type AcquisitionAttribution = z.infer<typeof AcquisitionAttributionSchema>;

export const AcquisitionEventSchema = z.object({
  action: z.literal("track"),
  eventId: z.string().uuid(),
  sessionId: z.string().uuid(),
  eventName: AcquisitionEventNameSchema,
  path: z.string().trim().max(240).default("/plumbers"),
  plan: AcquisitionPlanSchema.optional().nullable(),
  promoCode: z.string().trim().max(64).optional().nullable(),
  wizardStep: z.number().int().min(0).max(6).optional().nullable(),
  attribution: AcquisitionAttributionSchema,
});

export const PromoValidationRequestSchema = z.object({
  action: z.literal("validate_promo"),
  code: z.string().trim().min(1).max(64),
  plan: AcquisitionPlanSchema,
});

export const AcquisitionSignupDraftSchema = z.object({
  version: z.literal(1),
  step: z.number().int().min(0).max(5),
  plan: AcquisitionPlanSchema,
  promoCode: z.string().trim().max(64),
  businessName: z.string().max(120),
  firstName: z.string().max(80),
  lastName: z.string().max(80),
  email: z.string().max(254),
  mobile: z.string().max(40),
  businessPhone: z.string().max(40),
  handlingTiming: z.enum(["missed_calls", "after_hours", "all_calls"]),
  currentArrangement: z.enum(["none", "mobile", "receptionist", "answering_service"]),
  attribution: AcquisitionAttributionSchema,
});
export type AcquisitionSignupDraft = z.infer<typeof AcquisitionSignupDraftSchema>;

export function normalizePromoCode(value: string): string {
  return value
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_-]/g, "")
    .slice(0, 64);
}

export function moneyFromCents(cents: number): string {
  return new Intl.NumberFormat("en-AU", {
    style: "currency",
    currency: "AUD",
    maximumFractionDigits: cents % 100 === 0 ? 0 : 2,
  }).format(cents / 100);
}

export function getAcquisitionAttribution(search: URLSearchParams): AcquisitionAttribution {
  return AcquisitionAttributionSchema.parse({
    source: search.get("source") ?? search.get("utm_source"),
    medium: search.get("medium") ?? search.get("utm_medium"),
    campaign: search.get("campaign") ?? search.get("utm_campaign"),
    content: search.get("content") ?? search.get("utm_content"),
    referralCode: search.get("ref"),
  });
}

export function createDefaultAcquisitionDraft(
  attribution: AcquisitionAttribution,
  promoCode = DEFAULT_PROMO_CODE,
): AcquisitionSignupDraft {
  return {
    version: 1,
    step: 0,
    plan: "missed_call_recovery",
    promoCode: normalizePromoCode(promoCode),
    businessName: "",
    firstName: "",
    lastName: "",
    email: "",
    mobile: "",
    businessPhone: "",
    handlingTiming: "missed_calls",
    currentArrangement: "mobile",
    attribution,
  };
}

export function readAcquisitionDraft(
  raw: string | null,
  fallback: AcquisitionSignupDraft,
): AcquisitionSignupDraft {
  if (!raw) return fallback;
  try {
    const parsed = AcquisitionSignupDraftSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return fallback;
    return {
      ...parsed.data,
      attribution: {
        ...parsed.data.attribution,
        ...Object.fromEntries(
          Object.entries(fallback.attribution).filter(([, value]) => Boolean(value)),
        ),
      },
      promoCode: fallback.promoCode || parsed.data.promoCode,
    };
  } catch {
    return fallback;
  }
}

export function acquisitionUserMetadata(draft: AcquisitionSignupDraft) {
  return {
    first_name: draft.firstName.trim(),
    last_name: draft.lastName.trim(),
    business_name: draft.businessName.trim(),
    business_phone_e164: draft.businessPhone,
    contact_mobile_e164: draft.mobile,
    acquisition_plan: draft.plan,
    acquisition_promo_code: normalizePromoCode(draft.promoCode),
    acquisition_source: draft.attribution.source,
    acquisition_medium: draft.attribution.medium,
    acquisition_campaign: draft.attribution.campaign,
    acquisition_content: draft.attribution.content,
    referral_code: draft.attribution.referralCode,
    call_handling_timing: draft.handlingTiming,
    current_answering_arrangement: draft.currentArrangement,
  };
}
