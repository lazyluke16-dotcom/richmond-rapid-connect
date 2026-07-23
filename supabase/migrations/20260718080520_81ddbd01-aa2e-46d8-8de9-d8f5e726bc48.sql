DROP POLICY IF EXISTS businesses_anon_public_read ON public.businesses;
REVOKE SELECT ON public.businesses FROM anon;
GRANT SELECT ON public.businesses_public TO anon;
GRANT SELECT ON public.businesses_public TO authenticated;