
REVOKE EXECUTE ON FUNCTION public.get_my_billing_detail() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_my_billing_detail() TO authenticated;
