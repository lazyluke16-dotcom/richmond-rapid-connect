
DROP POLICY IF EXISTS "Demo open read on businesses" ON public.businesses;
REVOKE SELECT ON public.businesses FROM anon;
