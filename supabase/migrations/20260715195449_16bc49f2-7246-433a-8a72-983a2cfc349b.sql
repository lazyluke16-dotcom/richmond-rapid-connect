
DROP VIEW IF EXISTS public.businesses_public;
CREATE VIEW public.businesses_public AS
SELECT
  id, name, slug, public_phone, public_email, logo_url,
  primary_colour, secondary_colour, accent_colour,
  short_description, hero_heading, hero_subheading, emergency_message, active
FROM public.businesses
WHERE active = true;

ALTER VIEW public.businesses_public OWNER TO postgres;
GRANT SELECT ON public.businesses_public TO anon, authenticated;
