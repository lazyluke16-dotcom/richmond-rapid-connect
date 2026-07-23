import { createServerFn } from "@tanstack/react-start";
import { parsePublicBusiness, PUBLIC_BUSINESS_COLUMNS, type TenantBundle } from "./business";

/**
 * Public loader: resolve a tenant + its public-facing services/areas/hours by
 * slug. This is a server-only function and reads only the deliberately
 * allowlisted public columns. Using the server client avoids production
 * runtime incompatibilities between Supabase's legacy JWT anon key and newer
 * opaque publishable keys. The active predicate is enforced explicitly.
 */
export const getTenantBundleBySlug = createServerFn({ method: "GET" })
  .inputValidator((data: { slug: string }) => data)
  .handler(async ({ data }): Promise<TenantBundle | null> => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: bizRaw, error: businessError } = await supabaseAdmin
      .from("businesses")
      .select(PUBLIC_BUSINESS_COLUMNS)
      .eq("slug", data.slug)
      .eq("active", true)
      .maybeSingle();
    if (businessError) {
      throw new Error(`Unable to load public business: ${businessError.message}`);
    }
    const biz = parsePublicBusiness(bizRaw);
    if (!biz) return null;

    const [servicesResult, areasResult, hoursResult] = await Promise.all([
      supabaseAdmin
        .from("business_services")
        .select("id, service_key, display_name, description, display_order")
        .eq("business_id", biz.id)
        .eq("active", true)
        .order("display_order"),
      supabaseAdmin
        .from("business_service_areas")
        .select("id, suburb, state, display_order")
        .eq("business_id", biz.id)
        .eq("active", true)
        .order("display_order"),
      supabaseAdmin
        .from("business_hours")
        .select("day_of_week, open_time, close_time, closed")
        .eq("business_id", biz.id)
        .order("day_of_week"),
    ]);
    const relatedError = servicesResult.error ?? areasResult.error ?? hoursResult.error;
    if (relatedError) {
      throw new Error(`Unable to load public business details: ${relatedError.message}`);
    }

    return {
      business: biz,
      services: (servicesResult.data ?? []) as TenantBundle["services"],
      areas: (areasResult.data ?? []) as TenantBundle["areas"],
      hours: (hoursResult.data ?? []) as TenantBundle["hours"],
    };
  });
