CREATE OR REPLACE FUNCTION public.get_smart_answer_provisioning(_business_id uuid)
RETURNS TABLE (
  business_name text,
  assistant_id text,
  sip_phone_id text,
  sip_uri text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    b.name,
    ai.provider_assistant_id,
    ai.smart_answer_sip_phone_id,
    ai.smart_answer_sip_uri
  FROM public.businesses b
  JOIN public.business_ai_receptionist_settings ai
    ON ai.business_id = b.id
  WHERE b.id = _business_id
    AND b.active = true
  LIMIT 1
$$;

REVOKE EXECUTE ON FUNCTION public.get_smart_answer_provisioning(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_smart_answer_provisioning(uuid)
  TO service_role;

CREATE OR REPLACE FUNCTION public.save_smart_answer_sip_endpoint(
  _business_id uuid,
  _sip_phone_id text,
  _sip_uri text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF btrim(COALESCE(_sip_phone_id, '')) = ''
    OR btrim(COALESCE(_sip_uri, '')) = ''
    OR _sip_uri !~ '^sip:[A-Za-z0-9._+-]+@sip(\.eu)?\.vapi\.ai$' THEN
    RAISE EXCEPTION 'Invalid Smart Answer SIP endpoint' USING ERRCODE = '22023';
  END IF;

  UPDATE public.business_ai_receptionist_settings
  SET smart_answer_sip_phone_id = _sip_phone_id,
      smart_answer_sip_uri = _sip_uri
  WHERE business_id = _business_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'AI receptionist settings not found' USING ERRCODE = '23503';
  END IF;
END
$$;

REVOKE EXECUTE ON FUNCTION public.save_smart_answer_sip_endpoint(uuid, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.save_smart_answer_sip_endpoint(uuid, text, text)
  TO service_role;
