-- Autonomous Acquisition V1 — Prospect Intelligence + Personalised Demo Factory (Issue #21)
--
-- Introduces a first-class PROSPECT domain that is deliberately separate from a
-- customer/tenant (public.businesses). A prospect is a not-yet-contacted business
-- that Richmond Rapid Connect has researched from public information in order to
-- manufacture a private, branded receptionist demo.
--
-- Safety boundary (V1):
--   * The lifecycle CHECK constraint below only permits statuses up to 'demo_ready'.
--     Advancing a prospect to outreach/customer states is intentionally impossible in
--     this slice at the database level. A later slice migration will widen it.
--   * Every material business fact is stored with its own evidence/provenance in
--     public.prospect_facts. Unknown is a first-class value; nothing is fabricated.
--   * All tables are service_role-only. There is NO authenticated/anon access and NO
--     public prospect directory. Operator access is mediated by server-side functions
--     that check an explicit operator allow-list, mirroring the outreach report model.

-- ---------------------------------------------------------------------------
-- prospects — identity, branding cache, lifecycle, score, demo pointer
-- ---------------------------------------------------------------------------
CREATE TABLE public.prospects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status text NOT NULL DEFAULT 'discovered'
    CHECK (status IN ('discovered', 'researching', 'enriched', 'demo_building', 'demo_ready')),
  business_name text CHECK (business_name IS NULL OR length(btrim(business_name)) BETWEEN 1 AND 200),
  website text CHECK (website IS NULL OR (website LIKE 'http%' AND length(website) <= 2000)),
  -- canonical_domain is the deduplication key: a lowercase registrable host with no
  -- scheme, no leading "www." and no trailing dot. NULL is disallowed so every prospect
  -- is de-duplicable and re-runnable research never forks a second record.
  canonical_domain text NOT NULL UNIQUE
    CHECK (canonical_domain = lower(canonical_domain) AND canonical_domain ~ '^[a-z0-9.-]{3,253}$'),
  industry text NOT NULL DEFAULT 'plumbing' CHECK (length(btrim(industry)) BETWEEN 2 AND 80),
  -- Denormalised, display-only caches. Each is ONLY populated from a corresponding
  -- verified row in public.prospect_facts (the authoritative provenance store).
  location text CHECK (location IS NULL OR length(location) <= 300),
  public_phone text CHECK (public_phone IS NULL OR length(public_phone) <= 40),
  logo_url text CHECK (logo_url IS NULL OR length(logo_url) <= 2000),
  favicon_url text CHECK (favicon_url IS NULL OR length(favicon_url) <= 2000),
  primary_colour text CHECK (primary_colour IS NULL OR primary_colour ~ '^#[0-9a-fA-F]{6}$'),
  secondary_colour text CHECK (secondary_colour IS NULL OR secondary_colour ~ '^#[0-9a-fA-F]{6}$'),
  accent_colour text CHECK (accent_colour IS NULL OR accent_colour ~ '^#[0-9a-fA-F]{6}$'),
  brand_source text CHECK (brand_source IS NULL OR brand_source IN ('extracted', 'favicon_fallback', 'default')),
  -- Deterministic score cache (authoritative breakdown lives in public.prospect_scores).
  score integer CHECK (score IS NULL OR score BETWEEN 0 AND 100),
  score_band text CHECK (score_band IS NULL OR score_band IN ('low', 'medium', 'high', 'priority')),
  -- Reserved for a future outreach slice. V1 can only ever be 'none' — there is no
  -- code path in this slice that changes it, and no sending of any kind.
  outreach_authority text NOT NULL DEFAULT 'none' CHECK (outreach_authority = 'none'),
  research_started_at timestamptz,
  enriched_at timestamptz,
  demo_built_at timestamptz,
  last_research_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER prospects_set_updated_at
BEFORE UPDATE ON public.prospects
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.prospects ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.prospects FROM anon, authenticated;
GRANT ALL ON public.prospects TO service_role;
CREATE POLICY "service_role_manages_prospects"
  ON public.prospects FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- prospect_facts — evidence-backed material facts (the provenance store)
-- ---------------------------------------------------------------------------
-- Every material fact the system relies on is one row here, carrying the source URL,
-- the observed context, when it was retrieved, a confidence in [0,1], the extractor
-- that derived it, and a status. 'unknown' rows record that we deliberately could NOT
-- verify something; 'conflicting' records that sources disagreed. Facts are never
-- invented: absence of a verified row means the demo treats the fact as unknown.
CREATE TABLE public.prospect_facts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  prospect_id uuid NOT NULL REFERENCES public.prospects(id) ON DELETE CASCADE,
  fact_type text NOT NULL CHECK (fact_type IN (
    'business_name', 'service', 'service_area', 'opening_hours', 'emergency_service',
    'address', 'public_phone', 'positioning', 'brand_colour', 'logo', 'example_enquiry'
  )),
  value text NOT NULL CHECK (length(btrim(value)) BETWEEN 1 AND 2000),
  normalized_value text NOT NULL CHECK (length(btrim(normalized_value)) BETWEEN 1 AND 2000),
  status text NOT NULL DEFAULT 'verified'
    CHECK (status IN ('verified', 'unknown', 'conflicting')),
  confidence numeric(4, 3) NOT NULL DEFAULT 0 CHECK (confidence >= 0 AND confidence <= 1),
  source_url text CHECK (source_url IS NULL OR (source_url LIKE 'http%' AND length(source_url) <= 2000)),
  observed_context text CHECK (observed_context IS NULL OR length(observed_context) <= 4000),
  extractor text NOT NULL DEFAULT 'deterministic-html'
    CHECK (extractor IN ('deterministic-html', 'structured-data', 'ai-assisted', 'operator', 'system')),
  retrieved_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- Idempotency: re-running research updates the existing row for a
  -- (prospect, type, value) triple rather than forking duplicates.
  UNIQUE (prospect_id, fact_type, normalized_value),
  -- A verified/conflicting material fact must cite a source; unknown must not pretend to.
  CHECK (
    (status = 'unknown' AND source_url IS NULL)
    OR (status IN ('verified', 'conflicting') AND source_url IS NOT NULL)
  )
);

CREATE INDEX prospect_facts_prospect_type_idx
  ON public.prospect_facts (prospect_id, fact_type);

CREATE TRIGGER prospect_facts_set_updated_at
BEFORE UPDATE ON public.prospect_facts
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.prospect_facts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.prospect_facts FROM anon, authenticated;
GRANT ALL ON public.prospect_facts TO service_role;
CREATE POLICY "service_role_manages_prospect_facts"
  ON public.prospect_facts FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- prospect_scores — auditable deterministic scoring breakdown (1:1 with prospect)
-- ---------------------------------------------------------------------------
CREATE TABLE public.prospect_scores (
  prospect_id uuid PRIMARY KEY REFERENCES public.prospects(id) ON DELETE CASCADE,
  score integer NOT NULL CHECK (score BETWEEN 0 AND 100),
  band text NOT NULL CHECK (band IN ('low', 'medium', 'high', 'priority')),
  -- factors: [{ key, label, points, awarded, detail }] — every factor considered,
  -- the points it awarded/deducted, and a human explanation. The engine is rules-based
  -- and deterministic; the LLM is never the source of truth for the score.
  factors jsonb NOT NULL DEFAULT '[]'::jsonb,
  engine_version text NOT NULL DEFAULT 'v1',
  computed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER prospect_scores_set_updated_at
BEFORE UPDATE ON public.prospect_scores
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.prospect_scores ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.prospect_scores FROM anon, authenticated;
GRANT ALL ON public.prospect_scores TO service_role;
CREATE POLICY "service_role_manages_prospect_scores"
  ON public.prospect_scores FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- prospect_demo_configs — versioned safe demo config + private access credential
-- ---------------------------------------------------------------------------
-- The generated demo receptionist configuration together with the unlisted access
-- credential. Only the SHA-256 hash of the demo token is stored (like the outreach
-- unsubscribe token), so a database leak cannot reconstruct a working demo link.
-- Access fails closed on revoked_at, on expiry, or on any token mismatch.
CREATE TABLE public.prospect_demo_configs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  prospect_id uuid NOT NULL REFERENCES public.prospects(id) ON DELETE CASCADE,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{2,80}$'),
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  -- config: the auditable demo definition {greeting, verifiedServices[],
  -- verifiedServiceAreas[], openingHours, emergencyService, exampleEnquiries[],
  -- unknowns[], disclosure, provenance[]} — see docs/AUTONOMOUS_ACQUISITION_V1.md.
  config jsonb NOT NULL,
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (prospect_id, version)
);

CREATE INDEX prospect_demo_configs_prospect_idx
  ON public.prospect_demo_configs (prospect_id, version DESC);

CREATE TRIGGER prospect_demo_configs_set_updated_at
BEFORE UPDATE ON public.prospect_demo_configs
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.prospect_demo_configs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.prospect_demo_configs FROM anon, authenticated;
GRANT ALL ON public.prospect_demo_configs TO service_role;
CREATE POLICY "service_role_manages_prospect_demo_configs"
  ON public.prospect_demo_configs FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- prospect_events — append-only lifecycle/action audit
-- ---------------------------------------------------------------------------
-- Records every status transition and material action. Useful for demonstrating,
-- and testing, that this slice never emits an outreach/send event of any kind.
CREATE TABLE public.prospect_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  prospect_id uuid NOT NULL REFERENCES public.prospects(id) ON DELETE CASCADE,
  event_type text NOT NULL CHECK (event_type IN (
    'created', 'research_started', 'research_completed', 'enriched', 'scored',
    'demo_built', 'demo_revoked', 'demo_viewed', 'status_changed'
  )),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX prospect_events_prospect_created_idx
  ON public.prospect_events (prospect_id, created_at DESC);

ALTER TABLE public.prospect_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.prospect_events FROM anon, authenticated;
GRANT ALL ON public.prospect_events TO service_role;
CREATE POLICY "service_role_manages_prospect_events"
  ON public.prospect_events FOR ALL TO service_role USING (true) WITH CHECK (true);
