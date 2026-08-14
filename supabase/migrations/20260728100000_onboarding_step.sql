-- Persist the exact onboarding wizard step.
--
-- What this does:
--   - Adds public.businesses.onboarding_step (smallint, NOT NULL DEFAULT 0).
--   - Constrains it to the wizard's 0..7 range via a named CHECK constraint.
--
-- No data, RLS, or grant changes are made.
-- Range matches src/lib/onboarding-validation.ts (ONBOARDING_STEP_MIN/MAX).

ALTER TABLE public.businesses
  ADD COLUMN IF NOT EXISTS onboarding_step smallint NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'businesses_onboarding_step_range'
       AND conrelid = 'public.businesses'::regclass
  ) THEN
    ALTER TABLE public.businesses
      ADD CONSTRAINT businesses_onboarding_step_range
      CHECK (onboarding_step >= 0 AND onboarding_step <= 7);
  END IF;
END $$;
