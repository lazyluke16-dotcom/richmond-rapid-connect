import { createServerFn } from '@tanstack/react-start';
import { requireSupabaseAuth } from '@/integrations/supabase/auth-middleware';
import {
  CoveragePayloadSchema,
  LicencePayloadSchema,
  type CoveragePayload,
  type LicencePayload,
} from '@/lib/onboarding-validation';

export interface EditableBusiness {
  id: string;
  name: string;
  slug: string;
  public_phone: string | null;
  public_email: string | null;
  logo_url: string | null;
  primary_colour: string | null;
  secondary_colour: string | null;
  accent_colour: string | null;
  short_description: string | null;
  hero_heading: string | null;
  hero_subheading: string | null;
  emergency_message: string | null;
  // Phase 1 — service coverage (optional; nullable when pre-migration).
  base_suburb?: string | null;
  base_state?: string | null;
  base_postcode?: string | null;
  travel_radius_km?: number | null;
  region_labels?: string[] | null;
  postcode_ranges?: string[] | null;
  excluded_areas?: string[] | null;
  // Phase 1 — Business Profile licence fields (optional; nullable pre-migration).
  licence_number?: string | null;
  licence_holder_name?: string | null;
  licence_expiry?: string | null;
  licence_public?: boolean | null;
}

// Column lists for tolerant reads while the Phase 1 migration is unapplied.
const BASE_COLS =
  'id,name,slug,public_phone,public_email,logo_url,primary_colour,secondary_colour,accent_colour,short_description,hero_heading,hero_subheading,emergency_message';
const PHASE1_COLS =
  BASE_COLS +
  ',base_suburb,base_state,base_postcode,travel_radius_km,region_labels,postcode_ranges,excluded_areas,licence_number,licence_holder_name,licence_expiry,licence_public';

function isMissingPhase1Column(err: { message?: string; code?: string } | null): boolean {
  if (!err) return false;
  if (err.code === '42703') return true;
  const m = (err.message ?? '').toLowerCase();
  const cols = [
    'base_suburb','base_state','base_postcode','travel_radius_km',
    'region_labels','postcode_ranges','excluded_areas',
    'licence_number','licence_holder_name','licence_expiry','licence_public',
  ];
  return cols.some((c) => m.includes(c)) && (m.includes('does not exist') || m.includes('not found') || m.includes('could not find'));
}

// -------------------------------------------------------------------------
// Pure, dependency-injected update helpers.
// Extracted from the server-fn handlers so they can be exercised directly
// in unit tests to prove that (a) writes are scoped to the caller's own
// business_id, (b) client-supplied identifiers cannot target another
// tenant, and (c) failures are surfaced without silently succeeding.
// -------------------------------------------------------------------------
export interface BusinessUpdateDeps {
  /** Resolve the caller's own business id under RLS. Returns null when the
   *  caller has no business membership. */
  resolveCurrentBusinessId: () => Promise<string | null>;
  /** Persist the given patch scoped by id. Must throw on failure. */
  updateBusinessById: (id: string, patch: Record<string, unknown>) => Promise<void>;
}

function buildCoveragePatch(data: CoveragePayload): Record<string, unknown> {
  const patch: Record<string, unknown> = {
    base_suburb: data.base_suburb ?? null,
    base_state: data.base_state ?? null,
    base_postcode: data.base_postcode ?? null,
    travel_radius_km: data.travel_radius_km ?? null,
  };
  if (data.region_labels !== undefined) patch.region_labels = data.region_labels;
  if (data.postcode_ranges !== undefined) patch.postcode_ranges = data.postcode_ranges;
  if (data.excluded_areas !== undefined) patch.excluded_areas = data.excluded_areas;
  return patch;
}

function buildLicencePatch(data: LicencePayload): Record<string, unknown> {
  const patch: Record<string, unknown> = {
    licence_number: data.licence_number ?? null,
    licence_holder_name: data.licence_holder_name ?? null,
    licence_expiry: data.licence_expiry ?? null,
  };
  if (data.licence_public !== undefined) patch.licence_public = data.licence_public;
  return patch;
}

export async function applyCoverageUpdate(
  deps: BusinessUpdateDeps,
  input: unknown,
): Promise<{ success: true }> {
  const data = CoveragePayloadSchema.parse(input);
  const id = await deps.resolveCurrentBusinessId();
  if (!id) throw new Error('No business membership found');
  await deps.updateBusinessById(id, buildCoveragePatch(data));
  return { success: true };
}

export async function applyLicenceUpdate(
  deps: BusinessUpdateDeps,
  input: unknown,
): Promise<{ success: true }> {
  const data = LicencePayloadSchema.parse(input);
  const id = await deps.resolveCurrentBusinessId();
  if (!id) throw new Error('No business membership found');
  await deps.updateBusinessById(id, buildLicencePatch(data));
  return { success: true };
}

function makeSupabaseDeps(supabase: {
  from: (t: string) => {
    select: (c: string) => { limit: (n: number) => { maybeSingle: () => Promise<{ data: { id?: string } | null; error: { message: string } | null }> } };
    update: (patch: Record<string, unknown>) => { eq: (col: string, val: string) => Promise<{ error: { message: string } | null }> };
  };
}): BusinessUpdateDeps {
  return {
    resolveCurrentBusinessId: async () => {
      const { data, error } = await supabase.from('businesses').select('id').limit(1).maybeSingle();
      if (error) throw new Error(error.message);
      return data?.id ?? null;
    },
    updateBusinessById: async (id, patch) => {
      const { error } = await supabase.from('businesses').update(patch).eq('id', id);
      if (error) throw new Error(error.message);
    },
  };
}

/** Authenticated: returns ONLY the caller's own business (RLS-enforced). */
export const getMyBusiness = createServerFn({ method: 'GET' })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<EditableBusiness | null> => {
    type Row = Record<string, unknown> | null;
    type Err = { message: string; code?: string } | null;
    const read = (cols: string) =>
      (context.supabase.from('businesses') as unknown as {
        select: (c: string) => {
          limit: (n: number) => { maybeSingle: () => Promise<{ data: Row; error: Err }> };
        };
      }).select(cols).limit(1).maybeSingle();
    let { data, error } = await read(PHASE1_COLS);
    if (error && isMissingPhase1Column(error)) {
      ({ data, error } = await read(BASE_COLS));
    }
    if (error) throw new Error(error.message);
    return (data as EditableBusiness | null) ?? null;
  });

/**
 * Authenticated: update the caller's own business record. RLS restricts the
 * update to `id = current_business_id()`, so any client-supplied `id` in the
 * payload cannot target another tenant.
 */
export const updateMyBusiness = createServerFn({ method: 'POST' })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: Partial<EditableBusiness>) => data)
  .handler(async ({ data, context }) => {
    const editable = {
      name: data.name,
      public_phone: data.public_phone,
      public_email: data.public_email,
      logo_url: data.logo_url,
      primary_colour: data.primary_colour,
      secondary_colour: data.secondary_colour,
      accent_colour: data.accent_colour,
      short_description: data.short_description,
      hero_heading: data.hero_heading,
      hero_subheading: data.hero_subheading,
      emergency_message: data.emergency_message,
    };
    const { data: current, error: qErr } = await context.supabase
      .from('businesses').select('id').limit(1).maybeSingle();
    if (qErr) throw new Error(qErr.message);
    if (!current?.id) throw new Error('No business membership found');
    const { error } = await context.supabase
      .from('businesses')
      .update(editable as never)
      .eq('id', current.id);
    if (error) throw new Error(error.message);
    return { success: true };
  });

/**
 * Authenticated: update the caller's service-coverage fields (base
 * location, travel radius, region labels, optional postcode ranges and
 * exclusions). Suburb-by-suburb records live in `business_service_areas`
 * and are NOT touched by this fn — the two coexist, and this call must
 * never overwrite/delete existing suburb rows.
 */
export const setMyCoverage = createServerFn({ method: 'POST' })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => data)
  .handler(async ({ data, context }) =>
    applyCoverageUpdate(makeSupabaseDeps(context.supabase as never), data),
  );

/**
 * Authenticated: update licence fields for the caller's own business.
 * Owning tenant only (RLS-scoped). `licence_public=false` by default and
 * public surfaces must respect it before rendering. No external
 * verification is performed here — a future Go-Live step may add that.
 */
export const setMyLicence = createServerFn({ method: 'POST' })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => data)
  .handler(async ({ data, context }) =>
    applyLicenceUpdate(makeSupabaseDeps(context.supabase as never), data),
  );