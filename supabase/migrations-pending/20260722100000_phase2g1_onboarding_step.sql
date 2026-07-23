-- Phase 2G.1 acceptance gap fix: persist the exact onboarding wizard step.
--
-- Idempotent, repository-only. NOT AUTO-EXECUTED. Placed under
-- supabase/migrations-pending/ for human review because this Lovable
-- environment forbids adding files under supabase/migrations/ without
-- running them through the migration tool. Move (or copy) this file into
-- supabase/migrations/ once approved for execution.
--
-- What this does:
--   - Adds public.businesses.onboarding_step (smallint, NOT NULL DEFAULT 0).
--   - Constrains it to the wizard's 0..7 range via a named CHECK constraint.
--
-- What this does NOT do: no data changes, no RLS changes, no grant changes.
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