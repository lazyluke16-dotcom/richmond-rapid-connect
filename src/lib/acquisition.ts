import { z } from "zod";
import { COMMERCIAL_PRICING, platformFeeCents } from "./commercial-pricing";
import { resolveDemoVariant } from "./demo-variants";

export const ACQUISITION_STORAGE_KEY = "rapid-connect:acquisition:v1";
export const ACQUISITION_SAFE_STORAGE_KEY = "rapid-connect:acquisition-safe:v2";
export const ACQUISITION_SESSION_KEY = "rapid-connect:acquisition-session:v1";
export const DEFAULT_PROMO_CODE = "FOUNDINGPLUMBER";

export const AcquisitionPlanSchema = z.enum(["missed_call_recovery", "ai_receptionist", "both"]);
export type AcquisitionPlan = z.infer<typeof AcquisitionPlanSchema>;

export const ACQUISITION_PLANS: Record<
  AcquisitionPlan,
  {
    name: string;
    shortName: string;
    setupFeeCents: number;
    platformFeeCents: number;
    usage: string;
    explanation: string;
    includes: string[];
  }
> = {
  missed_call_recovery: {
    name: "Missed-Call Recovery",
    shortName: "Missed calls",
    setupFeeCents: COMMERCIAL_PRICING.setupFeeCents,
    platformFeeCents: platformFeeCents("missed_call_recovery"),
    usage:
      "27.5¢ including GST per provider-accepted recovery SMS (25¢ excluding GST). Usage starts when activated.",
    explanation:
      "When you miss a call, we immediately text the customer, collect their job details and place the opportunity in your Missed Jobs inbox.",
    includes: [
      "Instant text after a missed call",
      "Does not answer the original call",
      "Captured job in your Missed Jobs inbox",
    ],
  },
  ai_receptionist: {
    name: "AI Receptionist",
    shortName: "AI answers",
    setupFeeCents: COMMERCIAL_PRICING.setupFeeCents,
    platformFeeCents: platformFeeCents("ai_receptionist"),
    usage:
      "A$0.59 including GST per AI voice minute, metered by the second. Usage starts when activated.",
    explanation:
      "Our AI answers the call for you, speaks with the customer, gathers the job details and alerts you—24/7.",
    includes: [
      "Natural 24/7 AI call answering",
      "Urgency, job details and callback capture",
      "Captured job in your Missed Jobs inbox",
    ],
  },
  both: {
    name: "Both services",
    shortName: "Complete cover",
    setupFeeCents: COMMERCIAL_PRICING.setupFeeCents,
    platformFeeCents: platformFeeCents("both"),
    usage:
      "27.5¢ including GST per accepted recovery SMS and A$0.59 including GST per AI voice minute apply from activation.",
    explanation:
      "Use AI Receptionist to answer calls and Missed-Call Recovery as your follow-up path for calls that are still missed.",
    includes: [
      "AI answers configured calls",
      "Missed calls can receive an immediate text follow-up",
      "Every captured opportunity goes to Missed Jobs",
    ],
  },
};

export const AcquisitionEventNameSchema = z.enum([
  "landing_viewed",
  "service_comparison_viewed",
  "roi_calculator_used",
  "demo_started",
  "demo_25",
  "demo_50",
  "demo_75",
  "demo_completed",
  "demo_closed",
  "signup_opened",
  "package_selected",
  "service_selected",
  "promo_validated",
  "wizard_step_viewed",
  "wizard_started",
  "wizard_stage_completed",
  "signup_submitted",
  "account_created",
  "email_confirmation_required",
  "checkout_opened",
  "checkout_started",
  "checkout_completed",
  "checkout_failed",
  "activation_completed",
  "test_job_initiated",
  "test_job_received",
  "first_genuine_job_received",
  "service_card_clicked",
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
  demoVariant: z.enum(["demo-original", "demo-real-world-v2"]).optional().nullable(),
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
  contactEmail: z.string().max(254),
  mobile: z.string().max(40),
  businessPhone: z.string().max(40),
  handlingTiming: z.enum(["missed_calls", "after_hours", "all_calls"]),
  currentArrangement: z.enum(["none", "mobile", "receptionist", "answering_service"]),
  servicesOffered: z.string().trim().max(500).default("General plumbing and emergency repairs"),
  serviceArea: z.string().trim().max(500).default(""),
  businessHours: z.string().trim().max(240).default("Monday to Friday, 8am–5pm"),
  afterHoursPreference: z
    .enum(["collect_and_notify", "urgent_only", "next_business_day"])
    .default("collect_and_notify"),
  customerQuestions: z
    .string()
    .trim()
    .max(1000)
    .default("Job type, suburb, urgency and best callback time"),
  notificationPreference: z.enum(["sms", "email", "both"]).default("sms"),
  licenceNumber: z.string().trim().max(64).default(""),
  licenceState: z.enum(["", "ACT", "NSW", "NT", "QLD", "SA", "TAS", "VIC", "WA"]).default(""),
  demoVariant: z.enum(["demo-original", "demo-real-world-v2"]).default("demo-real-world-v2"),
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

export function calculateAcquisitionRoi(jobValueAud: number, plan: AcquisitionPlan) {
  const normalMonthlySubscriptionAud = ACQUISITION_PLANS[plan].platformFeeCents / 100;
  const valueOfOneJobAud = Math.max(0, Number(jobValueAud) || 0);
  return {
    normalMonthlySubscriptionAud,
    valueOfOneJobAud,
    approximateAmountAheadAud: Math.max(0, valueOfOneJobAud - normalMonthlySubscriptionAud),
    monthsCovered: Math.floor(valueOfOneJobAud / normalMonthlySubscriptionAud),
    excludesUsageCharges: true as const,
  };
}

export function normalBillingDate(from = new Date()): string {
  const target = new Date(from);
  const day = target.getDate();
  target.setDate(1);
  target.setMonth(target.getMonth() + 3);
  const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  target.setDate(Math.min(day, lastDay));
  return new Intl.DateTimeFormat("en-AU", {
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(target);
}

export function acquisitionServiceRows(value: string) {
  const names = value
    .split(/[,\n]+/)
    .map((name) => name.trim())
    .filter(Boolean);
  const unique = [...new Set(names.map((name) => name.toLocaleLowerCase("en-AU")))];
  const keys = new Set<string>();
  return unique.map((lowerName, index) => {
    const baseKey =
      lowerName
        .normalize("NFKD")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 56) || `service-${index + 1}`;
    let serviceKey = baseKey;
    let suffix = 2;
    while (keys.has(serviceKey)) serviceKey = `${baseKey.slice(0, 52)}-${suffix++}`;
    keys.add(serviceKey);
    return {
      service_key: serviceKey,
      display_name: names.find((name) => name.toLocaleLowerCase("en-AU") === lowerName)!,
      active: true,
    };
  });
}

export function acquisitionAreaRows(value: string) {
  return [
    ...new Set(
      value
        .split(/[,\n]+/)
        .map((area) => area.trim())
        .filter(Boolean),
    ),
  ].map((suburb) => ({ suburb, state: "VIC", postcode: null }));
}

export function acquisitionHourRows(value: string) {
  const normalized = value.toLocaleLowerCase("en-AU");
  const allDay = normalized.includes("24/7");
  const saturday = allDay || normalized.includes("saturday") || normalized.includes("every day");
  const sunday = allDay || normalized.includes("every day");
  return Array.from({ length: 7 }, (_, dayOfWeek) => {
    const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
    const open =
      allDay || !isWeekend || (dayOfWeek === 6 && saturday) || (dayOfWeek === 0 && sunday);
    return {
      day_of_week: dayOfWeek,
      closed: !open,
      open_time: open ? (allDay ? "00:00" : "08:00") : null,
      close_time: open ? (allDay ? "23:59" : "17:00") : null,
    };
  });
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
  demoVariant: unknown = "demo-real-world-v2",
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
    contactEmail: "",
    mobile: "",
    businessPhone: "",
    handlingTiming: "missed_calls",
    currentArrangement: "mobile",
    servicesOffered: "General plumbing and emergency repairs",
    serviceArea: "",
    businessHours: "Monday to Friday, 8am–5pm",
    afterHoursPreference: "collect_and_notify",
    customerQuestions: "Job type, suburb, urgency and best callback time",
    notificationPreference: "sms",
    licenceNumber: "",
    licenceState: "",
    demoVariant: resolveDemoVariant(demoVariant),
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

/**
 * Browser storage is deliberately limited to non-identifying campaign choices.
 * Names, email addresses, phone numbers and business details are never restored
 * for an unauthenticated browser. Authenticated resume comes from the signed-in
 * user's server-scoped metadata and business record instead.
 */
export function safeAcquisitionDraftForBrowser(draft: AcquisitionSignupDraft) {
  return {
    version: 2 as const,
    plan: draft.plan,
    promoCode: normalizePromoCode(draft.promoCode),
    attribution: draft.attribution,
    demoVariant: draft.demoVariant,
  };
}

export function readSafeAcquisitionDraft(
  raw: string | null,
  fallback: AcquisitionSignupDraft,
): AcquisitionSignupDraft {
  if (!raw) return fallback;
  try {
    const parsed = z
      .object({
        version: z.literal(2),
        plan: AcquisitionPlanSchema,
        promoCode: z.string().max(64),
        attribution: AcquisitionAttributionSchema,
        demoVariant: z.enum(["demo-original", "demo-real-world-v2"]),
      })
      .safeParse(JSON.parse(raw));
    if (!parsed.success) return fallback;
    return {
      ...fallback,
      plan: parsed.data.plan,
      promoCode: normalizePromoCode(parsed.data.promoCode) || fallback.promoCode,
      attribution: { ...parsed.data.attribution, ...fallback.attribution },
      demoVariant: parsed.data.demoVariant,
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
    services_offered: draft.servicesOffered,
    service_area: draft.serviceArea,
    business_hours: draft.businessHours,
    after_hours_preference: draft.afterHoursPreference,
    customer_questions: draft.customerQuestions,
    notification_preference: draft.notificationPreference,
    business_contact_email: draft.contactEmail.trim(),
    licence_number: draft.licenceNumber,
    licence_state: draft.licenceState,
    acquisition_demo_variant: draft.demoVariant,
  };
}

export function recoverAcquisitionDraftFromUser(
  user: { email?: string | null; user_metadata?: Record<string, unknown> } | null | undefined,
  fallback: AcquisitionSignupDraft,
): AcquisitionSignupDraft | null {
  const metadata = user?.user_metadata;
  const plan = AcquisitionPlanSchema.safeParse(metadata?.acquisition_plan);
  const promoCode = normalizePromoCode(
    typeof metadata?.acquisition_promo_code === "string" ? metadata.acquisition_promo_code : "",
  );
  if (!user || !metadata || !plan.success || !promoCode) return null;

  const value = (key: string, fallbackValue: string) =>
    typeof metadata[key] === "string" ? metadata[key] : fallbackValue;
  const nullableValue = (key: string, fallbackValue: string | null) =>
    typeof metadata[key] === "string" ? metadata[key] : fallbackValue;

  const recovered = AcquisitionSignupDraftSchema.safeParse({
    ...fallback,
    businessName: value("business_name", fallback.businessName),
    firstName: value("first_name", fallback.firstName),
    lastName: value("last_name", fallback.lastName),
    email: user.email ?? fallback.email,
    contactEmail: value("business_contact_email", user.email ?? fallback.contactEmail),
    mobile: value("contact_mobile_e164", fallback.mobile),
    businessPhone: value("business_phone_e164", fallback.businessPhone),
    plan: plan.data,
    promoCode,
    handlingTiming: value("call_handling_timing", fallback.handlingTiming),
    currentArrangement: value("current_answering_arrangement", fallback.currentArrangement),
    servicesOffered: value("services_offered", fallback.servicesOffered),
    serviceArea: value("service_area", fallback.serviceArea),
    businessHours: value("business_hours", fallback.businessHours),
    afterHoursPreference: value("after_hours_preference", fallback.afterHoursPreference),
    customerQuestions: value("customer_questions", fallback.customerQuestions),
    notificationPreference: value("notification_preference", fallback.notificationPreference),
    licenceNumber: value("licence_number", fallback.licenceNumber),
    licenceState: value("licence_state", fallback.licenceState),
    demoVariant: value("acquisition_demo_variant", fallback.demoVariant),
    attribution: {
      source: nullableValue("acquisition_source", fallback.attribution.source),
      medium: nullableValue("acquisition_medium", fallback.attribution.medium),
      campaign: nullableValue("acquisition_campaign", fallback.attribution.campaign),
      content: nullableValue("acquisition_content", fallback.attribution.content),
      referralCode: nullableValue("referral_code", fallback.attribution.referralCode),
    },
  });
  return recovered.success ? recovered.data : null;
}

export function firstIncompleteAcquisitionStep(draft: AcquisitionSignupDraft): number {
  if (
    draft.businessName.trim().length < 2 ||
    draft.firstName.trim().length < 2 ||
    draft.lastName.trim().length < 2 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(draft.email.trim()) ||
    !draft.mobile.trim()
  ) {
    return 1;
  }
  if (!draft.businessPhone.trim() || !draft.serviceArea.trim()) return 2;
  if (!draft.promoCode.trim()) return 3;
  return 4;
}
