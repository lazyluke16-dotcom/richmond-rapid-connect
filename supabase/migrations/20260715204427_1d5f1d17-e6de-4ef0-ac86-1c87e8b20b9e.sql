
-- ============================================================
-- Phase 2D: Missed-Call Recovery product schema
-- ============================================================

-- 1. Missed-call settings, one row per business, tenant-scoped.
CREATE TABLE public.business_missed_call_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL UNIQUE REFERENCES public.businesses(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  mode text NOT NULL DEFAULT 'demo' CHECK (mode IN ('demo','live')),
  recovery_sms_enabled boolean NOT NULL DEFAULT true,
  sms_template text NOT NULL DEFAULT 'Hi, sorry we missed your call to {{business_name}}. Tell us what you need here and we''ll get back to you as soon as possible: {{recovery_link}}',
  plumber_alert_enabled boolean NOT NULL DEFAULT true,
  alert_method text NOT NULL DEFAULT 'demo' CHECK (alert_method IN ('demo','sms','email')),
  alert_phone text,
  alert_email text,
  callback_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.business_missed_call_settings TO authenticated;
GRANT ALL ON public.business_missed_call_settings TO service_role;
ALTER TABLE public.business_missed_call_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "mcs_tenant_select" ON public.business_missed_call_settings
  FOR SELECT TO authenticated
  USING (business_id = public.current_business_id());
CREATE POLICY "mcs_tenant_insert" ON public.business_missed_call_settings
  FOR INSERT TO authenticated
  WITH CHECK (business_id = public.current_business_id());
CREATE POLICY "mcs_tenant_update" ON public.business_missed_call_settings
  FOR UPDATE TO authenticated
  USING (business_id = public.current_business_id())
  WITH CHECK (business_id = public.current_business_id());
CREATE POLICY "mcs_service_role" ON public.business_missed_call_settings
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE TRIGGER mcs_set_updated_at BEFORE UPDATE ON public.business_missed_call_settings
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- 2. Telephony settings placeholder for future live inbound routing.
CREATE TABLE public.business_telephony_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL UNIQUE REFERENCES public.businesses(id) ON DELETE CASCADE,
  inbound_number text,
  forwarding_number text,
  provider text,
  provider_phone_id text,
  live_status text NOT NULL DEFAULT 'inactive' CHECK (live_status IN ('inactive','pending','active','suspended')),
  activated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.business_telephony_settings TO authenticated;
GRANT ALL ON public.business_telephony_settings TO service_role;
ALTER TABLE public.business_telephony_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tel_tenant_select" ON public.business_telephony_settings
  FOR SELECT TO authenticated
  USING (business_id = public.current_business_id());
CREATE POLICY "tel_tenant_write" ON public.business_telephony_settings
  FOR ALL TO authenticated
  USING (business_id = public.current_business_id())
  WITH CHECK (business_id = public.current_business_id());
CREATE POLICY "tel_service_role" ON public.business_telephony_settings
  FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE TRIGGER tel_set_updated_at BEFORE UPDATE ON public.business_telephony_settings
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- 3. Extend sms_events with an event_type discriminator so plumber alerts
-- can reuse the same tenant-scoped table.
ALTER TABLE public.sms_events
  ADD COLUMN IF NOT EXISTS event_type text NOT NULL DEFAULT 'customer_recovery_sms';

-- 4. Feature-access helper: does business have a plan that unlocks
-- missed-call recovery, and is any trial still valid?
CREATE OR REPLACE FUNCTION public.has_missed_call_access(_business_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.businesses b
    WHERE b.id = _business_id
      AND b.selected_plan IN ('missed_call_recovery','ai_receptionist')
      AND (b.trial_ends_at IS NULL OR b.trial_ends_at > now())
  )
$$;
GRANT EXECUTE ON FUNCTION public.has_missed_call_access(uuid) TO authenticated, anon, service_role;

-- 5. Feature-state resolver.
CREATE OR REPLACE FUNCTION public.business_feature_state(_business_id uuid)
RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE b record;
BEGIN
  SELECT selected_plan, trial_started_at, trial_ends_at, active
  INTO b FROM public.businesses WHERE id = _business_id;
  IF NOT FOUND THEN RETURN 'unknown'; END IF;
  IF NOT b.active THEN RETURN 'suspended'; END IF;
  IF b.selected_plan IS NULL THEN RETURN 'setup'; END IF;
  IF b.trial_ends_at IS NOT NULL AND b.trial_ends_at < now() THEN RETURN 'trial_expired'; END IF;
  IF b.trial_ends_at IS NOT NULL AND b.trial_ends_at > now() THEN RETURN 'trial_active'; END IF;
  RETURN 'active';
END $$;
GRANT EXECUTE ON FUNCTION public.business_feature_state(uuid) TO authenticated, service_role;

-- 6. Auto-seed default settings whenever a business is created.
CREATE OR REPLACE FUNCTION public.seed_business_defaults()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.business_missed_call_settings (business_id)
    VALUES (NEW.id) ON CONFLICT (business_id) DO NOTHING;
  INSERT INTO public.business_telephony_settings (business_id)
    VALUES (NEW.id) ON CONFLICT (business_id) DO NOTHING;
  RETURN NEW;
END $$;
CREATE TRIGGER businesses_seed_defaults AFTER INSERT ON public.businesses
  FOR EACH ROW EXECUTE FUNCTION public.seed_business_defaults();

-- 7. Backfill existing tenants.
INSERT INTO public.business_missed_call_settings (business_id)
  SELECT id FROM public.businesses ON CONFLICT (business_id) DO NOTHING;
INSERT INTO public.business_telephony_settings (business_id)
  SELECT id FROM public.businesses ON CONFLICT (business_id) DO NOTHING;

-- 8. Give Richmond + BlueWave a plan + active trial so Phase 2D flows work.
UPDATE public.businesses
SET selected_plan = COALESCE(selected_plan, 'missed_call_recovery'),
    trial_started_at = COALESCE(trial_started_at, now()),
    trial_ends_at = COALESCE(trial_ends_at, now() + interval '30 days')
WHERE slug IN ('richmond-rapid-plumbing','bluewave-plumbing');

-- 9. Attribution-integrity helper: validate that a supplied missed-call id
-- belongs to the resolved business. Called by the public lead-insert path.
CREATE OR REPLACE FUNCTION public.validate_missed_call_attribution(_mcid text, _business_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.missed_calls
    WHERE id = _mcid AND business_id = _business_id
  )
$$;
GRANT EXECUTE ON FUNCTION public.validate_missed_call_attribution(text, uuid)
  TO authenticated, anon, service_role;
