import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  ServicesPayloadSchema,
  AreasPayloadSchema,
  HoursPayloadSchema,
  PlanPayloadSchema,
  getOnboardingReadinessFailures,
  OnboardingStepSchema,
  deriveOnboardingStep,
  ONBOARDING_STEP_MAX,
} from "./onboarding-validation";

export interface OnboardingStatus {
  hasBusiness: boolean;
  onboarding_completed: boolean;
  business_id: string | null;
  slug: string | null;
  name: string | null;
  /** Server-derived resume step, bounded to [0, 7]. */
  step: number;
}

/**
 * Detect the specific "column onboarding_step does not exist" error surfaced
 * by PostgREST before the pending migration has been applied. We match on
 * SQLSTATE 42703 (undefined_column) and the human message as a fallback for
 * environments that don't propagate `code`. All other errors bubble up.
 */
export function isMissingOnboardingStepError(
  err: { message?: string; code?: string } | null | undefined,
): boolean {
  if (!err) return false;
  if (err.code === "42703") return true;
  const m = (err.message ?? "").toLowerCase();
  return (
    m.includes("onboarding_step") &&
    (m.includes("does not exist") || m.includes("not found") || m.includes("could not find"))
  );
}

export const getOnboardingStatus = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<OnboardingStatus> => {
    // Types file has not yet been regenerated with `onboarding_step`; cast to
    // read the column safely without loosening types elsewhere.
    type Row = Record<string, unknown> | null;
    type Err = { message: string; code?: string } | null;
    const readBusinesses = (cols: string) =>
      (
        context.supabase.from("businesses") as unknown as {
          select: (c: string) => {
            limit: (n: number) => { maybeSingle: () => Promise<{ data: Row; error: Err }> };
          };
        }
      )
        .select(cols)
        .limit(1)
        .maybeSingle();
    const WITH_STEP =
      "id, slug, name, onboarding_completed, onboarding_step, selected_plan, hero_heading, hero_subheading, emergency_message";
    const WITHOUT_STEP =
      "id, slug, name, onboarding_completed, selected_plan, hero_heading, hero_subheading, emergency_message";
    // Backward-compat: repository head must not require the pending migration
    // to be applied. When PostgREST reports the `onboarding_step` column is
    // absent (SQLSTATE 42703, or "column ... does not exist" / "not found"),
    // retry with the pre-migration column list and treat the row as legacy.
    // Every other error is re-thrown as-is — never silently masked.
    let { data, error } = await readBusinesses(WITH_STEP);
    if (error && isMissingOnboardingStepError(error)) {
      ({ data, error } = await readBusinesses(WITHOUT_STEP));
    }
    if (error) throw new Error(error.message);
    if (!data) {
      return {
        hasBusiness: false,
        onboarding_completed: false,
        business_id: null,
        slug: null,
        name: null,
        step: 0,
      };
    }
    const bid = data.id as string;
    const [{ count: servicesCount }, { count: areasCount }, { count: hoursCount }] =
      await Promise.all([
        context.supabase
          .from("business_services")
          .select("id", { count: "exact", head: true })
          .eq("business_id", bid),
        context.supabase
          .from("business_service_areas")
          .select("id", { count: "exact", head: true })
          .eq("business_id", bid),
        context.supabase
          .from("business_hours")
          .select("day_of_week", { count: "exact", head: true })
          .eq("business_id", bid),
      ]);
    const b = data as unknown as {
      onboarding_completed?: boolean;
      onboarding_step?: number | null;
      selected_plan?: string | null;
      hero_heading?: string | null;
      hero_subheading?: string | null;
      emergency_message?: string | null;
    };
    const step = resolveOnboardingResumeStep({
      persistedStep: b.onboarding_step ?? null,
      completed: Boolean(b.onboarding_completed),
      progress: {
        hasBusiness: true,
        servicesCount: servicesCount ?? 0,
        areasCount: areasCount ?? 0,
        hoursCount: hoursCount ?? 0,
        hasPlan: Boolean(b.selected_plan),
        hasWebsiteCopy: Boolean(b.hero_heading || b.hero_subheading || b.emergency_message),
        completed: Boolean(b.onboarding_completed),
      },
    });
    return {
      hasBusiness: true,
      onboarding_completed: Boolean(b.onboarding_completed),
      business_id: bid,
      slug: data.slug as string,
      name: data.name as string,
      step,
    };
  });

/**
 * Pick the authoritative resume step.
 *
 * - Completed onboarding always resumes at the final step (7).
 * - Persisted `onboarding_step` wins once it has advanced past the default,
 *   so we honour the exact screen the user was on last.
 * - For legacy rows still on the default (0/null), fall back to what the
 *   saved data implies via `deriveOnboardingStep`.
 * - We never let a computed value regress a persisted one.
 */
export function resolveOnboardingResumeStep(input: {
  persistedStep: number | null | undefined;
  completed: boolean;
  progress: Parameters<typeof deriveOnboardingStep>[0];
}): number {
  if (input.completed) return ONBOARDING_STEP_MAX;
  const derived = deriveOnboardingStep(input.progress);
  const persisted =
    typeof input.persistedStep === "number" && Number.isInteger(input.persistedStep)
      ? Math.max(0, Math.min(ONBOARDING_STEP_MAX, input.persistedStep))
      : 0;
  // If persisted has advanced beyond the default, it is authoritative but
  // must never regress below what the saved data already implies.
  if (persisted > 0) return Math.max(persisted, derived);
  return derived;
}

/**
 * Return the caller's saved services / service areas / weekly hours so the
 * onboarding wizard can restore them on resume instead of overwriting them
 * with client-side defaults. RLS scopes reads to the caller's own business.
 */
export interface OnboardingBundle {
  services: { service_key: string; display_name: string; active: boolean }[];
  areas: { suburb: string; state: string | null; postcode: string | null }[];
  hours: {
    day_of_week: number;
    closed: boolean;
    open_time: string | null;
    close_time: string | null;
  }[];
}
export const getMyOnboardingBundle = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<OnboardingBundle> => {
    const { data: biz } = await context.supabase
      .from("businesses")
      .select("id")
      .limit(1)
      .maybeSingle();
    if (!biz?.id) return { services: [], areas: [], hours: [] };
    const bid = biz.id as string;
    const [svcRes, areaRes, hourRes] = await Promise.all([
      context.supabase
        .from("business_services")
        .select("service_key, display_name, active, display_order")
        .eq("business_id", bid)
        .order("display_order"),
      context.supabase
        .from("business_service_areas")
        .select("suburb, state, postcode, display_order")
        .eq("business_id", bid)
        .order("display_order"),
      context.supabase
        .from("business_hours")
        .select("day_of_week, closed, open_time, close_time")
        .eq("business_id", bid)
        .order("day_of_week"),
    ]);
    // Any failed bundle query MUST fail loudly. Returning an empty array
    // silently would cause the wizard to re-save UI defaults over the
    // caller's real saved settings on the next Next-click.
    if (svcRes.error) throw new Error(`services load failed: ${svcRes.error.message}`);
    if (areaRes.error) throw new Error(`areas load failed: ${areaRes.error.message}`);
    if (hourRes.error) throw new Error(`hours load failed: ${hourRes.error.message}`);
    return {
      services: (
        (svcRes.data ?? []) as { service_key: string; display_name: string; active: boolean }[]
      ).map((s) => ({
        service_key: s.service_key,
        display_name: s.display_name,
        active: s.active !== false,
      })),
      areas: (
        (areaRes.data ?? []) as { suburb: string; state: string | null; postcode: string | null }[]
      ).map((a) => ({
        suburb: a.suburb,
        state: a.state ?? null,
        postcode: a.postcode ?? null,
      })),
      hours: (
        (hourRes.data ?? []) as {
          day_of_week: number;
          closed: boolean;
          open_time: string | null;
          close_time: string | null;
        }[]
      ).map((h) => ({
        day_of_week: h.day_of_week,
        closed: Boolean(h.closed),
        open_time: h.open_time ?? null,
        close_time: h.close_time ?? null,
      })),
    };
  });

// Utility for tests: expose the max step so consumers can validate against a single source of truth.
export const ONBOARDING_MAX_STEP = ONBOARDING_STEP_MAX;

/**
 * Persist the exact wizard step for the caller's business. Strict validation
 * — invalid / out-of-range / fractional / non-numeric writes are rejected
 * rather than silently clamped, so we never store a corrupt value.
 */
export const setMyOnboardingStep = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { step: number }) => data)
  .handler(async ({ data, context }) => {
    const step = OnboardingStepSchema.parse(data.step);
    const { data: biz, error: bErr } = await context.supabase
      .from("businesses")
      .select("id")
      .limit(1)
      .maybeSingle();
    if (bErr) throw new Error(bErr.message);
    if (!biz?.id) throw new Error("No business");
    const { error } = await context.supabase
      .from("businesses")
      .update({ onboarding_step: step } as never)
      .eq("id", biz.id as string);
    if (error) throw new Error(error.message);
    return { success: true, step };
  });

export const createMyBusiness = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (data: {
      name: string;
      slug_base?: string | null;
      signup_source?: string | null;
      partner_code?: string | null;
      referral_code?: string | null;
    }) => data,
  )
  .handler(async ({ data, context }): Promise<{ id: string; slug: string }> => {
    const { data: rows, error } = await context.supabase.rpc(
      "create_business_for_current_user" as never,
      {
        p_name: data.name,
        p_slug_base: data.slug_base ?? null,
        p_signup_source: data.signup_source ?? null,
        p_partner_code: data.partner_code ?? null,
        p_referral_code: data.referral_code ?? null,
      } as never,
    );
    if (error) throw new Error(error.message);
    const row = Array.isArray(rows) ? rows[0] : rows;
    if (!row) throw new Error("create_business_for_current_user returned no row");
    return { id: (row as { id: string }).id, slug: (row as { slug: string }).slug };
  });

/** Replace all services for the caller's business with the given set (RLS-scoped). */
export const setMyServices = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (data: { services: { service_key: string; display_name: string; active?: boolean }[] }) => data,
  )
  .handler(async ({ data, context }) => {
    const parsed = ServicesPayloadSchema.parse(data);
    const { data: biz, error: bErr } = await context.supabase
      .from("businesses")
      .select("id")
      .limit(1)
      .maybeSingle();
    if (bErr) throw new Error(bErr.message);
    if (!biz?.id) throw new Error("No business");
    const bid = biz.id as string;
    await context.supabase.from("business_services").delete().eq("business_id", bid);
    if (parsed.services.length > 0) {
      const rows = parsed.services.map((s, i) => ({
        business_id: bid,
        service_key: s.service_key,
        display_name: s.display_name,
        active: s.active !== false,
        display_order: i,
      }));
      const { error } = await context.supabase.from("business_services").insert(rows as never);
      if (error) throw new Error(error.message);
    }
    return { success: true, count: parsed.services.length };
  });

export const setMyAreas = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (data: { areas: { suburb: string; state?: string | null; postcode?: string | null }[] }) =>
      data,
  )
  .handler(async ({ data, context }) => {
    const parsed = AreasPayloadSchema.parse(data);
    const { data: biz, error: bErr } = await context.supabase
      .from("businesses")
      .select("id")
      .limit(1)
      .maybeSingle();
    if (bErr) throw new Error(bErr.message);
    if (!biz?.id) throw new Error("No business");
    const bid = biz.id as string;
    await context.supabase.from("business_service_areas").delete().eq("business_id", bid);
    const seen = new Set<string>();
    const cleaned = parsed.areas
      .map((a) => ({ ...a, suburb: (a.suburb || "").trim() }))
      .filter((a) => a.suburb.length > 0)
      .filter((a) => {
        const key = a.suburb.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    if (cleaned.length > 0) {
      const rows = cleaned.map((a, i) => ({
        business_id: bid,
        suburb: a.suburb,
        state: a.state ?? null,
        postcode: a.postcode ?? null,
        active: true,
        display_order: i,
      }));
      const { error } = await context.supabase.from("business_service_areas").insert(rows as never);
      if (error) throw new Error(error.message);
    }
    return { success: true, count: cleaned.length };
  });

export const setMyHours = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (data: {
      hours: {
        day_of_week: number;
        closed: boolean;
        open_time?: string | null;
        close_time?: string | null;
      }[];
    }) => data,
  )
  .handler(async ({ data, context }) => {
    const parsed = HoursPayloadSchema.parse(data);
    const { data: biz, error: bErr } = await context.supabase
      .from("businesses")
      .select("id")
      .limit(1)
      .maybeSingle();
    if (bErr) throw new Error(bErr.message);
    if (!biz?.id) throw new Error("No business");
    const bid = biz.id as string;
    await context.supabase.from("business_hours").delete().eq("business_id", bid);
    const rows = parsed.hours.map((h) => ({
      business_id: bid,
      day_of_week: h.day_of_week,
      closed: h.closed,
      open_time: h.closed ? null : (h.open_time ?? null),
      close_time: h.closed ? null : (h.close_time ?? null),
    }));
    if (rows.length > 0) {
      const { error } = await context.supabase.from("business_hours").insert(rows as never);
      if (error) throw new Error(error.message);
    }
    return { success: true };
  });

export const setMyPlan = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { plan: "missed_call_recovery" | "ai_receptionist" }) => data)
  .handler(async ({ data, context }) => {
    const parsed = PlanPayloadSchema.parse(data);
    const now = new Date();
    const ends = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    const { data: biz } = await context.supabase
      .from("businesses")
      .select("id")
      .limit(1)
      .maybeSingle();
    if (!biz?.id) throw new Error("No business");
    const { error } = await context.supabase
      .from("businesses")
      .update({
        selected_plan: parsed.plan,
        trial_started_at: now.toISOString(),
        trial_ends_at: ends.toISOString(),
      } as never)
      .eq("id", biz.id as string);
    if (error) throw new Error(error.message);
    // Mirror plan selection into business_billing (service-role write).
    // business_billing rows are created by seed_business_defaults on insert;
    // upsert here handles both new + existing rows without leaking service key.
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error: billingError } = await supabaseAdmin
      .from("business_billing")
      .upsert(
        { business_id: biz.id as string, selected_plan: parsed.plan } as never,
        { onConflict: "business_id" } as never,
      );
    if (billingError) throw new Error(`Could not save billing plan: ${billingError.message}`);
    return { success: true };
  });

export const completeOnboarding = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data: biz, error: businessError } = await context.supabase
      .from("businesses")
      .select("id,name,selected_plan,hero_heading,hero_subheading")
      .limit(1)
      .maybeSingle();
    if (businessError) throw new Error(businessError.message);
    if (!biz?.id) throw new Error("No business");

    const businessId = biz.id as string;
    const [servicesResult, areasResult, hoursResult] = await Promise.all([
      context.supabase
        .from("business_services")
        .select("service_key")
        .eq("business_id", businessId),
      context.supabase
        .from("business_service_areas")
        .select("suburb")
        .eq("business_id", businessId),
      context.supabase.from("business_hours").select("day_of_week").eq("business_id", businessId),
    ]);
    for (const result of [servicesResult, areasResult, hoursResult]) {
      if (result.error) throw new Error(result.error.message);
    }

    const readinessFailures = getOnboardingReadinessFailures({
      businessName: biz.name as string | null,
      servicesCount: servicesResult.data?.length ?? 0,
      areasCount: areasResult.data?.length ?? 0,
      hoursCount: hoursResult.data?.length ?? 0,
      selectedPlan: biz.selected_plan as string | null,
      heroHeading: biz.hero_heading as string | null,
      heroSubheading: biz.hero_subheading as string | null,
    });
    if (readinessFailures.length > 0) {
      throw new Error(
        `Onboarding is not ready to complete. Finish: ${readinessFailures.join(", ")}.`,
      );
    }

    const { error } = await context.supabase
      .from("businesses")
      .update({ onboarding_completed: true, onboarding_step: ONBOARDING_STEP_MAX } as never)
      .eq("id", businessId);
    if (error) throw new Error(error.message);
    return { success: true };
  });

export const updateMySlug = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { slug: string }) => data)
  .handler(async ({ data, context }): Promise<{ slug: string }> => {
    const { data: rows, error } = await context.supabase.rpc(
      "update_my_business_slug" as never,
      { p_new_slug: data.slug } as never,
    );
    if (error) throw new Error(error.message);
    return { slug: rows as unknown as string };
  });
