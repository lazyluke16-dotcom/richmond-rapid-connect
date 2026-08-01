-- Seamless acquisition-to-first-test-job release.
--
-- Eligibility boundary: redemptions created before this migration retain the
-- setup-fee-only offer. A new FOUNDINGPLUMBER redemption after this migration
-- receives offer version founding-2026-three-months exactly once per business.

ALTER TABLE public.businesses DROP CONSTRAINT IF EXISTS businesses_selected_plan_check;
ALTER TABLE public.businesses
  ADD CONSTRAINT businesses_selected_plan_check
  CHECK (selected_plan IS NULL OR selected_plan IN ('missed_call_recovery','ai_receptionist','both'));

ALTER TABLE public.business_billing DROP CONSTRAINT IF EXISTS business_billing_selected_plan_check;
ALTER TABLE public.business_billing
  ADD CONSTRAINT business_billing_selected_plan_check
  CHECK (selected_plan IS NULL OR selected_plan IN ('missed_call_recovery','ai_receptionist','both'));

DO $$
DECLARE constraint_name text;
BEGIN
  FOR constraint_name IN
    SELECT c.conname
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
     WHERE t.relname = 'acquisition_promo_codes'
       AND c.contype = 'c'
       AND pg_get_constraintdef(c.oid) ILIKE '%applicable_plans%'
  LOOP
    EXECUTE format('ALTER TABLE public.acquisition_promo_codes DROP CONSTRAINT %I', constraint_name);
  END LOOP;
END $$;

ALTER TABLE public.acquisition_promo_codes
  ADD CONSTRAINT acquisition_promo_codes_applicable_plans_check
  CHECK (
    cardinality(applicable_plans) > 0
    AND applicable_plans <@ ARRAY['missed_call_recovery','ai_receptionist','both']::text[]
  ),
  ADD COLUMN IF NOT EXISTS subscription_months_free smallint NOT NULL DEFAULT 0
    CHECK (subscription_months_free BETWEEN 0 AND 12),
  ADD COLUMN IF NOT EXISTS offer_version text NOT NULL DEFAULT 'setup-waiver-v1';

ALTER TABLE public.acquisition_promo_redemptions
  DROP CONSTRAINT IF EXISTS acquisition_promo_redemptions_plan_check;
ALTER TABLE public.acquisition_promo_redemptions
  ADD CONSTRAINT acquisition_promo_redemptions_plan_check
    CHECK (plan IN ('missed_call_recovery','ai_receptionist','both')),
  ADD COLUMN IF NOT EXISTS offer_version text NOT NULL DEFAULT 'setup-waiver-v1',
  ADD COLUMN IF NOT EXISTS subscription_promo_eligible boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS subscription_promo_redeemed_at timestamptz,
  ADD COLUMN IF NOT EXISTS subscription_promo_ends_at timestamptz;

ALTER TABLE public.business_billing
  ADD COLUMN IF NOT EXISTS founding_offer_version text,
  ADD COLUMN IF NOT EXISTS founding_offer_eligible boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS founding_offer_redeemed_at timestamptz,
  ADD COLUMN IF NOT EXISTS founding_offer_ends_at timestamptz,
  ADD COLUMN IF NOT EXISTS normal_billing_starts_at timestamptz;

UPDATE public.acquisition_promo_codes
   SET description = 'No sign-on fee and first three subscription months free; usage charged from activation',
       applicable_plans = ARRAY['missed_call_recovery','ai_receptionist','both']::text[],
       text_setup_fee_cents = 49900,
       combined_setup_fee_cents = 49900,
       subscription_months_free = 3,
       offer_version = 'founding-2026-three-months',
       updated_at = now()
 WHERE code = 'FOUNDINGPLUMBER';

DO $$
DECLARE constraint_name text;
BEGIN
  FOR constraint_name IN
    SELECT c.conname
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
     WHERE t.relname = 'acquisition_events'
       AND c.contype = 'c'
       AND pg_get_constraintdef(c.oid) ILIKE '%event_name%'
  LOOP
    EXECUTE format('ALTER TABLE public.acquisition_events DROP CONSTRAINT %I', constraint_name);
  END LOOP;
END $$;

ALTER TABLE public.acquisition_events
  DROP CONSTRAINT IF EXISTS acquisition_events_plan_check;
ALTER TABLE public.acquisition_events
  ADD COLUMN IF NOT EXISTS business_id uuid REFERENCES public.businesses(id) ON DELETE SET NULL,
  ADD CONSTRAINT acquisition_events_plan_check
    CHECK (plan IS NULL OR plan IN ('missed_call_recovery','ai_receptionist','both')),
  ADD CONSTRAINT acquisition_events_event_name_check
    CHECK (event_name IN (
      'landing_viewed','service_comparison_viewed','roi_calculator_used',
      'demo_started','demo_25','demo_50','demo_75','demo_completed','demo_closed',
      'signup_opened','package_selected','service_selected','promo_validated',
      'wizard_started','wizard_step_viewed','wizard_stage_completed','signup_submitted',
      'account_created','email_confirmation_required','checkout_started','checkout_opened',
      'checkout_completed','checkout_failed','activation_completed','test_job_initiated',
      'test_job_received','first_genuine_job_received'
    ));

CREATE UNIQUE INDEX IF NOT EXISTS acquisition_first_business_event_unique
  ON public.acquisition_events (business_id, event_name)
  WHERE business_id IS NOT NULL
    AND event_name IN ('checkout_completed','activation_completed','test_job_received','first_genuine_job_received');

ALTER TABLE public.business_telephony_settings
  ADD COLUMN IF NOT EXISTS missed_call_recovery_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS ai_receptionist_enabled boolean NOT NULL DEFAULT false;

UPDATE public.business_telephony_settings
   SET missed_call_recovery_enabled = (answering_mode = 'text_link'),
       ai_receptionist_enabled = (answering_mode = 'ai_receptionist');

ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS is_test boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS test_run_id uuid;

CREATE UNIQUE INDEX IF NOT EXISTS leads_business_test_run_unique
  ON public.leads (business_id, test_run_id)
  WHERE test_run_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.has_ai_receptionist_access(_business_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.businesses b
    WHERE b.id = _business_id AND b.active
      AND (b.billing_exempt = true OR EXISTS (
        SELECT 1 FROM public.business_billing bb
         WHERE bb.business_id = b.id
           AND bb.selected_plan IN ('ai_receptionist','both')
           AND public.effective_billing_state(b.id) IN ('active','past_due_grace','billing_exempt_test')
      ))
  )
$$;

CREATE OR REPLACE FUNCTION public.has_missed_call_access(_business_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.businesses b
    WHERE b.id = _business_id AND b.active
      AND (b.billing_exempt = true OR EXISTS (
        SELECT 1 FROM public.business_billing bb
         WHERE bb.business_id = b.id
           AND bb.selected_plan IN ('missed_call_recovery','both')
           AND public.effective_billing_state(b.id) IN ('active','past_due_grace','billing_exempt_test')
      ))
  )
$$;

CREATE OR REPLACE FUNCTION public.set_my_service_enabled(_service text, _enabled boolean)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  bid uuid;
  tel public.business_telephony_settings%ROWTYPE;
  ai_ready boolean;
BEGIN
  bid := public.call_handling_admin_business();
  IF bid IS NULL THEN
    RAISE EXCEPTION 'Owner or admin access is required' USING ERRCODE = '42501';
  END IF;
  IF _service NOT IN ('missed_call_recovery','ai_receptionist') THEN
    RAISE EXCEPTION 'Unknown service' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO tel FROM public.business_telephony_settings WHERE business_id = bid FOR UPDATE;
  IF _enabled AND (tel.inventory_phone_id IS NULL OR tel.inbound_number IS NULL) THEN
    RAISE EXCEPTION 'Allocate a forwarding number before switching this service on'
      USING ERRCODE = '23514';
  END IF;
  IF _enabled AND tel.forwarding_setup_status <> 'verified' THEN
    RAISE EXCEPTION 'Verify call forwarding before switching this service on'
      USING ERRCODE = '23514';
  END IF;
  IF _service = 'missed_call_recovery' AND _enabled AND NOT public.has_missed_call_access(bid) THEN
    RAISE EXCEPTION 'Your subscription does not include Missed-Call Recovery'
      USING ERRCODE = '42501';
  END IF;
  IF _service = 'ai_receptionist' AND _enabled AND NOT public.has_ai_receptionist_access(bid) THEN
    RAISE EXCEPTION 'Your subscription does not include AI Receptionist'
      USING ERRCODE = '42501';
  END IF;
  IF _service = 'ai_receptionist' AND _enabled THEN
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
      RAISE EXCEPTION 'Finish AI Receptionist setup before switching it on'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  UPDATE public.business_telephony_settings
     SET missed_call_recovery_enabled = CASE
           WHEN _service = 'missed_call_recovery' THEN _enabled
           ELSE missed_call_recovery_enabled
         END,
         ai_receptionist_enabled = CASE
           WHEN _service = 'ai_receptionist' THEN _enabled
           ELSE ai_receptionist_enabled
         END
   WHERE business_id = bid;

  UPDATE public.business_missed_call_settings
     SET enabled = CASE WHEN _service = 'missed_call_recovery' THEN _enabled ELSE enabled END,
         mode = CASE WHEN _service = 'missed_call_recovery' AND _enabled THEN 'live' ELSE mode END,
         recovery_sms_enabled = CASE
           WHEN _service = 'missed_call_recovery' AND _enabled THEN true
           ELSE recovery_sms_enabled
         END
   WHERE business_id = bid;
  UPDATE public.business_ai_receptionist_settings
     SET enabled = CASE WHEN _service = 'ai_receptionist' THEN _enabled ELSE enabled END,
         mode = CASE WHEN _service = 'ai_receptionist' AND _enabled THEN 'live' ELSE mode END
   WHERE business_id = bid;

  UPDATE public.business_telephony_settings
     SET answering_mode = CASE
       WHEN ai_receptionist_enabled THEN 'ai_receptionist'
       WHEN missed_call_recovery_enabled THEN 'text_link'
       ELSE 'off'
     END
   WHERE business_id = bid;
END $$;
REVOKE ALL ON FUNCTION public.set_my_service_enabled(text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_my_service_enabled(text, boolean) TO authenticated;

CREATE OR REPLACE FUNCTION public.create_my_test_job(_service text, _request_id uuid)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  bid uuid := public.current_business_id();
  sid uuid;
  lead_id text;
  enabled boolean;
  source_value text;
BEGIN
  IF bid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;
  IF _request_id IS NULL OR _service NOT IN ('missed_call_recovery','ai_receptionist') THEN
    RAISE EXCEPTION 'Invalid test request' USING ERRCODE = '22023';
  END IF;
  IF public.effective_billing_state(bid) NOT IN ('active','past_due_grace','billing_exempt_test') THEN
    RAISE EXCEPTION 'Activate your subscription before sending a test job'
      USING ERRCODE = '42501';
  END IF;

  SELECT CASE
      WHEN _service = 'missed_call_recovery' THEN missed_call_recovery_enabled
      ELSE ai_receptionist_enabled
    END
    INTO enabled
    FROM public.business_telephony_settings
   WHERE business_id = bid;
  IF NOT COALESCE(enabled, false) THEN
    RAISE EXCEPTION 'Switch this service on before sending its test job'
      USING ERRCODE = '23514';
  END IF;
  IF _service = 'missed_call_recovery' AND NOT public.has_missed_call_access(bid) THEN
    RAISE EXCEPTION 'Your subscription does not include Missed-Call Recovery'
      USING ERRCODE = '42501';
  END IF;
  IF _service = 'ai_receptionist' AND NOT public.has_ai_receptionist_access(bid) THEN
    RAISE EXCEPTION 'Your subscription does not include AI Receptionist'
      USING ERRCODE = '42501';
  END IF;

  SELECT id INTO lead_id FROM public.leads
   WHERE business_id = bid AND test_run_id = _request_id;
  IF lead_id IS NOT NULL THEN RETURN lead_id; END IF;

  source_value := CASE WHEN _service = 'missed_call_recovery' THEN 'missed_call' ELSE 'ai_phone_agent' END;
  lead_id := 'test-' || _request_id::text;
  INSERT INTO public.leads (
    id, created_at, job_type, suburb, urgency, property_type, photos,
    name, phone, best_time, chat, ai_summary, lead_score,
    recommended_action, status, source, business_id, is_test, test_run_id
  ) VALUES (
    lead_id, (extract(epoch from clock_timestamp()) * 1000)::bigint,
    'blocked-drain', 'Richmond', 'today', 'house', '[]'::jsonb,
    'Test customer — no contact', 'TEST-NO-CALL', 'This afternoon',
    jsonb_build_array(
      jsonb_build_object('role','ai','text','What plumbing problem can we help with?','ts',(extract(epoch from clock_timestamp()) * 1000)::bigint),
      jsonb_build_object('role','customer','text','The kitchen sink is blocked and draining slowly.','ts',(extract(epoch from clock_timestamp()) * 1000)::bigint)
    ),
    'TEST JOB — Blocked kitchen sink in Richmond. Customer selected today and supplied safe simulated details.',
    70, 'Review this test job card. No customer needs to be contacted.',
    'new', source_value, bid, true, _request_id
  );

  INSERT INTO public.sms_events (
    to_number, from_number, body, mode, status, event_type, business_id
  ) VALUES (
    'test:no-send', 'TEST', 'TEST notification: your first captured job is ready.',
    'demo', 'simulated', 'test_plumber_alert', bid
  );

  SELECT COALESCE(acquisition_session_id, gen_random_uuid()) INTO sid
    FROM public.businesses WHERE id = bid;
  INSERT INTO public.acquisition_events (
    event_id, session_id, business_id, event_name, path, plan
  )
  SELECT gen_random_uuid(), sid, bid, event_name, '/leads',
         (SELECT selected_plan FROM public.business_billing WHERE business_id = bid)
    FROM unnest(ARRAY['test_job_initiated','test_job_received']::text[]) AS events(event_name)
  ON CONFLICT DO NOTHING;

  RETURN lead_id;
END $$;
REVOKE ALL ON FUNCTION public.create_my_test_job(text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_my_test_job(text, uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.record_first_genuine_job_event()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE sid uuid; selected text;
BEGIN
  IF NEW.is_test THEN RETURN NEW; END IF;
  SELECT b.acquisition_session_id, bb.selected_plan INTO sid, selected
    FROM public.businesses b
    LEFT JOIN public.business_billing bb ON bb.business_id = b.id
   WHERE b.id = NEW.business_id;
  IF sid IS NOT NULL THEN
    INSERT INTO public.acquisition_events (
      event_id, session_id, business_id, event_name, path, plan
    ) VALUES (
      gen_random_uuid(), sid, NEW.business_id, 'first_genuine_job_received', '/leads', selected
    ) ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS leads_record_first_genuine_job ON public.leads;
CREATE TRIGGER leads_record_first_genuine_job
AFTER INSERT ON public.leads
FOR EACH ROW EXECUTE FUNCTION public.record_first_genuine_job_event();

CREATE OR REPLACE FUNCTION public.redeem_acquisition_offer(
  _code text,
  _plan text,
  _session_id uuid DEFAULT NULL,
  _source text DEFAULT NULL,
  _medium text DEFAULT NULL,
  _campaign text DEFAULT NULL,
  _content text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  uid uuid := auth.uid();
  bid uuid;
  promo public.acquisition_promo_codes%ROWTYPE;
  existing public.acquisition_promo_redemptions%ROWTYPE;
  waived integer;
  subscription_eligible boolean;
BEGIN
  IF uid IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501'; END IF;
  IF _plan NOT IN ('missed_call_recovery','ai_receptionist','both') THEN
    RAISE EXCEPTION 'Invalid acquisition plan';
  END IF;
  IF _code IS NULL OR upper(btrim(_code)) !~ '^[A-Z0-9_-]{3,64}$' THEN
    RAISE EXCEPTION 'Invalid promotion code';
  END IF;

  SELECT bu.business_id INTO bid FROM public.business_users bu
   WHERE bu.user_id = uid ORDER BY bu.created_at ASC LIMIT 1;
  IF bid IS NULL THEN RAISE EXCEPTION 'Create your business before redeeming the offer'; END IF;

  SELECT * INTO existing FROM public.acquisition_promo_redemptions WHERE business_id = bid;
  IF FOUND THEN
    SELECT * INTO promo FROM public.acquisition_promo_codes WHERE id = existing.promo_code_id;
    IF promo.code <> upper(btrim(_code)) OR existing.plan <> _plan THEN
      RAISE EXCEPTION 'A different setup offer is already attached to this business';
    END IF;
    RETURN jsonb_build_object(
      'success', true, 'promotionCode', promo.code, 'plan', existing.plan,
      'setupFeeWaivedCents', existing.waived_setup_fee_cents,
      'offerVersion', existing.offer_version,
      'subscriptionMonthsFree', CASE WHEN existing.subscription_promo_eligible THEN 3 ELSE 0 END
    );
  END IF;

  SELECT * INTO promo FROM public.acquisition_promo_codes
   WHERE code = upper(btrim(_code)) FOR UPDATE;
  IF NOT FOUND OR NOT promo.active OR promo.starts_at > now()
     OR (promo.expires_at IS NOT NULL AND promo.expires_at <= now())
     OR NOT (_plan = ANY(promo.applicable_plans))
     OR (promo.max_redemptions IS NOT NULL AND promo.redemption_count >= promo.max_redemptions)
  THEN RAISE EXCEPTION 'Promotion code is not available'; END IF;

  waived := 49900;
  subscription_eligible := promo.offer_version = 'founding-2026-three-months'
    AND NOT EXISTS (
      SELECT 1 FROM public.business_billing bb
       WHERE bb.business_id = bid AND bb.stripe_subscription_id IS NOT NULL
    );

  INSERT INTO public.acquisition_promo_redemptions (
    promo_code_id, business_id, user_id, session_id, plan,
    waived_setup_fee_cents, source, medium, campaign, content,
    offer_version, subscription_promo_eligible
  ) VALUES (
    promo.id, bid, uid, _session_id, _plan, waived,
    left(nullif(btrim(_source), ''), 120), left(nullif(btrim(_medium), ''), 120),
    left(nullif(btrim(_campaign), ''), 120), left(nullif(btrim(_content), ''), 120),
    promo.offer_version, subscription_eligible
  );
  UPDATE public.acquisition_promo_codes SET redemption_count = redemption_count + 1 WHERE id = promo.id;
  UPDATE public.businesses
     SET selected_plan = _plan, signup_source = COALESCE(left(nullif(btrim(_source), ''), 120), signup_source),
         acquisition_session_id = _session_id, acquisition_source = left(nullif(btrim(_source), ''), 120),
         acquisition_medium = left(nullif(btrim(_medium), ''), 120), acquisition_campaign = left(nullif(btrim(_campaign), ''), 120),
         acquisition_content = left(nullif(btrim(_content), ''), 120), promotion_code = promo.code,
         setup_fee_waived_cents = waived, setup_fee_waived_at = now()
   WHERE id = bid;
  INSERT INTO public.business_billing (
    business_id, selected_plan, founding_offer_version, founding_offer_eligible
  ) VALUES (
    bid, _plan, promo.offer_version, subscription_eligible
  ) ON CONFLICT (business_id) DO UPDATE
    SET selected_plan = EXCLUDED.selected_plan,
        founding_offer_version = CASE
          WHEN business_billing.stripe_subscription_id IS NULL THEN EXCLUDED.founding_offer_version
          ELSE business_billing.founding_offer_version END,
        founding_offer_eligible = CASE
          WHEN business_billing.stripe_subscription_id IS NULL THEN EXCLUDED.founding_offer_eligible
          ELSE business_billing.founding_offer_eligible END,
        updated_at = now();

  RETURN jsonb_build_object(
    'success', true, 'promotionCode', promo.code, 'plan', _plan,
    'setupFeeWaivedCents', waived, 'offerVersion', promo.offer_version,
    'subscriptionMonthsFree', CASE WHEN subscription_eligible THEN 3 ELSE 0 END
  );
END;
$$;

REVOKE ALL ON FUNCTION public.redeem_acquisition_offer(
  text, text, uuid, text, text, text, text
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.redeem_acquisition_offer(
  text, text, uuid, text, text, text, text
) TO authenticated;

CREATE OR REPLACE FUNCTION public.recover_my_acquisition_business()
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  uid uuid := auth.uid();
  metadata jsonb := COALESCE(auth.jwt() -> 'user_metadata', '{}'::jsonb);
  bid uuid;
  business_name text;
  acquisition_plan text;
  promotion_code text;
  signup_source text;
  referral_code text;
BEGIN
  IF uid IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(uid::text, 0));
  SELECT bu.business_id INTO bid FROM public.business_users bu
   WHERE bu.user_id = uid ORDER BY bu.created_at ASC LIMIT 1;
  IF bid IS NOT NULL THEN RETURN bid; END IF;

  business_name := left(nullif(btrim(metadata ->> 'business_name'), ''), 160);
  acquisition_plan := metadata ->> 'acquisition_plan';
  promotion_code := upper(btrim(metadata ->> 'acquisition_promo_code'));
  signup_source := left(nullif(btrim(metadata ->> 'acquisition_source'), ''), 120);
  referral_code := left(nullif(btrim(metadata ->> 'referral_code'), ''), 120);
  IF business_name IS NULL
     OR acquisition_plan NOT IN ('missed_call_recovery','ai_receptionist','both')
     OR promotion_code !~ '^[A-Z0-9_-]{3,64}$'
  THEN RAISE EXCEPTION 'No recoverable acquisition signup found'; END IF;

  SELECT created.id INTO bid
    FROM public.create_business_for_current_user(
      business_name, business_name, COALESCE(signup_source, 'acquisition_funnel'), NULL, referral_code
    ) AS created LIMIT 1;
  PERFORM public.redeem_acquisition_offer(
    promotion_code, acquisition_plan, NULL, signup_source,
    left(nullif(btrim(metadata ->> 'acquisition_medium'), ''), 120),
    left(nullif(btrim(metadata ->> 'acquisition_campaign'), ''), 120),
    left(nullif(btrim(metadata ->> 'acquisition_content'), ''), 120)
  );
  UPDATE public.businesses
     SET public_email = COALESCE(public_email, auth.jwt() ->> 'email'),
         public_phone = COALESCE(
           public_phone, left(nullif(btrim(metadata ->> 'business_phone_e164'), ''), 40)
         )
   WHERE id = bid;
  RETURN bid;
END;
$$;
REVOKE ALL ON FUNCTION public.recover_my_acquisition_business() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.recover_my_acquisition_business() TO authenticated;
