
ALTER TABLE public.businesses
  ADD COLUMN IF NOT EXISTS public_phone text,
  ADD COLUMN IF NOT EXISTS public_email text,
  ADD COLUMN IF NOT EXISTS short_description text,
  ADD COLUMN IF NOT EXISTS hero_heading text,
  ADD COLUMN IF NOT EXISTS hero_subheading text,
  ADD COLUMN IF NOT EXISTS emergency_message text,
  ADD COLUMN IF NOT EXISTS active boolean NOT NULL DEFAULT true;

DROP VIEW IF EXISTS public.businesses_public;
CREATE VIEW public.businesses_public
WITH (security_invoker = true) AS
SELECT
  id, name, slug, public_phone, public_email, logo_url,
  primary_colour, secondary_colour, accent_colour,
  short_description, hero_heading, hero_subheading, emergency_message, active
FROM public.businesses
WHERE active = true;

GRANT SELECT ON public.businesses_public TO anon, authenticated;

DROP POLICY IF EXISTS "Public can view active businesses" ON public.businesses;
DROP POLICY IF EXISTS "businesses_public_read" ON public.businesses;
DROP POLICY IF EXISTS "businesses_anon_select" ON public.businesses;
DROP POLICY IF EXISTS "Members can view their business" ON public.businesses;
DROP POLICY IF EXISTS "businesses_member_select" ON public.businesses;
DROP POLICY IF EXISTS "businesses_member_update" ON public.businesses;

CREATE POLICY "businesses_member_select" ON public.businesses
  FOR SELECT TO authenticated
  USING (id = public.current_business_id());

CREATE POLICY "businesses_member_update" ON public.businesses
  FOR UPDATE TO authenticated
  USING (id = public.current_business_id())
  WITH CHECK (id = public.current_business_id());

CREATE TABLE IF NOT EXISTS public.business_services (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  service_key text NOT NULL,
  display_name text NOT NULL,
  description text,
  active boolean NOT NULL DEFAULT true,
  display_order int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, service_key)
);
GRANT SELECT ON public.business_services TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.business_services TO authenticated;
GRANT ALL ON public.business_services TO service_role;
ALTER TABLE public.business_services ENABLE ROW LEVEL SECURITY;

CREATE POLICY "services_public_read_active" ON public.business_services
  FOR SELECT TO anon, authenticated
  USING (active = true AND EXISTS (
    SELECT 1 FROM public.businesses b WHERE b.id = business_id AND b.active = true
  ));
CREATE POLICY "services_owner_manage" ON public.business_services
  FOR ALL TO authenticated
  USING (business_id = public.current_business_id())
  WITH CHECK (business_id = public.current_business_id());

CREATE TRIGGER trg_business_services_updated BEFORE UPDATE ON public.business_services
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE IF NOT EXISTS public.business_service_areas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  suburb text NOT NULL,
  state text,
  postcode text,
  active boolean NOT NULL DEFAULT true,
  display_order int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.business_service_areas TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.business_service_areas TO authenticated;
GRANT ALL ON public.business_service_areas TO service_role;
ALTER TABLE public.business_service_areas ENABLE ROW LEVEL SECURITY;

CREATE POLICY "areas_public_read_active" ON public.business_service_areas
  FOR SELECT TO anon, authenticated
  USING (active = true AND EXISTS (
    SELECT 1 FROM public.businesses b WHERE b.id = business_id AND b.active = true
  ));
CREATE POLICY "areas_owner_manage" ON public.business_service_areas
  FOR ALL TO authenticated
  USING (business_id = public.current_business_id())
  WITH CHECK (business_id = public.current_business_id());

CREATE TRIGGER trg_business_areas_updated BEFORE UPDATE ON public.business_service_areas
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE IF NOT EXISTS public.business_hours (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  day_of_week int NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  open_time time,
  close_time time,
  closed boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, day_of_week)
);
GRANT SELECT ON public.business_hours TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.business_hours TO authenticated;
GRANT ALL ON public.business_hours TO service_role;
ALTER TABLE public.business_hours ENABLE ROW LEVEL SECURITY;

CREATE POLICY "hours_public_read" ON public.business_hours
  FOR SELECT TO anon, authenticated
  USING (EXISTS (
    SELECT 1 FROM public.businesses b WHERE b.id = business_id AND b.active = true
  ));
CREATE POLICY "hours_owner_manage" ON public.business_hours
  FOR ALL TO authenticated
  USING (business_id = public.current_business_id())
  WITH CHECK (business_id = public.current_business_id());

CREATE TRIGGER trg_business_hours_updated BEFORE UPDATE ON public.business_hours
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

UPDATE public.businesses SET
  public_phone = COALESCE(public_phone, '1300 000 000'),
  public_email = COALESCE(public_email, 'hello@richmondrapid.com.au'),
  short_description = COALESCE(short_description, 'Local Melbourne plumbers — fast, licensed, no BS.'),
  hero_heading = COALESCE(hero_heading, 'Send the job in 60 seconds.'),
  hero_subheading = COALESCE(hero_subheading, 'Local Melbourne plumbers covering Richmond, Cremorne, South Yarra, Hawthorn, Abbotsford and Prahran. Fair pricing, licensed and insured.'),
  emergency_message = COALESCE(emergency_message, 'On the tools right now'),
  primary_colour = COALESCE(primary_colour, '#F97316'),
  secondary_colour = COALESCE(secondary_colour, '#0F1423'),
  accent_colour = COALESCE(accent_colour, '#FBBF24'),
  active = true
WHERE slug = 'richmond-rapid-plumbing';

UPDATE public.businesses SET
  public_phone = COALESCE(public_phone, '1300 258 928'),
  public_email = COALESCE(public_email, 'hello@bluewaveplumbing.com.au'),
  short_description = COALESCE(short_description, 'Bayside Melbourne plumbing specialists — clean, calm, on time.'),
  hero_heading = COALESCE(hero_heading, 'Bayside plumbing, done properly.'),
  hero_subheading = COALESCE(hero_subheading, 'Serving St Kilda, Elwood, Brighton and Elsternwick. Licensed, insured, and easy to deal with.'),
  emergency_message = COALESCE(emergency_message, '24/7 emergency response across Bayside'),
  primary_colour = '#0EA5E9',
  secondary_colour = '#0B2545',
  accent_colour = '#67E8F9',
  active = true
WHERE slug = 'bluewave-plumbing';

INSERT INTO public.business_services (business_id, service_key, display_name, description, display_order)
SELECT b.id, k.service_key, k.display_name, k.description, k.display_order
FROM public.businesses b, (VALUES
  ('emergency-plumbing','Emergency plumbing','Burst pipes, no water, urgent leaks — 24/7', 1),
  ('blocked-drains','Blocked drains','Sinks, showers, toilets, sewer lines', 2),
  ('hot-water','Hot water','Repair, replace, storage or continuous flow', 3),
  ('burst-pipes','Burst pipes','Locate, isolate, repair or replace', 4),
  ('leaking-taps','Leaking taps','Washers, cartridges, mixer replacements', 5),
  ('gas','Gas fitting','Licensed gas installations & leak repairs', 6),
  ('general-plumbing','General plumbing','Maintenance and everyday repairs', 7)
) AS k(service_key, display_name, description, display_order)
WHERE b.slug = 'richmond-rapid-plumbing'
ON CONFLICT (business_id, service_key) DO NOTHING;

INSERT INTO public.business_services (business_id, service_key, display_name, description, display_order)
SELECT b.id, k.service_key, k.display_name, k.description, k.display_order
FROM public.businesses b, (VALUES
  ('hot-water','Hot water systems','Bayside specialists — solar, heat pump, gas', 1),
  ('blocked-drains','Blocked drains & CCTV','High-pressure jetting and camera inspection', 2),
  ('toilets','Toilet repairs & install','Concealed cisterns, wall-hung, back-to-wall', 3),
  ('leaking-taps','Tap & mixer repairs','Modern mixers and heritage tapware', 4),
  ('emergency-plumbing','24/7 emergency','Bayside emergency response', 5),
  ('general-plumbing','General maintenance','Bathroom, laundry, kitchen', 6)
) AS k(service_key, display_name, description, display_order)
WHERE b.slug = 'bluewave-plumbing'
ON CONFLICT (business_id, service_key) DO NOTHING;

INSERT INTO public.business_service_areas (business_id, suburb, state, display_order)
SELECT b.id, s.suburb, 'VIC', s.ord
FROM public.businesses b, (VALUES
  ('Richmond', 1), ('Cremorne', 2), ('Hawthorn', 3), ('Kew', 4),
  ('Burnley', 5), ('Abbotsford', 6), ('South Yarra', 7), ('Prahran', 8)
) AS s(suburb, ord)
WHERE b.slug = 'richmond-rapid-plumbing';

INSERT INTO public.business_service_areas (business_id, suburb, state, display_order)
SELECT b.id, s.suburb, 'VIC', s.ord
FROM public.businesses b, (VALUES
  ('St Kilda', 1), ('Elwood', 2), ('Brighton', 3), ('Elsternwick', 4),
  ('Balaclava', 5), ('Ripponlea', 6), ('Middle Park', 7)
) AS s(suburb, ord)
WHERE b.slug = 'bluewave-plumbing';

INSERT INTO public.business_hours (business_id, day_of_week, open_time, close_time, closed)
SELECT b.id, d.dow, d.open_t::time, d.close_t::time, d.closed
FROM public.businesses b, (VALUES
  (0, NULL, NULL, true),
  (1, '07:00', '18:00', false),
  (2, '07:00', '18:00', false),
  (3, '07:00', '18:00', false),
  (4, '07:00', '18:00', false),
  (5, '07:00', '18:00', false),
  (6, '08:00', '14:00', false)
) AS d(dow, open_t, close_t, closed)
WHERE b.slug IN ('richmond-rapid-plumbing','bluewave-plumbing')
ON CONFLICT (business_id, day_of_week) DO NOTHING;
