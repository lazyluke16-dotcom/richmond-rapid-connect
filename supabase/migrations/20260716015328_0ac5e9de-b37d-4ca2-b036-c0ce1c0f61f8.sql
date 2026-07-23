
-- ============================================================
-- Phase 2F Turn 1 — Billing architecture (no Stripe yet)
-- ============================================================

ALTER TABLE public.businesses
  ADD COLUMN IF NOT EXISTS billing_exempt boolean NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION public.enforce_billing_exempt_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.billing_exempt IS DISTINCT FROM OLD.billing_exempt
     AND current_user = 'authenticated' THEN
    RAISE EXCEPTION 'billing_exempt can only be changed by service role' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_businesses_billing_exempt_lock ON public.businesses;
CREATE TRIGGER trg_businesses_billing_exempt_lock
  BEFORE UPDATE ON public.businesses
  FOR EACH ROW EXECUTE FUNCTION public.enforce_billing_exempt_immutable();

UPDATE public.businesses SET billing_exempt = true
 WHERE slug IN ('richmond-rapid-plumbing','bluewave-plumbing','harbour-plumbing-co');

-- business_billing
CREATE TABLE IF NOT EXISTS public.business_billing (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL UNIQUE REFERENCES public.businesses(id) ON DELETE CASCADE,
  selected_plan text CHECK (selected_plan IN ('missed_call_recovery','ai_receptionist')),
  billing_status text NOT NULL DEFAULT 'setup'
    CHECK (billing_status IN ('setup','checkout_pending','active','past_due','suspended','canceled')),
  stripe_customer_id text UNIQUE,
  stripe_subscription_id text UNIQUE,
  stripe_base_price_id text,
  stripe_usage_price_id text,
  stripe_subscription_status text,
  union_offer_eligible boolean NOT NULL DEFAULT false,
  union_offer_redeemed_at timestamptz,
  platform_fee_waiver_ends_at timestamptz,
  billing_cycle_anchor timestamptz,
  current_period_start timestamptz,
  current_period_end timestamptz,
  grace_started_at timestamptz,
  grace_expires_at timestamptz,
  suspended_at timestamptz,
  canceled_at timestamptz,
  successful_invoice_count integer NOT NULL DEFAULT 0,
  usage_limit_cents integer NOT NULL DEFAULT 10000,
  past_due_usage_limit_cents integer NOT NULL DEFAULT 1000,
  last_synced_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.business_billing TO authenticated;
GRANT ALL ON public.business_billing TO service_role;
ALTER TABLE public.business_billing ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Tenant members read own billing" ON public.business_billing;
CREATE POLICY "Tenant members read own billing"
  ON public.business_billing FOR SELECT TO authenticated
  USING (business_id = current_business_id());

DROP POLICY IF EXISTS "Service role manages billing" ON public.business_billing;
CREATE POLICY "Service role manages billing"
  ON public.business_billing FOR ALL TO service_role
  USING (true) WITH CHECK (true);

DROP TRIGGER IF EXISTS trg_business_billing_updated ON public.business_billing;
CREATE TRIGGER trg_business_billing_updated
  BEFORE UPDATE ON public.business_billing
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

INSERT INTO public.business_billing (business_id, selected_plan, union_offer_eligible)
SELECT b.id, b.selected_plan, COALESCE(b.partner_code = 'union-member', false)
  FROM public.businesses b
  LEFT JOIN public.business_billing bb ON bb.business_id = b.id
 WHERE bb.id IS NULL;

CREATE OR REPLACE FUNCTION public.seed_business_defaults()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.business_missed_call_settings (business_id) VALUES (NEW.id) ON CONFLICT (business_id) DO NOTHING;
  INSERT INTO public.business_telephony_settings (business_id) VALUES (NEW.id) ON CONFLICT (business_id) DO NOTHING;
  INSERT INTO public.business_ai_receptionist_settings (business_id) VALUES (NEW.id) ON CONFLICT (business_id) DO NOTHING;
  INSERT INTO public.business_billing (business_id, selected_plan, union_offer_eligible)
    VALUES (NEW.id, NEW.selected_plan, COALESCE(NEW.partner_code = 'union-member', false))
    ON CONFLICT (business_id) DO NOTHING;
  RETURN NEW;
END $$;

-- billing_usage_events
CREATE TABLE IF NOT EXISTS public.billing_usage_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  usage_type text NOT NULL CHECK (usage_type IN ('ai_voice_seconds','outbound_sms')),
  provider text NOT NULL,
  provider_event_id text,
  external_call_id text,
  quantity numeric(20,4) NOT NULL,
  unit text NOT NULL,
  started_at timestamptz,
  ended_at timestamptz,
  billable_seconds integer,
  provider_cost_amount numeric(12,4),
  provider_cost_currency text,
  customer_rate numeric(12,6),
  customer_rate_currency text NOT NULL DEFAULT 'AUD',
  estimated_customer_charge numeric(12,4),
  billable boolean NOT NULL DEFAULT false,
  non_billable_reason text,
  billing_period_start timestamptz,
  billing_period_end timestamptz,
  stripe_meter_event_identifier text,
  stripe_meter_event_status text CHECK (stripe_meter_event_status IN ('pending','sent','failed','skipped')),
  stripe_meter_event_error text,
  stripe_meter_event_sent_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS billing_usage_events_provider_call_uk
  ON public.billing_usage_events (provider, usage_type, external_call_id)
  WHERE external_call_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS billing_usage_events_business_created_idx
  ON public.billing_usage_events (business_id, created_at DESC);

CREATE INDEX IF NOT EXISTS billing_usage_events_meter_pending_idx
  ON public.billing_usage_events (stripe_meter_event_status)
  WHERE stripe_meter_event_status IN ('pending','failed');

GRANT SELECT ON public.billing_usage_events TO authenticated;
GRANT ALL ON public.billing_usage_events TO service_role;
ALTER TABLE public.billing_usage_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Tenant members read own usage" ON public.billing_usage_events;
CREATE POLICY "Tenant members read own usage"
  ON public.billing_usage_events FOR SELECT TO authenticated
  USING (business_id = current_business_id());

DROP POLICY IF EXISTS "Service role manages usage events" ON public.billing_usage_events;
CREATE POLICY "Service role manages usage events"
  ON public.billing_usage_events FOR ALL TO service_role
  USING (true) WITH CHECK (true);

CREATE OR REPLACE FUNCTION public.enforce_usage_event_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_user IN ('authenticated','anon') THEN
    RAISE EXCEPTION 'billing_usage_events is append-only' USING ERRCODE = '42501';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;

DROP TRIGGER IF EXISTS trg_usage_events_immutable ON public.billing_usage_events;
CREATE TRIGGER trg_usage_events_immutable
  BEFORE UPDATE OR DELETE ON public.billing_usage_events
  FOR EACH ROW EXECUTE FUNCTION public.enforce_usage_event_immutable();

-- stripe_webhook_events
CREATE TABLE IF NOT EXISTS public.stripe_webhook_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stripe_event_id text NOT NULL UNIQUE,
  event_type text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  status text NOT NULL DEFAULT 'received' CHECK (status IN ('received','processed','failed','ignored')),
  error_message text,
  business_id uuid REFERENCES public.businesses(id) ON DELETE SET NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS stripe_webhook_events_type_idx
  ON public.stripe_webhook_events (event_type, received_at DESC);

GRANT ALL ON public.stripe_webhook_events TO service_role;
ALTER TABLE public.stripe_webhook_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role manages stripe webhooks" ON public.stripe_webhook_events;
CREATE POLICY "Service role manages stripe webhooks"
  ON public.stripe_webhook_events FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- billing_config
CREATE TABLE IF NOT EXISTS public.billing_config (
  key text PRIMARY KEY,
  value_numeric numeric(20,8),
  value_text text,
  currency text,
  active boolean NOT NULL DEFAULT true,
  notes text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.billing_config TO authenticated;
GRANT ALL ON public.billing_config TO service_role;
ALTER TABLE public.billing_config ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Authenticated read billing config" ON public.billing_config;
CREATE POLICY "Authenticated read billing config"
  ON public.billing_config FOR SELECT TO authenticated
  USING (active = true);

DROP POLICY IF EXISTS "Service role manages billing config" ON public.billing_config;
CREATE POLICY "Service role manages billing config"
  ON public.billing_config FOR ALL TO service_role
  USING (true) WITH CHECK (true);

DROP TRIGGER IF EXISTS trg_billing_config_updated ON public.billing_config;
CREATE TRIGGER trg_billing_config_updated
  BEFORE UPDATE ON public.billing_config
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

INSERT INTO public.billing_config (key, value_numeric, currency, notes) VALUES
  ('ai_voice_per_second_aud', 0.00983333, 'AUD', 'Retail A$0.59 per minute, metered per second'),
  ('ai_voice_per_minute_aud', 0.59, 'AUD', 'Display rate'),
  ('missed_call_base_monthly_aud', 9.00, 'AUD', 'Missed call platform fee'),
  ('ai_receptionist_base_monthly_aud', 15.00, 'AUD', 'AI receptionist platform fee'),
  ('sms_per_message_aud', NULL, 'AUD', 'Not activated — SMS retail rate pending approval'),
  ('grace_period_hours', 48, NULL, 'Payment failure grace period'),
  ('grace_extra_usage_cap_aud', 10.00, 'AUD', 'Max unpaid additional usage exposure during grace')
ON CONFLICT (key) DO NOTHING;

-- effective_billing_state + refactored access checks
CREATE OR REPLACE FUNCTION public.effective_billing_state(_business_id uuid)
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE b record; bb record;
BEGIN
  SELECT id, active, billing_exempt, selected_plan INTO b FROM public.businesses WHERE id = _business_id;
  IF NOT FOUND THEN RETURN 'unknown'; END IF;
  IF NOT b.active THEN RETURN 'suspended'; END IF;
  IF b.billing_exempt THEN RETURN 'billing_exempt_test'; END IF;

  SELECT * INTO bb FROM public.business_billing WHERE business_id = _business_id;
  IF NOT FOUND OR bb.selected_plan IS NULL THEN RETURN 'setup'; END IF;

  IF bb.billing_status = 'canceled' THEN RETURN 'canceled'; END IF;
  IF bb.billing_status = 'suspended' THEN RETURN 'suspended'; END IF;
  IF bb.billing_status = 'past_due' THEN
    IF bb.grace_expires_at IS NOT NULL AND bb.grace_expires_at > now() THEN RETURN 'past_due_grace'; END IF;
    RETURN 'suspended';
  END IF;
  IF bb.billing_status = 'active' THEN RETURN 'active'; END IF;
  IF bb.stripe_subscription_id IS NULL THEN RETURN 'checkout_pending'; END IF;
  RETURN bb.billing_status;
END $$;

CREATE OR REPLACE FUNCTION public.has_ai_receptionist_access(_business_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.businesses b
    WHERE b.id = _business_id AND b.active
      AND ( b.billing_exempt = true OR EXISTS (
          SELECT 1 FROM public.business_billing bb
          WHERE bb.business_id = b.id AND bb.selected_plan = 'ai_receptionist'
            AND public.effective_billing_state(b.id) IN ('active','past_due_grace','billing_exempt_test')
      ))
  )
$$;

CREATE OR REPLACE FUNCTION public.has_missed_call_access(_business_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.businesses b
    WHERE b.id = _business_id AND b.active
      AND ( b.billing_exempt = true OR EXISTS (
          SELECT 1 FROM public.business_billing bb
          WHERE bb.business_id = b.id
            AND bb.selected_plan IN ('missed_call_recovery','ai_receptionist')
            AND public.effective_billing_state(b.id) IN ('active','past_due_grace','billing_exempt_test')
      ))
  )
$$;

CREATE OR REPLACE FUNCTION public.get_my_billing_summary()
RETURNS TABLE (
  business_id uuid, selected_plan text, billing_status text, effective_state text,
  billing_exempt boolean, union_offer_eligible boolean, union_offer_redeemed_at timestamptz,
  platform_fee_waiver_ends_at timestamptz, current_period_start timestamptz,
  current_period_end timestamptz, grace_expires_at timestamptz, usage_limit_cents integer,
  has_stripe_customer boolean, has_stripe_subscription boolean
) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT bb.business_id, bb.selected_plan, bb.billing_status,
    public.effective_billing_state(bb.business_id), b.billing_exempt,
    bb.union_offer_eligible, bb.union_offer_redeemed_at, bb.platform_fee_waiver_ends_at,
    bb.current_period_start, bb.current_period_end, bb.grace_expires_at, bb.usage_limit_cents,
    (bb.stripe_customer_id IS NOT NULL), (bb.stripe_subscription_id IS NOT NULL)
  FROM public.business_billing bb
  JOIN public.businesses b ON b.id = bb.business_id
  WHERE bb.business_id = public.current_business_id()
$$;

GRANT EXECUTE ON FUNCTION public.effective_billing_state(uuid) TO authenticated, anon;
GRANT EXECUTE ON FUNCTION public.get_my_billing_summary() TO authenticated;
