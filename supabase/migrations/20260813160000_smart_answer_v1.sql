-- Smart Answer V1: ring-first overflow screening, manual bypasses and reception messages.
--
-- Source-only migration. It does not purchase, import, reconfigure or deploy
-- Twilio/Vapi resources. Provider changes remain an explicit staged operation.

ALTER TABLE public.business_telephony_settings
  ADD COLUMN IF NOT EXISTS smart_answer_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS ring_first_seconds integer NOT NULL DEFAULT 15,
  ADD COLUMN IF NOT EXISTS private_caller_policy text NOT NULL DEFAULT 'voicemail';

ALTER TABLE public.business_telephony_settings
  DROP CONSTRAINT IF EXISTS business_telephony_settings_ring_first_seconds_check,
  ADD CONSTRAINT business_telephony_settings_ring_first_seconds_check
    CHECK (ring_first_seconds BETWEEN 5 AND 30),
  DROP CONSTRAINT IF EXISTS business_telephony_settings_private_caller_policy_check,
  ADD CONSTRAINT business_telephony_settings_private_caller_policy_check
    CHECK (private_caller_policy IN ('voicemail','reject'));

ALTER TABLE public.business_ai_receptionist_settings
  ADD COLUMN IF NOT EXISTS smart_answer_sip_phone_id text,
  ADD COLUMN IF NOT EXISTS smart_answer_sip_uri text;

CREATE UNIQUE INDEX IF NOT EXISTS business_ai_receptionist_smart_sip_phone_uk
  ON public.business_ai_receptionist_settings (smart_answer_sip_phone_id)
  WHERE smart_answer_sip_phone_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS business_ai_receptionist_smart_sip_uri_uk
  ON public.business_ai_receptionist_settings (smart_answer_sip_uri)
  WHERE smart_answer_sip_uri IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.business_call_bypass_numbers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  phone_e164 text NOT NULL,
  label text,
  source text NOT NULL DEFAULT 'manual'
    CHECK (source IN ('manual','contact_sync','learned')),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT business_call_bypass_numbers_business_phone_uk UNIQUE (business_id, phone_e164),
  CONSTRAINT business_call_bypass_numbers_phone_check
    CHECK (phone_e164 ~ '^\+61[23478][0-9]{8}$')
);

CREATE INDEX IF NOT EXISTS business_call_bypass_numbers_business_active_idx
  ON public.business_call_bypass_numbers (business_id, active, created_at DESC);

ALTER TABLE public.business_call_bypass_numbers ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.business_call_bypass_numbers TO authenticated;
GRANT ALL ON public.business_call_bypass_numbers TO service_role;
REVOKE INSERT, UPDATE, DELETE ON public.business_call_bypass_numbers FROM anon, authenticated;

DROP POLICY IF EXISTS "Members can view their Smart Answer bypass numbers"
  ON public.business_call_bypass_numbers;
CREATE POLICY "Members can view their Smart Answer bypass numbers"
  ON public.business_call_bypass_numbers
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.business_users bu
      WHERE bu.business_id = business_call_bypass_numbers.business_id
        AND bu.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "Service role manages Smart Answer bypass numbers"
  ON public.business_call_bypass_numbers;
CREATE POLICY "Service role manages Smart Answer bypass numbers"
  ON public.business_call_bypass_numbers
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP TRIGGER IF EXISTS trg_business_call_bypass_numbers_updated
  ON public.business_call_bypass_numbers;
CREATE TRIGGER trg_business_call_bypass_numbers_updated
  BEFORE UPDATE ON public.business_call_bypass_numbers
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE IF NOT EXISTS public.reception_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  provider text NOT NULL,
  provider_call_id text NOT NULL,
  source text NOT NULL CHECK (source IN ('ai_receptionist','voicemail')),
  caller_phone text,
  caller_name text,
  caller_company text,
  message_text text,
  callback_requested boolean NOT NULL DEFAULT true,
  message_urgency text NOT NULL DEFAULT 'normal'
    CHECK (message_urgency IN ('normal','urgent')),
  recording_url text,
  recording_sid text,
  recording_duration_seconds integer,
  transcription text,
  status text NOT NULL DEFAULT 'unread'
    CHECK (status IN ('unread','read','done')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT reception_messages_provider_call_uk
    UNIQUE (business_id, provider, provider_call_id)
);

CREATE INDEX IF NOT EXISTS reception_messages_business_created_idx
  ON public.reception_messages (business_id, created_at DESC);

ALTER TABLE public.reception_messages ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.reception_messages TO authenticated;
GRANT ALL ON public.reception_messages TO service_role;
REVOKE INSERT, DELETE ON public.reception_messages FROM anon, authenticated;

DROP POLICY IF EXISTS "Members can view their reception messages"
  ON public.reception_messages;
CREATE POLICY "Members can view their reception messages"
  ON public.reception_messages
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.business_users bu
      WHERE bu.business_id = reception_messages.business_id
        AND bu.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "Service role manages reception messages"
  ON public.reception_messages;
CREATE POLICY "Service role manages reception messages"
  ON public.reception_messages
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP TRIGGER IF EXISTS trg_reception_messages_updated ON public.reception_messages;
CREATE TRIGGER trg_reception_messages_updated
  BEFORE UPDATE ON public.reception_messages
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE OR REPLACE FUNCTION public.set_my_smart_answer_settings(
  _enabled boolean,
  _ring_first_seconds integer DEFAULT 15
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  bid uuid;
  bt public.business_telephony_settings%ROWTYPE;
  ai public.business_ai_receptionist_settings%ROWTYPE;
BEGIN
  bid := public.call_handling_admin_business();
  IF bid IS NULL THEN
    RAISE EXCEPTION 'Owner or admin access is required' USING ERRCODE = '42501';
  END IF;
  IF _ring_first_seconds < 5 OR _ring_first_seconds > 30 THEN
    RAISE EXCEPTION 'Ring-first time must be between 5 and 30 seconds'
      USING ERRCODE = '22023';
  END IF;

  IF _enabled THEN
    SELECT * INTO bt
    FROM public.business_telephony_settings
    WHERE business_id = bid;

    SELECT * INTO ai
    FROM public.business_ai_receptionist_settings
    WHERE business_id = bid;

    IF bt.forwarding_setup_status <> 'verified' THEN
      RAISE EXCEPTION 'Verify no-answer forwarding before enabling Smart Answer'
        USING ERRCODE = '23514';
    END IF;
    IF bt.answering_mode <> 'ai_receptionist' OR NOT COALESCE(bt.ai_receptionist_enabled, false) THEN
      RAISE EXCEPTION 'Switch AI Receptionist on before enabling Smart Answer'
        USING ERRCODE = '23514';
    END IF;
    IF ai.smart_answer_sip_uri IS NULL OR btrim(ai.smart_answer_sip_uri) = '' THEN
      RAISE EXCEPTION 'Provision the Smart Answer SIP endpoint before enabling Smart Answer'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  UPDATE public.business_telephony_settings
  SET smart_answer_enabled = _enabled,
      ring_first_seconds = _ring_first_seconds
  WHERE business_id = bid;
END
$$;

REVOKE EXECUTE ON FUNCTION public.set_my_smart_answer_settings(boolean, integer)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_my_smart_answer_settings(boolean, integer)
  TO authenticated;

CREATE OR REPLACE FUNCTION public.add_my_call_bypass_number(
  _phone_e164 text,
  _label text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  bid uuid;
  bypass_id uuid;
BEGIN
  bid := public.call_handling_admin_business();
  IF bid IS NULL THEN
    RAISE EXCEPTION 'Owner or admin access is required' USING ERRCODE = '42501';
  END IF;
  IF _phone_e164 !~ '^\+61[23478][0-9]{8}$' THEN
    RAISE EXCEPTION 'A normal Australian mobile or geographic number is required'
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.business_call_bypass_numbers
    (business_id, phone_e164, label, source, active)
  VALUES
    (bid, _phone_e164, NULLIF(btrim(_label), ''), 'manual', true)
  ON CONFLICT (business_id, phone_e164)
  DO UPDATE SET
    label = COALESCE(EXCLUDED.label, business_call_bypass_numbers.label),
    source = CASE
      WHEN business_call_bypass_numbers.source = 'contact_sync'
        THEN business_call_bypass_numbers.source
      ELSE 'manual'
    END,
    active = true
  RETURNING id INTO bypass_id;

  RETURN bypass_id;
END
$$;

REVOKE EXECUTE ON FUNCTION public.add_my_call_bypass_number(text, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.add_my_call_bypass_number(text, text)
  TO authenticated;

CREATE OR REPLACE FUNCTION public.remove_my_call_bypass_number(_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE bid uuid;
BEGIN
  bid := public.call_handling_admin_business();
  IF bid IS NULL THEN
    RAISE EXCEPTION 'Owner or admin access is required' USING ERRCODE = '42501';
  END IF;

  DELETE FROM public.business_call_bypass_numbers
  WHERE id = _id AND business_id = bid;
END
$$;

REVOKE EXECUTE ON FUNCTION public.remove_my_call_bypass_number(uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.remove_my_call_bypass_number(uuid)
  TO authenticated;

CREATE OR REPLACE FUNCTION public.resolve_smart_answer_tenant(
  _platform_number text
)
RETURNS TABLE (
  business_id uuid,
  business_name text,
  business_slug text,
  public_phone text,
  answering_mode text,
  ai_receptionist_enabled boolean,
  smart_answer_enabled boolean,
  forwarding_setup_status text,
  provider_assistant_id text,
  smart_answer_sip_uri text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    b.id,
    b.name,
    b.slug,
    b.public_phone,
    bt.answering_mode,
    COALESCE(bt.ai_receptionist_enabled, false),
    COALESCE(bt.smart_answer_enabled, false),
    bt.forwarding_setup_status,
    ai.provider_assistant_id,
    ai.smart_answer_sip_uri
  FROM public.platform_phone_inventory i
  JOIN public.business_telephony_settings bt
    ON bt.inventory_phone_id = i.id
  JOIN public.businesses b
    ON b.id = bt.business_id
  LEFT JOIN public.business_ai_receptionist_settings ai
    ON ai.business_id = b.id
  WHERE i.phone_number = _platform_number
    AND (
      (i.status = 'reserved' AND i.reserved_business_id = b.id)
      OR (i.status = 'assigned' AND i.assigned_business_id = b.id)
    )
    AND b.active = true
  LIMIT 1
$$;

REVOKE EXECUTE ON FUNCTION public.resolve_smart_answer_tenant(text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_smart_answer_tenant(text)
  TO service_role;

CREATE OR REPLACE FUNCTION public.is_smart_answer_bypass_number(
  _business_id uuid,
  _phone_e164 text
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.business_call_bypass_numbers b
    WHERE b.business_id = _business_id
      AND b.phone_e164 = _phone_e164
      AND b.active = true
  )
$$;

REVOKE EXECUTE ON FUNCTION public.is_smart_answer_bypass_number(uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.is_smart_answer_bypass_number(uuid, text)
  TO service_role;

CREATE OR REPLACE FUNCTION public.record_reception_message(
  _business_id uuid,
  _provider text,
  _provider_call_id text,
  _source text,
  _caller_phone text DEFAULT NULL,
  _caller_name text DEFAULT NULL,
  _caller_company text DEFAULT NULL,
  _message_text text DEFAULT NULL,
  _callback_requested boolean DEFAULT true,
  _message_urgency text DEFAULT 'normal',
  _recording_url text DEFAULT NULL,
  _recording_sid text DEFAULT NULL,
  _recording_duration_seconds integer DEFAULT NULL,
  _transcription text DEFAULT NULL,
  _metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE message_id uuid;
BEGIN
  IF _business_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.businesses b WHERE b.id = _business_id AND b.active = true
  ) THEN
    RAISE EXCEPTION 'Unknown business' USING ERRCODE = '23503';
  END IF;
  IF btrim(COALESCE(_provider_call_id, '')) = '' THEN
    RAISE EXCEPTION 'Provider call identity is required' USING ERRCODE = '22023';
  END IF;
  IF _source NOT IN ('ai_receptionist','voicemail') THEN
    RAISE EXCEPTION 'Invalid reception message source' USING ERRCODE = '22023';
  END IF;
  IF _message_urgency NOT IN ('normal','urgent') THEN
    RAISE EXCEPTION 'Invalid reception message urgency' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.reception_messages (
    business_id,
    provider,
    provider_call_id,
    source,
    caller_phone,
    caller_name,
    caller_company,
    message_text,
    callback_requested,
    message_urgency,
    recording_url,
    recording_sid,
    recording_duration_seconds,
    transcription,
    metadata
  )
  VALUES (
    _business_id,
    _provider,
    _provider_call_id,
    _source,
    NULLIF(btrim(_caller_phone), ''),
    NULLIF(btrim(_caller_name), ''),
    NULLIF(btrim(_caller_company), ''),
    NULLIF(btrim(_message_text), ''),
    COALESCE(_callback_requested, true),
    _message_urgency,
    NULLIF(btrim(_recording_url), ''),
    NULLIF(btrim(_recording_sid), ''),
    _recording_duration_seconds,
    NULLIF(btrim(_transcription), ''),
    COALESCE(_metadata, '{}'::jsonb)
  )
  ON CONFLICT (business_id, provider, provider_call_id)
  DO UPDATE SET
    caller_phone = COALESCE(EXCLUDED.caller_phone, reception_messages.caller_phone),
    caller_name = COALESCE(EXCLUDED.caller_name, reception_messages.caller_name),
    caller_company = COALESCE(EXCLUDED.caller_company, reception_messages.caller_company),
    message_text = COALESCE(EXCLUDED.message_text, reception_messages.message_text),
    callback_requested = EXCLUDED.callback_requested,
    message_urgency = EXCLUDED.message_urgency,
    recording_url = COALESCE(EXCLUDED.recording_url, reception_messages.recording_url),
    recording_sid = COALESCE(EXCLUDED.recording_sid, reception_messages.recording_sid),
    recording_duration_seconds = COALESCE(
      EXCLUDED.recording_duration_seconds,
      reception_messages.recording_duration_seconds
    ),
    transcription = COALESCE(EXCLUDED.transcription, reception_messages.transcription),
    metadata = reception_messages.metadata || EXCLUDED.metadata
  RETURNING id INTO message_id;

  RETURN message_id;
END
$$;

REVOKE EXECUTE ON FUNCTION public.record_reception_message(
  uuid, text, text, text, text, text, text, text, boolean, text, text, text, integer, text, jsonb
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_reception_message(
  uuid, text, text, text, text, text, text, text, boolean, text, text, text, integer, text, jsonb
) TO service_role;

CREATE OR REPLACE FUNCTION public.get_my_smart_answer_context()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  bid uuid;
  result jsonb;
BEGIN
  SELECT bu.business_id INTO bid
  FROM public.business_users bu
  WHERE bu.user_id = auth.uid()
  ORDER BY CASE WHEN bu.role IN ('owner','admin') THEN 0 ELSE 1 END, bu.business_id
  LIMIT 1;

  IF bid IS NULL THEN
    RAISE EXCEPTION 'No business membership' USING ERRCODE = '42501';
  END IF;

  SELECT jsonb_build_object(
    'businessId', bid,
    'enabled', COALESCE(bt.smart_answer_enabled, false),
    'ringFirstSeconds', COALESCE(bt.ring_first_seconds, 15),
    'forwardingStatus', COALESCE(bt.forwarding_setup_status, 'unallocated'),
    'answeringMode', COALESCE(bt.answering_mode, 'off'),
    'aiOperational', COALESCE(bt.ai_receptionist_enabled, false),
    'sipReady', (ai.smart_answer_sip_uri IS NOT NULL AND btrim(ai.smart_answer_sip_uri) <> ''),
    'bypassNumbers', COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object(
          'id', bp.id,
          'phone', bp.phone_e164,
          'label', bp.label,
          'source', bp.source
        )
        ORDER BY bp.created_at DESC
      )
      FROM public.business_call_bypass_numbers bp
      WHERE bp.business_id = bid AND bp.active = true
    ), '[]'::jsonb),
    'unreadMessages', (
      SELECT count(*)
      FROM public.reception_messages rm
      WHERE rm.business_id = bid AND rm.status = 'unread'
    )
  ) INTO result
  FROM public.business_telephony_settings bt
  LEFT JOIN public.business_ai_receptionist_settings ai
    ON ai.business_id = bt.business_id
  WHERE bt.business_id = bid;

  RETURN COALESCE(
    result,
    jsonb_build_object(
      'businessId', bid,
      'enabled', false,
      'ringFirstSeconds', 15,
      'forwardingStatus', 'unallocated',
      'answeringMode', 'off',
      'aiOperational', false,
      'sipReady', false,
      'bypassNumbers', '[]'::jsonb,
      'unreadMessages', 0
    )
  );
END
$$;

REVOKE EXECUTE ON FUNCTION public.get_my_smart_answer_context()
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_my_smart_answer_context()
  TO authenticated;
