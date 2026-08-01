-- Identity-safe acquisition resume, private business logos, and demo-variant analytics.

ALTER TABLE public.businesses
  ADD COLUMN IF NOT EXISTS private_logo_path text,
  ADD COLUMN IF NOT EXISTS licence_state text,
  ADD COLUMN IF NOT EXISTS acquisition_demo_variant text;

ALTER TABLE public.businesses
  DROP CONSTRAINT IF EXISTS businesses_licence_state_check;
ALTER TABLE public.businesses
  ADD CONSTRAINT businesses_licence_state_check
  CHECK (licence_state IS NULL OR licence_state IN ('ACT','NSW','NT','QLD','SA','TAS','VIC','WA'));

ALTER TABLE public.businesses
  DROP CONSTRAINT IF EXISTS businesses_acquisition_demo_variant_check;
ALTER TABLE public.businesses
  ADD CONSTRAINT businesses_acquisition_demo_variant_check
  CHECK (acquisition_demo_variant IS NULL OR acquisition_demo_variant IN ('demo-original','demo-real-world-v2'));

ALTER TABLE public.acquisition_events
  ADD COLUMN IF NOT EXISTS demo_variant text;
ALTER TABLE public.acquisition_events
  DROP CONSTRAINT IF EXISTS acquisition_events_event_name_check;
ALTER TABLE public.acquisition_events
  ADD CONSTRAINT acquisition_events_event_name_check
  CHECK (event_name IN (
    'landing_viewed','service_comparison_viewed','roi_calculator_used',
    'demo_started','demo_25','demo_50','demo_75','demo_completed','demo_closed',
    'signup_opened','package_selected','service_selected','service_card_clicked','promo_validated',
    'wizard_started','wizard_step_viewed','wizard_stage_completed','signup_submitted',
    'account_created','email_confirmation_required','checkout_started','checkout_opened',
    'checkout_completed','checkout_failed','activation_completed','test_job_initiated',
    'test_job_received','first_genuine_job_received'
  ));
ALTER TABLE public.acquisition_events
  DROP CONSTRAINT IF EXISTS acquisition_events_demo_variant_check;
ALTER TABLE public.acquisition_events
  ADD CONSTRAINT acquisition_events_demo_variant_check
  CHECK (demo_variant IS NULL OR demo_variant IN ('demo-original','demo-real-world-v2'));

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'business-logos',
  'business-logos',
  false,
  2097152,
  ARRAY['image/png','image/jpeg','image/webp']
)
ON CONFLICT (id) DO UPDATE SET
  public = false,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS "Tenant members read own private logo" ON storage.objects;
CREATE POLICY "Tenant members read own private logo"
  ON storage.objects FOR SELECT TO authenticated
  USING (
    bucket_id = 'business-logos'
    AND (storage.foldername(name))[1] = public.current_business_id()::text
  );

-- Browser clients cannot write this bucket. The authenticated application route
-- validates file bytes and tenant ownership before using the service role.
COMMENT ON COLUMN public.businesses.private_logo_path IS
  'Private business-logos storage object. Not projected through businesses_public.';
COMMENT ON COLUMN public.businesses.licence_state IS
  'Optional self-reported Australian issuing state/territory; not externally verified.';
