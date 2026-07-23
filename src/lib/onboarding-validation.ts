/**
 * Phase 2G.1 — Pure validation helpers for the onboarding wizard.
 *
 * Schemas are zod-based so both the browser and the server can enforce
 * the same rules; the server treats these as authoritative and never
 * trusts client-side validation.
 */
import { z } from "zod";

/** 8 wizard steps: Business, Branding, Services, Areas, Hours, Plan, Website, Finish. */
export const ONBOARDING_STEP_MIN = 0;
export const ONBOARDING_STEP_MAX = 7;

export const OnboardingStepSchema = z
  .number()
  .int()
  .min(ONBOARDING_STEP_MIN)
  .max(ONBOARDING_STEP_MAX);

/** Clamp any incoming value into the allowed step range. */
export function clampOnboardingStep(input: unknown): number {
  const n = typeof input === "number" ? input : Number(input);
  if (!Number.isFinite(n)) return ONBOARDING_STEP_MIN;
  const i = Math.trunc(n);
  if (i < ONBOARDING_STEP_MIN) return ONBOARDING_STEP_MIN;
  if (i > ONBOARDING_STEP_MAX) return ONBOARDING_STEP_MAX;
  return i;
}

/**
 * Derive the resume step from what the server has already persisted.
 * The wizard advances forwards only, so the derived step is the highest
 * step whose predecessor has saved data on the server.
 *
 * Inputs are the *presence* of persisted data, not the values themselves —
 * callers pass counts / booleans, not raw rows.
 */
export interface OnboardingProgressInput {
  hasBusiness: boolean;
  servicesCount: number;
  areasCount: number;
  hoursCount: number;
  hasPlan: boolean;
  hasWebsiteCopy: boolean;
  completed: boolean;
}

export interface OnboardingReadinessInput {
  businessName?: string | null;
  servicesCount: number;
  areasCount: number;
  hoursCount: number;
  selectedPlan?: string | null;
  heroHeading?: string | null;
  heroSubheading?: string | null;
}

/**
 * Return every mandatory first-customer onboarding gate that is still missing.
 * The server uses this immediately before activation; the browser must never be
 * the authority for deciding that onboarding is complete.
 */
export function getOnboardingReadinessFailures(input: OnboardingReadinessInput): string[] {
  const failures: string[] = [];
  if ((input.businessName ?? "").trim().length < 2) failures.push("business profile");
  if (input.servicesCount < 1) failures.push("at least one service");
  if (input.areasCount < 1) failures.push("at least one service area");
  if (input.hoursCount < 1) failures.push("business hours");
  if (!["missed_call_recovery", "ai_receptionist"].includes(input.selectedPlan ?? "")) {
    failures.push("a valid plan");
  }
  if ((input.heroHeading ?? "").trim().length < 2) failures.push("website headline");
  if ((input.heroSubheading ?? "").trim().length < 2) failures.push("website description");
  return failures;
}
export function deriveOnboardingStep(p: OnboardingProgressInput): number {
  if (p.completed) return ONBOARDING_STEP_MAX;
  if (!p.hasBusiness) return 0;
  // Step 1 = branding — always reachable once business exists.
  let step = 1;
  if (p.servicesCount > 0)
    step = 3; // services saved -> areas next
  else if (step < 2) step = 2; // branding saved implicitly by business creation
  if (p.areasCount > 0) step = Math.max(step, 4);
  if (p.hoursCount > 0) step = Math.max(step, 5);
  if (p.hasPlan) step = Math.max(step, 6);
  if (p.hasWebsiteCopy) step = Math.max(step, 7);
  return clampOnboardingStep(step);
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export const ServiceInputSchema = z.object({
  service_key: z
    .string()
    .trim()
    .min(1, "service_key required")
    .max(64)
    .regex(/^[a-z0-9_-]+$/i, "service_key must be alphanumeric/underscore/hyphen"),
  display_name: z.string().trim().min(1).max(120),
  active: z.boolean().optional(),
});
export const ServicesPayloadSchema = z.object({
  services: z.array(ServiceInputSchema).max(64),
});

export const AreaInputSchema = z.object({
  suburb: z.string().trim().min(1).max(120),
  state: z.string().trim().max(16).nullable().optional(),
  postcode: z.string().trim().max(16).nullable().optional(),
});
export const AreasPayloadSchema = z.object({
  areas: z.array(AreaInputSchema).max(256),
});

export const HourRowSchema = z
  .object({
    day_of_week: z.number().int().min(0).max(6),
    closed: z.boolean(),
    open_time: z.string().regex(HHMM).nullable().optional(),
    close_time: z.string().regex(HHMM).nullable().optional(),
  })
  .refine(
    (r) =>
      r.closed ||
      (typeof r.open_time === "string" &&
        typeof r.close_time === "string" &&
        r.open_time < r.close_time),
    { message: "open_time must be before close_time when the day is open" },
  );
export const HoursPayloadSchema = z.object({
  hours: z.array(HourRowSchema).max(7),
});

export const PlanPayloadSchema = z.object({
  plan: z.enum(["missed_call_recovery", "ai_receptionist"]),
});

export type ServicesPayload = z.infer<typeof ServicesPayloadSchema>;
export type AreasPayload = z.infer<typeof AreasPayloadSchema>;
export type HoursPayload = z.infer<typeof HoursPayloadSchema>;
export type PlanPayload = z.infer<typeof PlanPayloadSchema>;

// -----------------------------------------------------------------------
// Phase 1 — service coverage (base location + travel radius + region labels)
// -----------------------------------------------------------------------
// Primary coverage entry replaces suburb-by-suburb selection. Broad
// Melbourne region labels are free-form strings so we never invent an
// authoritative region mapping. Postcode ranges accept optional 4-digit
// ranges like "3000-3199"; single postcodes ("3000") are also allowed.

const POSTCODE_RANGE = /^\d{3,5}(-\d{3,5})?$/;

export const CoveragePayloadSchema = z.object({
  base_suburb: z.string().trim().max(120).nullable().optional(),
  base_state: z.string().trim().max(16).nullable().optional(),
  base_postcode: z
    .string()
    .trim()
    .max(16)
    .regex(/^\d{3,5}$/, "postcode must be numeric")
    .nullable()
    .optional()
    .or(z.literal("").transform(() => null)),
  travel_radius_km: z.number().int().min(0).max(500).nullable().optional(),
  region_labels: z.array(z.string().trim().min(1).max(80)).max(32).optional(),
  postcode_ranges: z
    .array(z.string().trim().regex(POSTCODE_RANGE, "expected e.g. 3000 or 3000-3199"))
    .max(64)
    .optional(),
  excluded_areas: z.array(z.string().trim().min(1).max(120)).max(128).optional(),
});
export type CoveragePayload = z.infer<typeof CoveragePayloadSchema>;

// -----------------------------------------------------------------------
// Phase 1 — Business Profile licence fields
// -----------------------------------------------------------------------
// No external verification is performed here. `licence_public` controls
// whether the values render on the tenant's public site; the toggle
// defaults to false and must be respected on every public surface.

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export const LicencePayloadSchema = z.object({
  licence_number: z.string().trim().max(64).nullable().optional(),
  licence_holder_name: z.string().trim().max(120).nullable().optional(),
  licence_expiry: z
    .string()
    .regex(ISO_DATE, "expected YYYY-MM-DD")
    .nullable()
    .optional()
    .or(z.literal("").transform(() => null)),
  licence_public: z.boolean().optional(),
});
export type LicencePayload = z.infer<typeof LicencePayloadSchema>;

// -----------------------------------------------------------------------
// Phase 1 — tenant-aware home link for authenticated app shell.
// -----------------------------------------------------------------------
// Requirement 1: the top-left logo/company link on authenticated pages
// must go to the caller's own valid public site if one exists, otherwise
// their own dashboard — never another tenant's site (in particular never
// the shared "/" Richmond public landing when the viewer belongs to a
// different tenant). This helper is pure so it can be unit tested and
// reused by AppShell without pulling in supabase or router types.

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/;
export function isValidTenantSlug(slug: unknown): slug is string {
  return typeof slug === "string" && SLUG_RE.test(slug);
}

export type LogoLinkTarget =
  | { kind: "public"; to: "/" }
  | { kind: "tenant-public"; to: "/b/$slug"; slug: string }
  | { kind: "dashboard"; to: "/dashboard" };

/**
 * Resolve the destination for the top-left brand link.
 *
 * - `authenticated=false` → always the shared public landing ("/").
 * - `authenticated=true` + valid tenant slug → that tenant's public site.
 * - `authenticated=true` without a valid slug → the caller's own dashboard.
 *
 * We never route an authenticated caller to "/" because that page is the
 * shared Richmond public landing and must not be presented as "your site"
 * to any other tenant.
 */
export function resolveLogoLink(input: {
  authenticated: boolean;
  tenantSlug?: string | null;
}): LogoLinkTarget {
  if (!input.authenticated) return { kind: "public", to: "/" };
  if (isValidTenantSlug(input.tenantSlug)) {
    return { kind: "tenant-public", to: "/b/$slug", slug: input.tenantSlug };
  }
  return { kind: "dashboard", to: "/dashboard" };
}
