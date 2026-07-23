
-- Phase 2E: AI Receptionist multi-tenant infrastructure

-- 1) AI receptionist settings (one row per business)
CREATE TABLE public.business_ai_receptionist_settings (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  business_id UUID NOT NULL UNIQUE REFERENCES public.businesses(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT false,
  mode TEXT NOT NULL DEFAULT 'demo' CHECK (mode IN ('demo','live')),
  assistant_name TEXT NOT NULL DEFAULT 'Reception',
  first_message TEXT NOT NULL DEFAULT 'Hi, thanks for calling. How can I help you today?',
  voice_provider TEXT,
  voice_id TEXT,
  language TEXT NOT NULL DEFAULT 'en-AU',
  tone TEXT NOT NULL DEFAULT 'friendly, professional, concise',
  callback_message TEXT NOT NULL DEFAULT 'A plumber will call you back shortly to confirm.',
  pricing_response TEXT NOT NULL DEFAULT 'Pricing depends on the job. A plumber will confirm a quote when they call you back.',
  human_request_response TEXT NOT NULL DEFAULT 'I can take your details now and a plumber will call you straight back.',
  emergency_response TEXT NOT NULL DEFAULT 'That sounds urgent. I''ll flag this as an emergency and get a plumber to call you as soon as possible. Can I confirm your name, suburb, and phone number?',
  max_call_duration_seconds INT NOT NULL DEFAULT 300 CHECK (max_call_duration_seconds BETWEEN 30 AND 900),
  recording_enabled BOOLEAN NOT NULL DEFAULT false,
  transcript_enabled BOOLEAN NOT NULL DEFAULT true,
  ai_summary_enabled BOOLEAN NOT NULL DEFAULT true,
  provider TEXT NOT NULL DEFAULT 'vapi',
  provider_assistant_id TEXT,
  provider_phone_id TEXT,
  provider_phone_number TEXT,
  status TEXT NOT NULL DEFAULT 'inactive' CHECK (status IN ('inactive','pending','active','error')),
  activated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT, UPDATE ON public.business_ai_receptionist_settings TO authenticated;
GRANT ALL ON public.business_ai_receptionist_settings TO service_role;

ALTER TABLE public.business_ai_receptionist_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Tenant members read ai settings"
  ON public.business_ai_receptionist_settings FOR SELECT TO authenticated
  USING (business_id = public.current_business_id());

CREATE POLICY "Tenant members update ai settings"
  ON public.business_ai_receptionist_settings FOR UPDATE TO authenticated
  USING (business_id = public.current_business_id())
  WITH CHECK (business_id = public.current_business_id());

CREATE TRIGGER trg_bars_updated
  BEFORE UPDATE ON public.business_ai_receptionist_settings
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- 2) Trusted provider->tenant mapping (service-role only)
CREATE TABLE public.ai_provider_mappings (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  business_id UUID NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  provider TEXT NOT NULL DEFAULT 'vapi',
  provider_assistant_id TEXT,
  provider_phone_id TEXT,
  provider_phone_number TEXT,
  integration_token_hash TEXT, -- sha256 of a per-tenant generic webhook token
  active BOOLEAN NOT NULL DEFAULT true,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ai_provider_mappings_assistant_uk
  ON public.ai_provider_mappings(provider, provider_assistant_id)
  WHERE provider_assistant_id IS NOT NULL;
CREATE UNIQUE INDEX ai_provider_mappings_phone_id_uk
  ON public.ai_provider_mappings(provider, provider_phone_id)
  WHERE provider_phone_id IS NOT NULL;
CREATE UNIQUE INDEX ai_provider_mappings_phone_number_uk
  ON public.ai_provider_mappings(provider, provider_phone_number)
  WHERE provider_phone_number IS NOT NULL;
CREATE UNIQUE INDEX ai_provider_mappings_token_uk
  ON public.ai_provider_mappings(integration_token_hash)
  WHERE integration_token_hash IS NOT NULL;

GRANT ALL ON public.ai_provider_mappings TO service_role;
-- No grants to authenticated/anon: this is provider secret metadata.

ALTER TABLE public.ai_provider_mappings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role manages ai provider mappings"
  ON public.ai_provider_mappings FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE TRIGGER trg_apm_updated
  BEFORE UPDATE ON public.ai_provider_mappings
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- 3) Leads: idempotency on external_call_id per source (avoid duplicate AI leads)
CREATE UNIQUE INDEX IF NOT EXISTS leads_source_external_call_uk
  ON public.leads(source, external_call_id)
  WHERE external_call_id IS NOT NULL;

-- 4) has_ai_receptionist_access gating RPC
CREATE OR REPLACE FUNCTION public.has_ai_receptionist_access(_business_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.businesses b
    WHERE b.id = _business_id
      AND b.selected_plan = 'ai_receptionist'
      AND b.active
      AND (b.trial_ends_at IS NULL OR b.trial_ends_at > now())
  )
$$;

GRANT EXECUTE ON FUNCTION public.has_ai_receptionist_access(uuid) TO authenticated, service_role;

-- 5) Trusted tenant resolver used by webhooks (service-role callers).
CREATE OR REPLACE FUNCTION public.resolve_ai_tenant(
  _provider text,
  _assistant_id text,
  _phone_id text,
  _phone_number text
) RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT business_id FROM public.ai_provider_mappings
  WHERE active = true AND provider = COALESCE(_provider,'vapi')
    AND (
      (_assistant_id IS NOT NULL AND provider_assistant_id = _assistant_id) OR
      (_phone_id IS NOT NULL AND provider_phone_id = _phone_id) OR
      (_phone_number IS NOT NULL AND provider_phone_number = _phone_number)
    )
  LIMIT 1
$$;
REVOKE EXECUTE ON FUNCTION public.resolve_ai_tenant(text,text,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_ai_tenant(text,text,text,text) TO service_role;

-- 6) Extend seed_business_defaults to include AI settings row for new businesses
CREATE OR REPLACE FUNCTION public.seed_business_defaults()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.business_missed_call_settings (business_id)
    VALUES (NEW.id) ON CONFLICT (business_id) DO NOTHING;
  INSERT INTO public.business_telephony_settings (business_id)
    VALUES (NEW.id) ON CONFLICT (business_id) DO NOTHING;
  INSERT INTO public.business_ai_receptionist_settings (business_id)
    VALUES (NEW.id) ON CONFLICT (business_id) DO NOTHING;
  RETURN NEW;
END $$;

-- Backfill AI settings rows for existing businesses.
INSERT INTO public.business_ai_receptionist_settings (business_id)
  SELECT id FROM public.businesses
  ON CONFLICT (business_id) DO NOTHING;

-- 7) Extend sms_events.event_type usage (already text). Nothing to alter.
