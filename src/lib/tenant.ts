/**
 * Centralised tenant resolution for unauthenticated server-side write paths
 * (public form, webhooks, missed-call demo).
 *
 * Phase 2G.1 — multi-tenant hardening:
 *   - Removed the hardcoded `richmond-rapid-plumbing` fallback: shared
 *     public paths MUST derive their tenant from an explicit slug or
 *     provider mapping. Silent "default to Richmond" behaviour would
 *     mis-attribute other tenants' leads.
 *   - `resolveBusinessId()` remains available only for local /
 *     single-tenant test setups that opt in via `DEFAULT_BUSINESS_ID` or
 *     `DEFAULT_BUSINESS_SLUG`. When neither is set it throws — every
 *     caller must either pass a slug or handle the failure.
 *
 * Authenticated dashboard paths resolve the tenant through
 * `public.current_business_id()` at the database layer via RLS.
 */

export const DEFAULT_BUSINESS_SLUG =
  typeof process !== 'undefined' ? process.env.DEFAULT_BUSINESS_SLUG ?? null : null;

let cachedId: string | null = null;

export async function resolveBusinessId(): Promise<string> {
  if (cachedId) return cachedId;

  const envId =
    typeof process !== 'undefined' ? process.env.DEFAULT_BUSINESS_ID : undefined;
  if (envId) {
    cachedId = envId;
    return envId;
  }

  if (!DEFAULT_BUSINESS_SLUG) {
    throw new Error(
      'Tenant resolution failed: no explicit slug supplied and no DEFAULT_BUSINESS_ID/DEFAULT_BUSINESS_SLUG env var configured. Shared public paths must resolve tenants explicitly.',
    );
  }

  const { supabaseAdmin } = await import('@/integrations/supabase/client.server');
  const { data, error } = await supabaseAdmin
    .from('businesses')
    .select('id')
    .eq('slug', DEFAULT_BUSINESS_SLUG)
    .maybeSingle();

  if (error) throw new Error(`Tenant resolution failed: ${error.message}`);
  if (!data?.id)
    throw new Error(
      `Tenant resolution failed: no business with slug "${DEFAULT_BUSINESS_SLUG}"`,
    );

  cachedId = data.id as string;
  return cachedId;
}

/**
 * Resolve a specific business by slug (server-side, admin). Public customer
 * lead capture uses this to look up the target tenant from a URL slug.
 * The client-supplied slug is a public identifier only — nothing about the
 * lookup grants privileges.
 */
export async function resolveBusinessIdBySlug(slug: string): Promise<string | null> {
  const { supabaseAdmin } = await import('@/integrations/supabase/client.server');
  const { data, error } = await supabaseAdmin
    .from('businesses')
    .select('id')
    .eq('slug', slug)
    .maybeSingle();
  if (error) throw new Error(`Tenant lookup failed: ${error.message}`);
  return (data?.id as string | undefined) ?? null;
}