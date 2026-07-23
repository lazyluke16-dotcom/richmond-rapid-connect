
DROP VIEW IF EXISTS public.businesses_public;
CREATE VIEW public.businesses_public
WITH (security_invoker = true) AS
SELECT
  id, name, slug, public_phone, public_email, logo_url,
  primary_colour, secondary_colour, accent_colour,
  short_description, hero_heading, hero_subheading, emergency_message, active
FROM public.businesses
WHERE active = true;

GRANT SELECT ON public.businesses_public TO anon, authenticated;

-- Column-level grant: anon can only read approved public columns of the base table.
GRANT SELECT (
  id, name, slug, public_phone, public_email, logo_url,
  primary_colour, secondary_colour, accent_colour,
  short_description, hero_heading, hero_subheading, emergency_message, active
) ON public.businesses TO anon;

-- Anonymous callers may read (via those columns only) active businesses.
CREATE POLICY "businesses_anon_public_read" ON public.businesses
  FOR SELECT TO anon
  USING (active = true);
