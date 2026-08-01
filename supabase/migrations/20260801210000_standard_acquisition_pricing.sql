-- Make offer and standard acquisition pricing explicit and server-owned.
-- A browser can request a mode, but only these authenticated tenant-scoped
-- functions may commit it before Stripe Checkout independently resolves it.

ALTER TABLE public.businesses
  ADD COLUMN IF NOT EXISTS acquisition_pricing_mode text
  CHECK (acquisition_pricing_mode IS NULL OR acquisition_pricing_mode IN ('offer','standard'));

UPDATE public.businesses b
   SET acquisition_pricing_mode = 'offer'
 WHERE EXISTS (
   SELECT 1
     FROM public.acquisition_promo_redemptions r
    WHERE r.business_id = b.id
 );

CREATE OR REPLACE FUNCTION public.mark_acquisition_offer_pricing()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.businesses
     SET acquisition_pricing_mode = 'offer'
   WHERE id = NEW.business_id;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.mark_acquisition_offer_pricing() FROM PUBLIC;

DROP TRIGGER IF EXISTS acquisition_redemption_marks_offer_pricing
  ON public.acquisition_promo_redemptions;
CREATE TRIGGER acquisition_redemption_marks_offer_pricing
AFTER INSERT ON public.acquisition_promo_redemptions
FOR EACH ROW EXECUTE FUNCTION public.mark_acquisition_offer_pricing();

CREATE OR REPLACE FUNCTION public.select_standard_acquisition_pricing(
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
  existing_subscription text;
BEGIN
  IF uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;
  IF _plan NOT IN ('missed_call_recovery','ai_receptionist','both') THEN
    RAISE EXCEPTION 'Invalid acquisition plan';
  END IF;

  SELECT bu.business_id INTO bid
    FROM public.business_users bu
   WHERE bu.user_id = uid
   ORDER BY bu.created_at ASC
   LIMIT 1;
  IF bid IS NULL THEN
    RAISE EXCEPTION 'Create your business before selecting pricing';
  END IF;

  SELECT stripe_subscription_id INTO existing_subscription
    FROM public.business_billing
   WHERE business_id = bid;
  IF existing_subscription IS NOT NULL THEN
    RAISE EXCEPTION 'An active subscription already belongs to this business';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.acquisition_promo_redemptions WHERE business_id = bid
  ) THEN
    RAISE EXCEPTION 'A redeemed offer is already attached to this business';
  END IF;

  UPDATE public.businesses
     SET selected_plan = _plan,
         signup_source = COALESCE(left(nullif(btrim(_source), ''), 120), signup_source),
         acquisition_session_id = _session_id,
         acquisition_source = left(nullif(btrim(_source), ''), 120),
         acquisition_medium = left(nullif(btrim(_medium), ''), 120),
         acquisition_campaign = left(nullif(btrim(_campaign), ''), 120),
         acquisition_content = left(nullif(btrim(_content), ''), 120),
         acquisition_pricing_mode = 'standard',
         promotion_code = NULL,
         setup_fee_waived_cents = NULL,
         setup_fee_waived_at = NULL
   WHERE id = bid;

  INSERT INTO public.business_billing (
    business_id, selected_plan, founding_offer_version, founding_offer_eligible
  ) VALUES (
    bid, _plan, NULL, false
  )
  ON CONFLICT (business_id) DO UPDATE
    SET selected_plan = EXCLUDED.selected_plan,
        founding_offer_version = NULL,
        founding_offer_eligible = false,
        founding_offer_redeemed_at = NULL,
        founding_offer_ends_at = NULL,
        normal_billing_starts_at = NULL,
        updated_at = now()
  WHERE business_billing.stripe_subscription_id IS NULL;

  RETURN jsonb_build_object(
    'success', true,
    'pricingMode', 'standard',
    'plan', _plan,
    'setupFeeCents', 49900,
    'subscriptionMonthsFree', 0
  );
END;
$$;

REVOKE ALL ON FUNCTION public.select_standard_acquisition_pricing(
  text, uuid, text, text, text, text
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.select_standard_acquisition_pricing(
  text, uuid, text, text, text, text
) TO authenticated;

-- Email confirmation can end the browser session. Recover the resulting
-- authenticated identity into the correct pricing path using signed auth
-- metadata, never a browser-supplied business id or fee amount.
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
  pricing_mode text;
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
  pricing_mode := lower(btrim(metadata ->> 'acquisition_pricing_mode'));
  IF pricing_mode NOT IN ('offer','standard') THEN
    pricing_mode := CASE WHEN promotion_code ~ '^[A-Z0-9_-]{3,64}$' THEN 'offer' ELSE 'standard' END;
  END IF;
  signup_source := left(nullif(btrim(metadata ->> 'acquisition_source'), ''), 120);
  referral_code := left(nullif(btrim(metadata ->> 'referral_code'), ''), 120);
  IF business_name IS NULL
     OR acquisition_plan NOT IN ('missed_call_recovery','ai_receptionist','both')
     OR (pricing_mode = 'offer' AND promotion_code !~ '^[A-Z0-9_-]{3,64}$')
  THEN RAISE EXCEPTION 'No recoverable acquisition signup found'; END IF;

  SELECT created.id INTO bid
    FROM public.create_business_for_current_user(
      business_name, business_name, COALESCE(signup_source, 'acquisition_funnel'), NULL, referral_code
    ) AS created LIMIT 1;
  IF pricing_mode = 'offer' THEN
    PERFORM public.redeem_acquisition_offer(
      promotion_code, acquisition_plan, NULL, signup_source,
      left(nullif(btrim(metadata ->> 'acquisition_medium'), ''), 120),
      left(nullif(btrim(metadata ->> 'acquisition_campaign'), ''), 120),
      left(nullif(btrim(metadata ->> 'acquisition_content'), ''), 120)
    );
  ELSE
    PERFORM public.select_standard_acquisition_pricing(
      acquisition_plan, NULL, signup_source,
      left(nullif(btrim(metadata ->> 'acquisition_medium'), ''), 120),
      left(nullif(btrim(metadata ->> 'acquisition_campaign'), ''), 120),
      left(nullif(btrim(metadata ->> 'acquisition_content'), ''), 120)
    );
  END IF;
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
