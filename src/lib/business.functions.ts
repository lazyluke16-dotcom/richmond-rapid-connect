import { createServerFn } from '@tanstack/react-start';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@/integrations/supabase/types';
import { parsePublicBusiness, PUBLIC_BUSINESS_COLUMNS, type TenantBundle } from './business';

function makePublicClient() {
  const url = process.env.SUPABASE_URL!;
  const key = process.env.SUPABASE_PUBLISHABLE_KEY!;
  return createClient<Database>(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: (input, init) => {
        const h = new Headers(init?.headers);
        if (key.startsWith('sb_') && h.get('Authorization') === `Bearer ${key}`) {
          h.delete('Authorization');
        }
        h.set('apikey', key);
        return fetch(input, { ...init, headers: h });
      },
    },
  });
}

/**
 * Public loader: resolve a tenant + its public-facing services/areas/hours by
 * slug. Uses the publishable-key client (anon role) so the RLS policies on
 * the public view / active-only rows do the filtering. Returns null when the
 * slug is unknown or inactive.
 */
export const getTenantBundleBySlug = createServerFn({ method: 'GET' })
  .inputValidator((data: { slug: string }) => data)
  .handler(async ({ data }): Promise<TenantBundle | null> => {
    const supabase = makePublicClient();
    const { data: bizRaw } = await supabase
      .from('businesses_public')
      .select(PUBLIC_BUSINESS_COLUMNS)
      .eq('slug', data.slug)
      .maybeSingle();
    const biz = parsePublicBusiness(bizRaw);
    if (!biz) return null;

    const [{ data: services }, { data: areas }, { data: hours }] = await Promise.all([
      supabase
        .from('business_services')
        .select('id, service_key, display_name, description, display_order')
        .eq('business_id', biz.id)
        .eq('active', true)
        .order('display_order'),
      supabase
        .from('business_service_areas')
        .select('id, suburb, state, display_order')
        .eq('business_id', biz.id)
        .eq('active', true)
        .order('display_order'),
      supabase
        .from('business_hours')
        .select('day_of_week, open_time, close_time, closed')
        .eq('business_id', biz.id)
        .order('day_of_week'),
    ]);

    return {
      business: biz,
      services: (services ?? []) as TenantBundle['services'],
      areas: (areas ?? []) as TenantBundle['areas'],
      hours: (hours ?? []) as TenantBundle['hours'],
    };
  });
