-- Customer-controlled call handling.
--
-- This migration deliberately does not purchase/import provider numbers and
-- does not change Vapi/Twilio resources. Apply it before deploying the
-- corresponding application source.

ALTER TABLE public.business_telephony_settings
  ADD COLUMN IF NOT EXISTS answering_mode text NOT NULL DEFAULT 'off',
  ADD COLUMN IF NOT EXISTS customer_phone_e164 text,
  ADD COLUMN IF NOT EXISTS inventory_phone_id uuid,
  ADD COLUMN IF NOT EXISTS forwarding_setup_status text NOT NULL DEFAULT 'unallocated',
  ADD COLUMN IF NOT EXISTS forwarding_verification_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS forwarding_verified_at timestamptz,
  ADD COLUMN IF NOT EXISTS forwarding_verification_call_id text;

ALTER TABLE public.business_telephony_settings
  DROP CONSTRAINT IF EXISTS business_telephony_settings_answering_mode_check,
  ADD CONSTRAINT business_telephony_settings_answering_mode_check
    CHECK (answering_mode IN ('off','text_link','ai_receptionist')),
  DROP CONSTRAINT IF EXISTS business_telephony_settings_forwarding_setup_status_check,
  ADD CONSTRAINT business_telephony_settings_forwarding_setup_status_check
    CHECK (forwarding_setup_status IN ('unallocated','reserved','pending_verification','verified','error'));

CREATE TABLE IF NOT EXISTS public.platform_phone_inventory (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL,
  provider_phone_id text NOT NULL,
  phone_number text NOT NULL,
  voice_capable boolean NOT NULL DEFAULT true,
  sms_capable boolean NOT NULL DEFAULT true,
  monthly_cost_aud numeric(12,4),
  status text NOT NULL DEFAULT 'available'
    CHECK (status IN ('available','reserved','assigned','disabled')),
  reserved_business_id uuid REFERENCES public.businesses(id) ON DELETE SET NULL,
  reserved_at timestamptz,
  reservation_expires_at timestamptz,
  assigned_business_id uuid REFERENCES public.businesses(id) ON DELETE SET NULL,
  assigned_at timestamptz,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT platform_phone_inventory_provider_id_uk UNIQUE (provider, provider_phone_id),
  CONSTRAINT platform_phone_inventory_number_uk UNIQUE (phone_number),
  CONSTRAINT platform_phone_inventory_state_check CHECK (
    (status = 'available' AND reserved_business_id IS NULL AND assigned_business_id IS NULL)
    OR (status = 'reserved' AND reserved_business_id IS NOT NULL AND assigned_business_id IS NULL)
    OR (status = 'assigned' AND assigned_business_id IS NOT NULL)
    OR status = 'disabled'
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS platform_phone_inventory_reserved_business_uk
  ON public.platform_phone_inventory (reserved_business_id)
  WHERE status = 'reserved' AND reserved_business_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS platform_phone_inventory_assigned_business_uk
  ON public.platform_phone_inventory (assigned_business_id)
  WHERE status = 'assigned' AND assigned_business_id IS NOT NULL;

ALTER TABLE public.business_telephony_settings
  DROP CONSTRAINT IF EXISTS business_telephony_settings_inventory_phone_id_fkey,
  ADD CONSTRAINT business_telephony_settings_inventory_phone_id_fkey
    FOREIGN KEY (inventory_phone_id) REFERENCES public.platform_phone_inventory(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS business_telephony_settings_inventory_phone_uk
  ON public.business_telephony_settings (inventory_phone_id)
  WHERE inventory_phone_id IS NOT NULL;

GRANT ALL ON public.platform_phone_inventory TO service_role;
REVOKE ALL ON public.platform_phone_inventory FROM anon, authenticated;
ALTER TABLE public.platform_phone_inventory ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Service role manages platform phone inventory" ON public.platform_phone_inventory;
CREATE POLICY "Service role manages platform phone inventory"
  ON public.platform_phone_inventory FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP TRIGGER IF EXISTS trg_platform_phone_inventory_updated ON public.platform_phone_inventory;
CREATE TRIGGER trg_platform_phone_inventory_updated
  BEFORE UPDATE ON public.platform_phone_inventory
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE IF NOT EXISTS public.telephony_provider_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL,
  event_type text NOT NULL,
  provider_event_id text NOT NULL,
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'processing'
    CHECK (status IN ('processing','processed','failed','ignored')),
  workflow text NOT NULL CHECK (workflow IN ('off','text_link','ai_receptionist')),
  missed_call_id text,
  sms_event_id text,
  error_message text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT telephony_provider_events_replay_uk
    UNIQUE (provider, event_type, provider_event_id)
);

CREATE INDEX IF NOT EXISTS telephony_provider_events_business_created_idx
  ON public.telephony_provider_events (business_id, created_at DESC);
GRANT ALL ON public.telephony_provider_events TO service_role;
REVOKE ALL ON public.telephony_provider_events FROM anon, authenticated;
ALTER TABLE public.telephony_provider_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Service role manages telephony provider events" ON public.telephony_provider_events;
CREATE POLICY "Service role manages telephony provider events"
  ON public.telephony_provider_events FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP TRIGGER IF EXISTS trg_telephony_provider_events_updated ON public.telephony_provider_events;
CREATE TRIGGER trg_telephony_provider_events_updated
  BEFORE UPDATE ON public.telephony_provider_events
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Backfill the normalised customer number only where the existing value is
-- already an unambiguous Australian E.164 value. Application writes perform
-- the broader local-format normalisation.
UPDATE public.business_telephony_settings bt
SET customer_phone_e164 = b.public_phone
FROM public.businesses b
WHERE b.id = bt.business_id
  AND bt.customer_phone_e164 IS NULL
  AND b.public_phone ~ '^\+61[0-9]{6,10}$';

-- Preserve existing proven live routes without naming a tenant or provider
-- object. AI is selected only when all of the stable database invariants are
-- already present. Otherwise a proven live Text Link configuration is
-- retained; all ambiguous rows safely become Off.
UPDATE public.business_telephony_settings bt
SET answering_mode = CASE
  WHEN EXISTS (
    SELECT 1
    FROM public.business_ai_receptionist_settings ai
    JOIN public.ai_provider_mappings pm
      ON pm.business_id = ai.business_id
     AND pm.provider = ai.provider
     AND pm.active = true
     AND (
       (ai.provider_assistant_id IS NOT NULL AND pm.provider_assistant_id = ai.provider_assistant_id)
       OR (ai.provider_phone_id IS NOT NULL AND pm.provider_phone_id = ai.provider_phone_id)
       OR (ai.provider_phone_number IS NOT NULL AND pm.provider_phone_number = ai.provider_phone_number)
     )
    WHERE ai.business_id = bt.business_id
      AND ai.enabled = true
      AND ai.mode = 'live'
      AND ai.status = 'active'
  ) THEN 'ai_receptionist'
  WHEN EXISTS (
    SELECT 1 FROM public.business_missed_call_settings mc
    WHERE mc.business_id = bt.business_id
      AND mc.enabled = true
      AND mc.mode = 'live'
      AND mc.recovery_sms_enabled = true
  ) THEN 'text_link'
  ELSE 'off'
END;

UPDATE public.business_missed_call_settings mc
SET enabled = (bt.answering_mode = 'text_link'),
    mode = CASE WHEN bt.answering_mode = 'text_link' THEN 'live' ELSE 'demo' END,
    recovery_sms_enabled = CASE
      WHEN bt.answering_mode = 'text_link' THEN true
      ELSE mc.recovery_sms_enabled
    END
FROM public.business_telephony_settings bt
WHERE bt.business_id = mc.business_id;

UPDATE public.business_ai_receptionist_settings ai
SET enabled = (bt.answering_mode = 'ai_receptionist'),
    mode = CASE WHEN bt.answering_mode = 'ai_receptionist' THEN 'live' ELSE 'demo' END
FROM public.business_telephony_settings bt
WHERE bt.business_id = ai.business_id;

CREATE OR REPLACE FUNCTION public.assert_call_handling_consistent()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  bid uuid := NEW.business_id;
  selected_mode text;
  mc record;
  ai record;
BEGIN
  SELECT answering_mode INTO selected_mode
  FROM public.business_telephony_settings WHERE business_id = bid;
  SELECT enabled, mode, recovery_sms_enabled INTO mc
  FROM public.business_missed_call_settings WHERE business_id = bid;
  SELECT enabled, mode INTO ai
  FROM public.business_ai_receptionist_settings WHERE business_id = bid;

  IF selected_mode IS NULL OR mc.enabled IS NULL OR ai.enabled IS NULL THEN
    RETURN NEW;
  END IF;

  IF selected_mode = 'off' AND (mc.enabled OR ai.enabled) THEN
    RAISE EXCEPTION 'Off mode cannot enable a customer call workflow' USING ERRCODE = '23514';
  ELSIF selected_mode = 'text_link'
    AND (NOT mc.enabled OR mc.mode <> 'live' OR NOT mc.recovery_sms_enabled OR ai.enabled) THEN
    RAISE EXCEPTION 'Text Link must be the only active inbound workflow' USING ERRCODE = '23514';
  ELSIF selected_mode = 'ai_receptionist'
    AND (NOT ai.enabled OR ai.mode <> 'live' OR mc.enabled) THEN
    RAISE EXCEPTION 'AI Receptionist must be the only active inbound workflow' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_call_mode_consistency_telephony ON public.business_telephony_settings;
CREATE CONSTRAINT TRIGGER trg_call_mode_consistency_telephony
  AFTER INSERT OR UPDATE ON public.business_telephony_settings
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION public.assert_call_handling_consistent();
DROP TRIGGER IF EXISTS trg_call_mode_consistency_text_link ON public.business_missed_call_settings;
CREATE CONSTRAINT TRIGGER trg_call_mode_consistency_text_link
  AFTER INSERT OR UPDATE ON public.business_missed_call_settings
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION public.assert_call_handling_consistent();
DROP TRIGGER IF EXISTS trg_call_mode_consistency_ai ON public.business_ai_receptionist_settings;
CREATE CONSTRAINT TRIGGER trg_call_mode_consistency_ai
  AFTER INSERT OR UPDATE ON public.business_ai_receptionist_settings
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION public.assert_call_handling_consistent();

CREATE OR REPLACE FUNCTION public.call_handling_admin_business()
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT bu.business_id
  FROM public.business_users bu
  WHERE bu.user_id = auth.uid()
    AND bu.role IN ('owner','admin')
  LIMIT 1
$$;
REVOKE EXECUTE ON FUNCTION public.call_handling_admin_business() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.call_handling_admin_business() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.enforce_business_phone_authority()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.public_phone IS DISTINCT FROM OLD.public_phone
    AND auth.uid() IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM public.business_users bu
      WHERE bu.business_id = OLD.id
        AND bu.user_id = auth.uid()
        AND bu.role IN ('owner','admin')
    ) THEN
    RAISE EXCEPTION 'Owner or admin access is required to change the business phone'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_business_phone_authority ON public.businesses;
CREATE TRIGGER trg_business_phone_authority
  BEFORE UPDATE OF public_phone ON public.businesses
  FOR EACH ROW EXECUTE FUNCTION public.enforce_business_phone_authority();

CREATE OR REPLACE FUNCTION public.set_my_customer_phone(_phone_e164 text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE bid uuid;
BEGIN
  bid := public.call_handling_admin_business();
  IF bid IS NULL THEN
    RAISE EXCEPTION 'Owner or admin access is required' USING ERRCODE = '42501';
  END IF;
  IF _phone_e164 !~ '^\+61[0-9]{6,10}$' THEN
    RAISE EXCEPTION 'A valid Australian E.164 number is required' USING ERRCODE = '22023';
  END IF;
  UPDATE public.businesses SET public_phone = _phone_e164 WHERE id = bid;
  INSERT INTO public.business_telephony_settings (business_id, customer_phone_e164)
  VALUES (bid, _phone_e164)
  ON CONFLICT (business_id) DO UPDATE SET customer_phone_e164 = EXCLUDED.customer_phone_e164;
END $$;
REVOKE EXECUTE ON FUNCTION public.set_my_customer_phone(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_my_customer_phone(text) TO authenticated;

CREATE OR REPLACE FUNCTION public.reserve_my_platform_phone()
RETURNS TABLE (inventory_id uuid, forwarding_number text, verification_status text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  bid uuid;
  phone_row public.platform_phone_inventory%ROWTYPE;
  customer_phone text;
BEGIN
  bid := public.call_handling_admin_business();
  IF bid IS NULL THEN
    RAISE EXCEPTION 'Owner or admin access is required' USING ERRCODE = '42501';
  END IF;

  SELECT i.* INTO phone_row
  FROM public.platform_phone_inventory i
  WHERE (i.reserved_business_id = bid OR i.assigned_business_id = bid)
    AND i.status IN ('reserved','assigned')
  LIMIT 1;
  IF FOUND THEN
    RETURN QUERY SELECT phone_row.id, phone_row.phone_number,
      CASE WHEN phone_row.status = 'assigned' THEN 'verified' ELSE 'pending_verification' END;
    RETURN;
  END IF;

  SELECT b.public_phone INTO customer_phone FROM public.businesses b WHERE b.id = bid;
  IF customer_phone IS NULL OR customer_phone !~ '^\+61[0-9]{6,10}$' THEN
    RAISE EXCEPTION 'Save a valid Australian business phone before allocating a forwarding number'
      USING ERRCODE = '23514';
  END IF;

  SELECT i.* INTO phone_row
  FROM public.platform_phone_inventory i
  WHERE i.status = 'available' AND i.voice_capable AND i.sms_capable
  ORDER BY i.monthly_cost_aud ASC NULLS LAST, i.created_at ASC, i.id ASC
  FOR UPDATE SKIP LOCKED
  LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'No forwarding numbers are currently available' USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.platform_phone_inventory
  SET status = 'reserved',
      reserved_business_id = bid,
      reserved_at = now(),
      reservation_expires_at = now() + interval '7 days'
  WHERE id = phone_row.id;

  UPDATE public.business_telephony_settings
  SET inventory_phone_id = phone_row.id,
      inbound_number = phone_row.phone_number,
      forwarding_number = customer_phone,
      customer_phone_e164 = customer_phone,
      provider = phone_row.provider,
      provider_phone_id = phone_row.provider_phone_id,
      live_status = 'pending',
      forwarding_setup_status = 'reserved',
      forwarding_verification_expires_at = NULL
  WHERE business_id = bid;

  RETURN QUERY SELECT phone_row.id, phone_row.phone_number, 'reserved'::text;
END $$;
REVOKE EXECUTE ON FUNCTION public.reserve_my_platform_phone() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reserve_my_platform_phone() TO authenticated;

CREATE OR REPLACE FUNCTION public.start_my_forwarding_verification()
RETURNS timestamptz LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  bid uuid;
  expires_at_value timestamptz := now() + interval '15 minutes';
BEGIN
  bid := public.call_handling_admin_business();
  IF bid IS NULL THEN
    RAISE EXCEPTION 'Owner or admin access is required' USING ERRCODE = '42501';
  END IF;
  UPDATE public.business_telephony_settings
  SET forwarding_setup_status = 'pending_verification',
      forwarding_verification_expires_at = expires_at_value
  WHERE business_id = bid
    AND inventory_phone_id IS NOT NULL
    AND forwarding_setup_status IN ('reserved','pending_verification','error');
  IF NOT FOUND THEN
    RAISE EXCEPTION 'A reserved forwarding number is required' USING ERRCODE = '23514';
  END IF;
  RETURN expires_at_value;
END $$;
REVOKE EXECUTE ON FUNCTION public.start_my_forwarding_verification() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.start_my_forwarding_verification() TO authenticated;

CREATE OR REPLACE FUNCTION public.set_my_call_handling_mode(_mode text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  bid uuid;
  tel record;
  ai_ready boolean;
BEGIN
  bid := public.call_handling_admin_business();
  IF bid IS NULL THEN
    RAISE EXCEPTION 'Owner or admin access is required' USING ERRCODE = '42501';
  END IF;
  IF _mode NOT IN ('off','text_link','ai_receptionist') THEN
    RAISE EXCEPTION 'Invalid call handling mode' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO tel FROM public.business_telephony_settings WHERE business_id = bid;
  IF _mode <> 'off' AND (tel.inventory_phone_id IS NULL OR tel.inbound_number IS NULL) THEN
    RAISE EXCEPTION 'Allocate a forwarding number before enabling call handling'
      USING ERRCODE = '23514';
  END IF;
  IF _mode <> 'off' AND tel.forwarding_setup_status <> 'verified' THEN
    RAISE EXCEPTION 'Verify no-answer forwarding before enabling call handling'
      USING ERRCODE = '23514';
  END IF;
  IF _mode = 'text_link' AND NOT public.has_missed_call_access(bid) THEN
    RAISE EXCEPTION 'Current subscription does not include Text Link' USING ERRCODE = '42501';
  END IF;
  IF _mode = 'ai_receptionist' AND NOT public.has_ai_receptionist_access(bid) THEN
    RAISE EXCEPTION 'Current subscription does not include AI Receptionist' USING ERRCODE = '42501';
  END IF;
  IF _mode = 'ai_receptionist' THEN
    SELECT EXISTS (
      SELECT 1 FROM public.business_ai_receptionist_settings ai
      JOIN public.ai_provider_mappings pm ON pm.business_id = ai.business_id AND pm.active
      WHERE ai.business_id = bid
        AND ai.status = 'active'
        AND ai.provider_assistant_id IS NOT NULL
        AND pm.provider = ai.provider
        AND pm.provider_assistant_id = ai.provider_assistant_id
    ) INTO ai_ready;
    IF NOT ai_ready THEN
      RAISE EXCEPTION 'AI provider setup is not active' USING ERRCODE = '23514';
    END IF;
  END IF;

  UPDATE public.business_telephony_settings SET answering_mode = _mode WHERE business_id = bid;
  UPDATE public.business_missed_call_settings
  SET enabled = (_mode = 'text_link'),
      mode = CASE WHEN _mode = 'text_link' THEN 'live' ELSE 'demo' END,
      recovery_sms_enabled = CASE WHEN _mode = 'text_link' THEN true ELSE recovery_sms_enabled END
  WHERE business_id = bid;
  UPDATE public.business_ai_receptionist_settings
  SET enabled = (_mode = 'ai_receptionist'),
      mode = CASE WHEN _mode = 'ai_receptionist' THEN 'live' ELSE 'demo' END
  WHERE business_id = bid;
END $$;
REVOKE EXECUTE ON FUNCTION public.set_my_call_handling_mode(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_my_call_handling_mode(text) TO authenticated;

CREATE OR REPLACE FUNCTION public.resolve_call_handling_tenant(
  _provider text,
  _phone_id text,
  _phone_number text
) RETURNS TABLE (
  business_id uuid,
  answering_mode text,
  forwarding_setup_status text,
  business_name text,
  business_slug text,
  public_phone text,
  assistant_id text,
  sms_template text,
  text_link_entitled boolean,
  ai_receptionist_entitled boolean
) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT bt.business_id, bt.answering_mode, bt.forwarding_setup_status,
    b.name, b.slug, b.public_phone, ai.provider_assistant_id, mc.sms_template,
    public.has_missed_call_access(bt.business_id),
    public.has_ai_receptionist_access(bt.business_id)
  FROM public.business_telephony_settings bt
  JOIN public.businesses b ON b.id = bt.business_id AND b.active
  LEFT JOIN public.business_ai_receptionist_settings ai ON ai.business_id = bt.business_id
  LEFT JOIN public.business_missed_call_settings mc ON mc.business_id = bt.business_id
  WHERE (
    (_phone_id IS NOT NULL AND bt.provider = COALESCE(_provider, bt.provider)
      AND bt.provider_phone_id = _phone_id)
    OR (_phone_number IS NOT NULL AND bt.inbound_number = _phone_number)
  )
  LIMIT 1
$$;
REVOKE EXECUTE ON FUNCTION public.resolve_call_handling_tenant(text,text,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_call_handling_tenant(text,text,text) TO service_role;

CREATE OR REPLACE FUNCTION public.mark_forwarding_verified(
  _business_id uuid,
  _provider_call_id text
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE inventory_id_value uuid;
BEGIN
  SELECT inventory_phone_id INTO inventory_id_value
  FROM public.business_telephony_settings
  WHERE business_id = _business_id
    AND forwarding_setup_status = 'pending_verification'
    AND forwarding_verification_expires_at > now()
  FOR UPDATE;
  IF inventory_id_value IS NULL THEN RETURN; END IF;

  UPDATE public.platform_phone_inventory
  SET status = 'assigned',
      assigned_business_id = _business_id,
      assigned_at = COALESCE(assigned_at, now()),
      reserved_business_id = NULL,
      reserved_at = NULL,
      reservation_expires_at = NULL
  WHERE id = inventory_id_value
    AND (reserved_business_id = _business_id OR assigned_business_id = _business_id);

  UPDATE public.business_telephony_settings
  SET forwarding_setup_status = 'verified',
      forwarding_verified_at = COALESCE(forwarding_verified_at, now()),
      forwarding_verification_expires_at = NULL,
      forwarding_verification_call_id =
        COALESCE(forwarding_verification_call_id, _provider_call_id),
      live_status = 'active',
      activated_at = COALESCE(activated_at, now())
  WHERE business_id = _business_id;
END $$;
REVOKE EXECUTE ON FUNCTION public.mark_forwarding_verified(uuid,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mark_forwarding_verified(uuid,text) TO service_role;

-- Direct writes can no longer bypass the authoritative mode RPC. Customers
-- retain access to non-routing message/script preferences.
REVOKE INSERT, UPDATE, DELETE ON public.business_telephony_settings FROM authenticated;
GRANT SELECT ON public.business_telephony_settings TO authenticated;
REVOKE UPDATE ON public.business_missed_call_settings FROM authenticated;
GRANT UPDATE (
  sms_template, plumber_alert_enabled, alert_method, alert_phone, alert_email, callback_message
) ON public.business_missed_call_settings TO authenticated;
REVOKE UPDATE ON public.business_ai_receptionist_settings FROM authenticated;
GRANT UPDATE (
  assistant_name, first_message, voice_provider, voice_id, language, tone,
  callback_message, pricing_response, human_request_response, emergency_response,
  max_call_duration_seconds, recording_enabled, transcript_enabled, ai_summary_enabled
) ON public.business_ai_receptionist_settings TO authenticated;
