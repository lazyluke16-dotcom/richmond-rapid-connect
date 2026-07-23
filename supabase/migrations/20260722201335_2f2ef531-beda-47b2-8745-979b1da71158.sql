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

GRANT SELECT ON public.businesses_public TO anon, authenticated;