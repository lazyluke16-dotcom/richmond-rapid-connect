
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
  base := regexp_replace(lower(coalesce(p_base, '')), '[^a-z0-9]+', '-', 'g');
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

-- Fix the bad slug from our first test run if it exists
UPDATE public.businesses
SET slug = public.reserve_business_slug(name)
WHERE slug = 'arbour-lumbing-o';
