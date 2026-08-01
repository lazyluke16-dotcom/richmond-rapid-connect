-- Acquisition funnel: first-party attribution, setup-fee promotion validation,
-- immutable redemption evidence and privacy-minimal conversion events.
--
-- Public clients never receive table access. The application validates promo
-- codes through its server boundary and writes analytics with the service role.

CREATE TABLE public.acquisition_promo_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE CHECK (code = upper(code) AND code ~ '^[A-Z0-9_-]{3,64}$'),
  description text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  starts_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  max_redemptions integer CHECK (max_redemptions IS NULL OR max_redemptions > 0),
  redemption_count integer NOT NULL DEFAULT 0 CHECK (redemption_count >= 0),
  applicable_plans text[] NOT NULL DEFAULT
    ARRAY['missed_call_recovery','ai_receptionist']::text[],
  text_setup_fee_cents integer NOT NULL DEFAULT 49900
    CHECK (text_setup_fee_cents >= 0),
  combined_setup_fee_cents integer NOT NULL DEFAULT 119900
    CHECK (combined_setup_fee_cents >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at IS NULL OR expires_at > starts_at),
  CHECK (
    cardinality(applicable_plans) > 0
    AND applicable_plans <@ ARRAY['missed_call_recovery','ai_receptionist']::text[]
  )
);

CREATE TRIGGER acquisition_promo_codes_set_updated_at
BEFORE UPDATE ON public.acquisition_promo_codes
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.acquisition_promo_codes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.acquisition_promo_codes FROM anon, authenticated;
GRANT ALL ON public.acquisition_promo_codes TO service_role;
CREATE POLICY "service_role_manages_acquisition_promo_codes"
  ON public.acquisition_promo_codes
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE TABLE public.acquisition_events (
  event_id uuid PRIMARY KEY,
  session_id uuid NOT NULL,
  event_name text NOT NULL CHECK (event_name IN (
    'landing_viewed','demo_started','demo_25','demo_50','demo_75',
    'demo_completed','demo_closed','signup_opened','package_selected',
    'promo_validated','wizard_step_viewed','signup_submitted',
    'account_created','email_confirmation_required','checkout_opened',
    'checkout_failed'
  )),
  path text NOT NULL DEFAULT '/plumbers' CHECK (length(path) <= 240),
  plan text CHECK (plan IS NULL OR plan IN ('missed_call_recovery','ai_receptionist')),
  promo_code text CHECK (promo_code IS NULL OR length(promo_code) <= 64),
  wizard_step smallint CHECK (wizard_step IS NULL OR wizard_step BETWEEN 0 AND 6),
  source text CHECK (source IS NULL OR length(source) <= 120),
  medium text CHECK (medium IS NULL OR length(medium) <= 120),
  campaign text CHECK (campaign IS NULL OR length(campaign) <= 120),
  content text CHECK (content IS NULL OR length(content) <= 120),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX acquisition_events_session_created_idx
  ON public.acquisition_events (session_id, created_at);
CREATE INDEX acquisition_events_campaign_created_idx
  ON public.acquisition_events (campaign, created_at)
  WHERE campaign IS NOT NULL;

ALTER TABLE public.acquisition_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.acquisition_events FROM anon, authenticated;
GRANT ALL ON public.acquisition_events TO service_role;
CREATE POLICY "service_role_manages_acquisition_events"
  ON public.acquisition_events
  FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public.businesses
  ADD COLUMN IF NOT EXISTS acquisition_session_id uuid,
  ADD COLUMN IF NOT EXISTS acquisition_source text,
  ADD COLUMN IF NOT EXISTS acquisition_medium text,
  ADD COLUMN IF NOT EXISTS acquisition_campaign text,
  ADD COLUMN IF NOT EXISTS acquisition_content text,
  ADD COLUMN IF NOT EXISTS promotion_code text,
  ADD COLUMN IF NOT EXISTS setup_fee_waived_cents integer
    CHECK (setup_fee_waived_cents IS NULL OR setup_fee_waived_cents >= 0),
  ADD COLUMN IF NOT EXISTS setup_fee_waived_at timestamptz;

CREATE TABLE public.acquisition_promo_redemptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  promo_code_id uuid NOT NULL REFERENCES public.acquisition_promo_codes(id) ON DELETE RESTRICT,
  business_id uuid NOT NULL UNIQUE REFERENCES public.businesses(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL,
  session_id uuid,
  plan text NOT NULL CHECK (plan IN ('missed_call_recovery','ai_receptionist')),
  waived_setup_fee_cents integer NOT NULL CHECK (waived_setup_fee_cents >= 0),
  source text,
  medium text,
  campaign text,
  content text,
  redeemed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (promo_code_id, business_id)
);

CREATE INDEX acquisition_promo_redemptions_promo_idx
  ON public.acquisition_promo_redemptions (promo_code_id, redeemed_at);

ALTER TABLE public.acquisition_promo_redemptions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.acquisition_promo_redemptions FROM anon, authenticated;
GRANT ALL ON public.acquisition_promo_redemptions TO service_role;
CREATE POLICY "service_role_manages_acquisition_promo_redemptions"
  ON public.acquisition_promo_redemptions
  FOR ALL TO service_role USING (true) WITH CHECK (true);

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
BEGIN
  IF uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;
  IF _plan NOT IN ('missed_call_recovery','ai_receptionist') THEN
    RAISE EXCEPTION 'Invalid acquisition plan';
  END IF;
  IF _code IS NULL OR upper(btrim(_code)) !~ '^[A-Z0-9_-]{3,64}$' THEN
    RAISE EXCEPTION 'Invalid promotion code';
  END IF;

  SELECT bu.business_id INTO bid
    FROM public.business_users bu
   WHERE bu.user_id = uid
   ORDER BY bu.created_at ASC
   LIMIT 1;
  IF bid IS NULL THEN
    RAISE EXCEPTION 'Create your business before redeeming the offer';
  END IF;

  SELECT * INTO existing
    FROM public.acquisition_promo_redemptions
   WHERE business_id = bid;
  IF FOUND THEN
    SELECT * INTO promo
      FROM public.acquisition_promo_codes
     WHERE id = existing.promo_code_id;
    IF promo.code <> upper(btrim(_code)) OR existing.plan <> _plan THEN
      RAISE EXCEPTION 'A different setup offer is already attached to this business';
    END IF;
    RETURN jsonb_build_object(
      'success', true,
      'promotionCode', promo.code,
      'plan', existing.plan,
      'setupFeeWaivedCents', existing.waived_setup_fee_cents
    );
  END IF;

  SELECT * INTO promo
    FROM public.acquisition_promo_codes
   WHERE code = upper(btrim(_code))
   FOR UPDATE;
  IF NOT FOUND
     OR NOT promo.active
     OR promo.starts_at > now()
     OR (promo.expires_at IS NOT NULL AND promo.expires_at <= now())
     OR NOT (_plan = ANY(promo.applicable_plans))
     OR (promo.max_redemptions IS NOT NULL AND promo.redemption_count >= promo.max_redemptions)
  THEN
    RAISE EXCEPTION 'Promotion code is not available';
  END IF;

  waived := CASE
    WHEN _plan = 'ai_receptionist' THEN promo.combined_setup_fee_cents
    ELSE promo.text_setup_fee_cents
  END;

  INSERT INTO public.acquisition_promo_redemptions (
    promo_code_id, business_id, user_id, session_id, plan,
    waived_setup_fee_cents, source, medium, campaign, content
  ) VALUES (
    promo.id, bid, uid, _session_id, _plan, waived,
    left(nullif(btrim(_source), ''), 120),
    left(nullif(btrim(_medium), ''), 120),
    left(nullif(btrim(_campaign), ''), 120),
    left(nullif(btrim(_content), ''), 120)
  );

  UPDATE public.acquisition_promo_codes
     SET redemption_count = redemption_count + 1
   WHERE id = promo.id;

  UPDATE public.businesses
     SET selected_plan = _plan,
         signup_source = COALESCE(left(nullif(btrim(_source), ''), 120), signup_source),
         acquisition_session_id = _session_id,
         acquisition_source = left(nullif(btrim(_source), ''), 120),
         acquisition_medium = left(nullif(btrim(_medium), ''), 120),
         acquisition_campaign = left(nullif(btrim(_campaign), ''), 120),
         acquisition_content = left(nullif(btrim(_content), ''), 120),
         promotion_code = promo.code,
         setup_fee_waived_cents = waived,
         setup_fee_waived_at = now()
   WHERE id = bid;

  INSERT INTO public.business_billing (business_id, selected_plan)
  VALUES (bid, _plan)
  ON CONFLICT (business_id) DO UPDATE
    SET selected_plan = EXCLUDED.selected_plan,
        updated_at = now();

  RETURN jsonb_build_object(
    'success', true,
    'promotionCode', promo.code,
    'plan', _plan,
    'setupFeeWaivedCents', waived
  );
END;
$$;

REVOKE ALL ON FUNCTION public.redeem_acquisition_offer(
  text, text, uuid, text, text, text, text
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.redeem_acquisition_offer(
  text, text, uuid, text, text, text, text
) TO authenticated;

INSERT INTO public.acquisition_promo_codes (
  code, description, active, starts_at, expires_at, max_redemptions,
  applicable_plans, text_setup_fee_cents, combined_setup_fee_cents
) VALUES (
  'FOUNDINGPLUMBER',
  'Founding plumber acquisition offer — setup fee waived',
  true,
  '2026-07-28T00:00:00Z',
  '2026-12-31T13:00:00Z',
  100,
  ARRAY['missed_call_recovery','ai_receptionist']::text[],
  49900,
  119900
)
ON CONFLICT (code) DO NOTHING;
