-- Phase 1 — schema additions for reusable multi-tenant configuration.
--
-- Idempotent, repository-only. NOT AUTO-EXECUTED. Placed under
-- supabase/migrations-pending/ because this Lovable environment forbids
-- adding files under supabase/migrations/ without running them through the
-- migration tool. Move (or copy) this file into supabase/migrations/ once
-- approved for execution.
--
-- What this does:
--   1. Adds primary service-coverage fields to public.businesses:
--      - base_suburb (text), base_state (text), base_postcode (text)
--      - travel_radius_km (smallint 0..500)
--      - region_labels (text[])         -- broad, editable Melbourne region tags
--      - postcode_ranges (text[])       -- optional "3000-3199" ranges
--      - excluded_areas (text[])        -- optional excluded suburbs / regions
--   2. Adds Business Profile licence fields (all optional):
--      - licence_number (text)
--      - licence_holder_name (text)
--      - licence_expiry (date)
--      - licence_public (boolean, default false)
--
-- What this does NOT do: no data changes, no RLS changes, no external
-- verification. Public licence values are exposed through
-- `businesses_public` only when `licence_public IS TRUE`. Future Go-Live
-- gating may require these fields but this migration does not enforce that
-- yet.

ALTER TABLE public.businesses
  ADD COLUMN IF NOT EXISTS base_suburb text,
  ADD COLUMN IF NOT EXISTS base_state text,
  ADD COLUMN IF NOT EXISTS base_postcode text,
  ADD COLUMN IF NOT EXISTS travel_radius_km smallint,
  ADD COLUMN IF NOT EXISTS region_labels text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS postcode_ranges text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS excluded_areas text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS licence_number text,
  ADD COLUMN IF NOT EXISTS licence_holder_name text,
  ADD COLUMN IF NOT EXISTS licence_expiry date,
  ADD COLUMN IF NOT EXISTS licence_public boolean NOT NULL DEFAULT false;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'businesses_travel_radius_km_range'
       AND conrelid = 'public.businesses'::regclass
  ) THEN
    ALTER TABLE public.businesses
      ADD CONSTRAINT businesses_travel_radius_km_range
      CHECK (travel_radius_km IS NULL OR (travel_radius_km >= 0 AND travel_radius_km <= 500));
  END IF;
END $$;

-- Preserve the existing public contract and append only the licence fields
-- required by the public tenant page. CREATE OR REPLACE keeps the view's
-- existing owner and grants; security_invoker remains explicit. The CASE
-- expressions enforce fail-closed disclosure at the database boundary, so
-- querying the view directly cannot reveal private licence values.
CREATE OR REPLACE VIEW public.businesses_public
WITH (security_invoker = true) AS
SELECT
  id, name, slug, public_phone, public_email, logo_url,
  primary_colour, secondary_colour, accent_colour,
  short_description, hero_heading, hero_subheading, emergency_message, active,
  CASE WHEN licence_public IS TRUE THEN licence_number ELSE NULL END AS licence_number,
  CASE WHEN licence_public IS TRUE THEN licence_holder_name ELSE NULL END AS licence_holder_name,
  CASE WHEN licence_public IS TRUE THEN licence_expiry ELSE NULL END AS licence_expiry,
  licence_public
FROM public.businesses
WHERE active = true;

-- Reassert only the existing view-level read grants. No base-table grants or
-- policies are added or widened.
GRANT SELECT ON public.businesses_public TO anon, authenticated;
