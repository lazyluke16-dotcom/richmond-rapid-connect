ALTER TABLE public.business_ai_receptionist_settings
  ADD COLUMN IF NOT EXISTS smart_answer_assistant_id text;

CREATE UNIQUE INDEX IF NOT EXISTS business_ai_receptionist_smart_assistant_uk
  ON public.business_ai_receptionist_settings (smart_answer_assistant_id)
  WHERE smart_answer_assistant_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.get_smart_answer_stack_provisioning(_business_id uuid)
RETURNS TABLE (
  business_name text,
  existing_assistant_id text,
  smart_assistant_id text,
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
    ai.smart_answer_assistant_id,
    ai.smart_answer_sip_phone_id,
    ai.smart_answer_sip_uri
  FROM public.businesses b
  JOIN public.business_ai_receptionist_settings ai
    ON ai.business_id = b.id
  WHERE b.id = _business_id
    AND b.active = true
  LIMIT 1
$$;

REVOKE EXECUTE ON FUNCTION public.get_smart_answer_stack_provisioning(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_smart_answer_stack_provisioning(uuid)
  TO service_role;

CREATE OR REPLACE FUNCTION public.save_smart_answer_stack(
  _business_id uuid,
  _assistant_id text,
  _sip_phone_id text,
  _sip_uri text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF btrim(COALESCE(_assistant_id, '')) = ''
    OR btrim(COALESCE(_sip_phone_id, '')) = ''
    OR btrim(COALESCE(_sip_uri, '')) = ''
    OR _sip_uri !~ '^sip:[A-Za-z0-9._+-]+@sip(\.eu)?\.vapi\.ai$' THEN
    RAISE EXCEPTION 'Invalid Smart Answer stack' USING ERRCODE = '22023';
  END IF;

  UPDATE public.business_ai_receptionist_settings
  SET smart_answer_assistant_id = _assistant_id,
      smart_answer_sip_phone_id = _sip_phone_id,
      smart_answer_sip_uri = _sip_uri
  WHERE business_id = _business_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'AI receptionist settings not found' USING ERRCODE = '23503';
  END IF;
END
$$;

REVOKE EXECUTE ON FUNCTION public.save_smart_answer_stack(uuid, text, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.save_smart_answer_stack(uuid, text, text, text)
  TO service_role;

CREATE OR REPLACE FUNCTION public.resolve_smart_answer_assistant(_assistant_id text)
RETURNS TABLE (
  business_id uuid,
  business_name text,
  answering_mode text,
  ai_receptionist_enabled boolean,
  smart_answer_enabled boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    b.id,
    b.name,
    bt.answering_mode,
    COALESCE(bt.ai_receptionist_enabled, false),
    COALESCE(bt.smart_answer_enabled, false)
  FROM public.business_ai_receptionist_settings ai
  JOIN public.businesses b
    ON b.id = ai.business_id AND b.active = true
  JOIN public.business_telephony_settings bt
    ON bt.business_id = ai.business_id
  WHERE ai.smart_answer_assistant_id = _assistant_id
  LIMIT 1
$$;

REVOKE EXECUTE ON FUNCTION public.resolve_smart_answer_assistant(text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_smart_answer_assistant(text)
  TO service_role;
