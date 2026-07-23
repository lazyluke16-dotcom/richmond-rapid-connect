-- Phase 2A.2: Tenant isolation via RLS + auth-scoped access

-- 1) Drop unsafe demo open-access policies
DROP POLICY IF EXISTS "Demo open access on leads" ON public.leads;
DROP POLICY IF EXISTS "Demo open access on missed_calls" ON public.missed_calls;
DROP POLICY IF EXISTS "Demo open access on sms_events" ON public.sms_events;

-- 2) Revoke anon CRUD on protected tables. Public writes go through
--    server-side createServerFn/API routes using service_role.
REVOKE ALL ON public.leads FROM anon;
REVOKE ALL ON public.missed_calls FROM anon;
REVOKE ALL ON public.sms_events FROM anon;

-- 3) Ensure roles have the exact grants their policies allow.
GRANT SELECT, INSERT, UPDATE ON public.leads TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.missed_calls TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.sms_events TO authenticated;
GRANT ALL ON public.leads TO service_role;
GRANT ALL ON public.missed_calls TO service_role;
GRANT ALL ON public.sms_events TO service_role;

-- 4) Uniqueness on business_users membership rows.
CREATE UNIQUE INDEX IF NOT EXISTS business_users_business_user_unique
  ON public.business_users(business_id, user_id);

-- 5) Tenant helper (SECURITY DEFINER, fixed search_path, no user input).
--    MVP assumption: one primary business per plumber user. Returns the
--    earliest-joined membership. When we support multiple businesses per
--    user, replace with an explicit active-tenant selector (e.g. session
--    JWT claim or user-scoped setting) and keep this signature.
CREATE OR REPLACE FUNCTION public.current_business_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT business_id
  FROM public.business_users
  WHERE user_id = auth.uid()
  ORDER BY created_at ASC
  LIMIT 1
$$;

REVOKE ALL ON FUNCTION public.current_business_id() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.current_business_id() TO authenticated;

-- 6) Tenant-scoped authenticated policies. No DELETE anywhere — deletion
--    is not part of the current app surface; add per-tenant DELETE later
--    if needed.
CREATE POLICY "Tenant members read leads"
  ON public.leads FOR SELECT TO authenticated
  USING (business_id = public.current_business_id());
CREATE POLICY "Tenant members insert leads"
  ON public.leads FOR INSERT TO authenticated
  WITH CHECK (business_id = public.current_business_id());
CREATE POLICY "Tenant members update leads"
  ON public.leads FOR UPDATE TO authenticated
  USING (business_id = public.current_business_id())
  WITH CHECK (business_id = public.current_business_id());

CREATE POLICY "Tenant members read missed_calls"
  ON public.missed_calls FOR SELECT TO authenticated
  USING (business_id = public.current_business_id());
CREATE POLICY "Tenant members insert missed_calls"
  ON public.missed_calls FOR INSERT TO authenticated
  WITH CHECK (business_id = public.current_business_id());
CREATE POLICY "Tenant members update missed_calls"
  ON public.missed_calls FOR UPDATE TO authenticated
  USING (business_id = public.current_business_id())
  WITH CHECK (business_id = public.current_business_id());

CREATE POLICY "Tenant members read sms_events"
  ON public.sms_events FOR SELECT TO authenticated
  USING (business_id = public.current_business_id());
CREATE POLICY "Tenant members insert sms_events"
  ON public.sms_events FOR INSERT TO authenticated
  WITH CHECK (business_id = public.current_business_id());
CREATE POLICY "Tenant members update sms_events"
  ON public.sms_events FOR UPDATE TO authenticated
  USING (business_id = public.current_business_id())
  WITH CHECK (business_id = public.current_business_id());

-- 7) business_users: prevent authenticated users from claiming or altering
--    memberships from the browser. Only service_role (server-side) manages
--    memberships; the existing "Users see their own business memberships"
--    SELECT policy remains for reads. Explicitly revoke write privileges.
REVOKE INSERT, UPDATE, DELETE ON public.business_users FROM authenticated;

-- 8) businesses: keep the public read policy so the public customer form
--    can resolve a tenant by slug server-side, but restrict writes to
--    service_role only.
REVOKE INSERT, UPDATE, DELETE ON public.businesses FROM authenticated, anon;