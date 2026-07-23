
-- 1. businesses table
CREATE TABLE public.businesses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  phone TEXT,
  alert_phone TEXT,
  email TEXT,
  logo_url TEXT,
  primary_colour TEXT,
  secondary_colour TEXT,
  accent_colour TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT ON public.businesses TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.businesses TO authenticated;
GRANT ALL ON public.businesses TO service_role;
ALTER TABLE public.businesses ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Demo open read on businesses" ON public.businesses FOR SELECT USING (true);
CREATE POLICY "Service role manages businesses" ON public.businesses FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql SET search_path = public;

CREATE TRIGGER businesses_set_updated_at
BEFORE UPDATE ON public.businesses
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- 2. business_users table
CREATE TABLE public.business_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  role TEXT NOT NULL DEFAULT 'owner',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, user_id)
);
CREATE INDEX business_users_user_id_idx ON public.business_users(user_id);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.business_users TO authenticated;
GRANT ALL ON public.business_users TO service_role;
ALTER TABLE public.business_users ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users see their own business memberships" ON public.business_users
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Service role manages business_users" ON public.business_users
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- 3. Seed Richmond Rapid Plumbing as tenant #1
INSERT INTO public.businesses (slug, name, primary_colour, accent_colour)
VALUES ('richmond-rapid-plumbing', 'Richmond Rapid Plumbing', '#1f2a44', '#f4c430');

-- 4. Add business_id to existing tables, backfill, enforce NOT NULL + FK
ALTER TABLE public.leads         ADD COLUMN business_id UUID REFERENCES public.businesses(id);
ALTER TABLE public.missed_calls  ADD COLUMN business_id UUID REFERENCES public.businesses(id);
ALTER TABLE public.sms_events    ADD COLUMN business_id UUID REFERENCES public.businesses(id);

UPDATE public.leads        SET business_id = (SELECT id FROM public.businesses WHERE slug='richmond-rapid-plumbing') WHERE business_id IS NULL;
UPDATE public.missed_calls SET business_id = (SELECT id FROM public.businesses WHERE slug='richmond-rapid-plumbing') WHERE business_id IS NULL;
UPDATE public.sms_events   SET business_id = (SELECT id FROM public.businesses WHERE slug='richmond-rapid-plumbing') WHERE business_id IS NULL;

ALTER TABLE public.leads        ALTER COLUMN business_id SET NOT NULL;
ALTER TABLE public.missed_calls ALTER COLUMN business_id SET NOT NULL;
ALTER TABLE public.sms_events   ALTER COLUMN business_id SET NOT NULL;

CREATE INDEX leads_business_id_idx        ON public.leads(business_id);
CREATE INDEX missed_calls_business_id_idx ON public.missed_calls(business_id);
CREATE INDEX sms_events_business_id_idx   ON public.sms_events(business_id);
