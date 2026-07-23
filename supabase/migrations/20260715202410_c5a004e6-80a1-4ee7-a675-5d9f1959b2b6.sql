
-- Phase 2C: Self-service onboarding schema + atomic business-creation RPC

ALTER TABLE public.businesses
  ADD COLUMN IF NOT EXISTS onboarding_completed boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS selected_plan text CHECK (selected_plan IN ('missed_call_recovery','ai_receptionist')),
  ADD COLUMN IF NOT EXISTS trial_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS trial_ends_at timestamptz,
  ADD COLUMN IF NOT EXISTS signup_source text,
  ADD COLUMN IF NOT EXISTS partner_code text,
  ADD COLUMN IF NOT EXISTS referral_code text,
  ADD COLUMN IF NOT EXISTS owner_user_id uuid;

-- Backfill owner_user_id for the two existing regression tenants
UPDATE public.businesses b
SET owner_user_id = bu.user_id
FROM public.business_users bu
WHERE bu.business_id = b.id
  AND bu.role = 'owner'
  AND b.owner_user_id IS NULL;

-- Mark the two existing regression tenants as onboarding-complete
UPDATE public.businesses
SET onboarding_completed = true
WHERE slug IN ('richmond-rapid-plumbing','bluewave-plumbing');

-- Slug reservation helper: normalise and find a unique slug.
CREATE OR REPLACE FUNCTION public.reserve_business_slug(p_base text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  base text;
  candidate text;
  n int := 1;
BEGIN
  base := lower(regexp_replace(coalesce(p_base, ''), '[^a-z0-9]+', '-', 'g'));
  base := regexp_replace(base, '(^-+|-+$)', '', 'g');
  IF base = '' OR length(base) < 2 THEN
    base := 'plumber-' || substr(md5(random()::text || clock_timestamp()::text), 1, 6);
  END IF;
  IF length(base) > 50 THEN base := substr(base, 1, 50); END IF;
  candidate := base;
  WHILE EXISTS (SELECT 1 FROM public.businesses WHERE slug = candidate) LOOP
    n := n + 1;
    candidate := base || '-' || n;
    IF n > 1000 THEN
      candidate := base || '-' || substr(md5(random()::text), 1, 6);
      EXIT;
    END IF;
  END LOOP;
  RETURN candidate;
END;
$$;

REVOKE ALL ON FUNCTION public.reserve_business_slug(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reserve_business_slug(text) TO authenticated;

-- Atomic: create business + owner membership for the *currently authenticated user*.
-- Caller cannot spoof owner_user_id or business_id; both are derived from auth.uid().
CREATE OR REPLACE FUNCTION public.create_business_for_current_user(
  p_name text,
  p_slug_base text DEFAULT NULL,
  p_signup_source text DEFAULT NULL,
  p_partner_code text DEFAULT NULL,
  p_referral_code text DEFAULT NULL
)
RETURNS TABLE (id uuid, slug text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  uid uuid := auth.uid();
  existing_business_id uuid;
  new_id uuid;
  final_slug text;
BEGIN
  IF uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;
  IF p_name IS NULL OR btrim(p_name) = '' THEN
    RAISE EXCEPTION 'Business name is required';
  END IF;

  -- Enforce ONE business per user (idempotent onboarding).
  SELECT bu.business_id INTO existing_business_id
  FROM public.business_users bu
  WHERE bu.user_id = uid
  ORDER BY bu.created_at ASC
  LIMIT 1;
  IF existing_business_id IS NOT NULL THEN
    RETURN QUERY SELECT b.id, b.slug FROM public.businesses b WHERE b.id = existing_business_id;
    RETURN;
  END IF;

  final_slug := public.reserve_business_slug(COALESCE(NULLIF(btrim(p_slug_base), ''), p_name));

  INSERT INTO public.businesses (
    name, slug, active, onboarding_completed,
    primary_colour, secondary_colour, accent_colour,
    owner_user_id, signup_source, partner_code, referral_code
  )
  VALUES (
    btrim(p_name), final_slug, true, false,
    '#0EA5E9', '#0B2545', '#67E8F9',
    uid, p_signup_source, p_partner_code, p_referral_code
  )
  RETURNING businesses.id INTO new_id;

  INSERT INTO public.business_users (business_id, user_id, role)
  VALUES (new_id, uid, 'owner');

  RETURN QUERY SELECT new_id, final_slug;
END;
$$;

REVOKE ALL ON FUNCTION public.create_business_for_current_user(text, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_business_for_current_user(text, text, text, text, text) TO authenticated;

-- Allow authenticated owners to change their own slug safely via RPC (checks uniqueness).
CREATE OR REPLACE FUNCTION public.update_my_business_slug(p_new_slug text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  uid uuid := auth.uid();
  my_biz uuid;
  norm text;
BEGIN
  IF uid IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE='42501'; END IF;
  SELECT business_id INTO my_biz FROM public.business_users
    WHERE user_id = uid ORDER BY created_at ASC LIMIT 1;
  IF my_biz IS NULL THEN RAISE EXCEPTION 'No business'; END IF;

  norm := lower(regexp_replace(coalesce(p_new_slug,''), '[^a-z0-9]+', '-', 'g'));
  norm := regexp_replace(norm, '(^-+|-+$)', '', 'g');
  IF length(norm) < 3 THEN RAISE EXCEPTION 'Slug too short'; END IF;
  IF EXISTS (SELECT 1 FROM public.businesses WHERE slug = norm AND id <> my_biz) THEN
    RAISE EXCEPTION 'Slug already taken';
  END IF;

  UPDATE public.businesses SET slug = norm WHERE id = my_biz;
  RETURN norm;
END;
$$;
REVOKE ALL ON FUNCTION public.update_my_business_slug(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.update_my_business_slug(text) TO authenticated;
