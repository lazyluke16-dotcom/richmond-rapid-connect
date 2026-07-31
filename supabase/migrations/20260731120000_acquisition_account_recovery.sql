-- Recover email-confirmed acquisition users whose browser confirmation flow
-- completed before business onboarding. The authenticated user identity and
-- acquisition fields are read from signed auth claims; callers cannot select
-- another user, business, plan, or promotion.

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
  IF uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;

  -- Serialize recovery attempts for this user so page refreshes or concurrent
  -- Account requests cannot create duplicate businesses.
  PERFORM pg_advisory_xact_lock(hashtextextended(uid::text, 0));

  SELECT bu.business_id INTO bid
    FROM public.business_users bu
   WHERE bu.user_id = uid
   ORDER BY bu.created_at ASC
   LIMIT 1;
  IF bid IS NOT NULL THEN
    RETURN bid;
  END IF;

  business_name := left(nullif(btrim(metadata ->> 'business_name'), ''), 160);
  acquisition_plan := metadata ->> 'acquisition_plan';
  promotion_code := upper(btrim(metadata ->> 'acquisition_promo_code'));
  signup_source := left(nullif(btrim(metadata ->> 'acquisition_source'), ''), 120);
  referral_code := left(nullif(btrim(metadata ->> 'referral_code'), ''), 120);

  IF business_name IS NULL
     OR acquisition_plan NOT IN ('missed_call_recovery', 'ai_receptionist')
     OR promotion_code !~ '^[A-Z0-9_-]{3,64}$'
  THEN
    RAISE EXCEPTION 'No recoverable acquisition signup found';
  END IF;

  SELECT created.id INTO bid
    FROM public.create_business_for_current_user(
      business_name,
      business_name,
      COALESCE(signup_source, 'acquisition_funnel'),
      NULL,
      referral_code
    ) AS created
   LIMIT 1;

  PERFORM public.redeem_acquisition_offer(
    promotion_code,
    acquisition_plan,
    NULL,
    signup_source,
    left(nullif(btrim(metadata ->> 'acquisition_medium'), ''), 120),
    left(nullif(btrim(metadata ->> 'acquisition_campaign'), ''), 120),
    left(nullif(btrim(metadata ->> 'acquisition_content'), ''), 120)
  );

  UPDATE public.businesses
     SET public_email = COALESCE(public_email, auth.jwt() ->> 'email'),
         public_phone = COALESCE(
           public_phone,
           left(nullif(btrim(metadata ->> 'business_phone_e164'), ''), 40)
         )
   WHERE id = bid;

  RETURN bid;
END;
$$;

REVOKE ALL ON FUNCTION public.recover_my_acquisition_business() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.recover_my_acquisition_business() TO authenticated;
