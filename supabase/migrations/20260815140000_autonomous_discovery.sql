-- Autonomous Acquisition V1 — Slice 2: Autonomous Prospect Discovery (Issue #23)
--
-- Adds a bounded, resumable discovery layer on top of the Slice-1 prospect domain. An
-- operator creates a discovery MISSION (a bounded geography + vertical + target count);
-- the engine pulls CANDIDATES from an approved provider adapter, normalises + deduplicates
-- + pre-qualifies them, and feeds the accepted ones into the existing Slice-1 research +
-- demo pipeline. It sends NO outreach and creates NO paid provider resources.
--
-- Safety:
--   * All discovery tables are service-role only (no anon/authenticated grants), matching
--     the acquisition/outreach/prospect privacy-minimal model.
--   * There is no lifecycle here beyond feeding Slice-1, which is itself DB-CHECK-capped at
--     'demo_ready'. Discovery introduces no outreach/customer states.
--   * Per-mission dedup uniqueness + the prospects.canonical_domain unique constraint make
--     concurrent discovery idempotent (no duplicate candidates or prospects).

-- ---------------------------------------------------------------------------
-- discovery_missions — bounded, resumable discovery run
-- ---------------------------------------------------------------------------
CREATE TABLE public.discovery_missions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'approved', 'running', 'paused', 'completed', 'failed', 'cancelled')),
  vertical text NOT NULL DEFAULT 'plumbing' CHECK (length(btrim(vertical)) BETWEEN 2 AND 80),
  -- Human display scope (e.g. "Richmond, VIC" / "Greater Melbourne").
  geography text NOT NULL CHECK (length(btrim(geography)) BETWEEN 2 AND 200),
  -- Lowercased locality tokens used for deterministic geography pre-qualification.
  geo_terms text[] NOT NULL DEFAULT ARRAY[]::text[],
  -- Requested result target and an absolute hard cap on candidates ever examined.
  target_count integer NOT NULL CHECK (target_count BETWEEN 1 AND 1000),
  max_candidates integer NOT NULL CHECK (max_candidates BETWEEN 1 AND 5000),
  -- Enabled provider adapter(s). Only lawful/approved sources; V1 ships 'fixture'/'import'.
  sources text[] NOT NULL DEFAULT ARRAY['fixture']::text[]
    CHECK (cardinality(sources) BETWEEN 1 AND 8),
  -- Per-source cursor/page state so the mission is fully resumable from the database.
  cursor jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Operator-supplied seed for the 'import' source: the bounded list of businesses the
  -- operator is permitted to process (real, curated). Not fabricated. The 'import' provider
  -- pages through this. Empty for missions using another source. Bounded in application code.
  import_seed jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Spend controls for metered sources (cents). NULL ceiling = no metered spend permitted.
  cost_cents integer NOT NULL DEFAULT 0 CHECK (cost_cents >= 0),
  cost_ceiling_cents integer CHECK (cost_ceiling_cents IS NULL OR cost_ceiling_cents >= 0),
  -- Retry/backoff bookkeeping for transient provider failures.
  retry_count integer NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
  max_retries integer NOT NULL DEFAULT 3 CHECK (max_retries BETWEEN 0 AND 20),
  -- Denormalised counters (authoritatively recomputed from discovery_candidates).
  discovered_count integer NOT NULL DEFAULT 0 CHECK (discovered_count >= 0),
  accepted_count integer NOT NULL DEFAULT 0 CHECK (accepted_count >= 0),
  duplicate_count integer NOT NULL DEFAULT 0 CHECK (duplicate_count >= 0),
  rejected_count integer NOT NULL DEFAULT 0 CHECK (rejected_count >= 0),
  failed_count integer NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
  demo_ready_count integer NOT NULL DEFAULT 0 CHECK (demo_ready_count >= 0),
  last_error text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (max_candidates >= target_count)
);

CREATE INDEX discovery_missions_status_idx ON public.discovery_missions (status, created_at DESC);

CREATE TRIGGER discovery_missions_set_updated_at
BEFORE UPDATE ON public.discovery_missions
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.discovery_missions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.discovery_missions FROM anon, authenticated;
GRANT ALL ON public.discovery_missions TO service_role;
CREATE POLICY "service_role_manages_discovery_missions"
  ON public.discovery_missions FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- discovery_candidates — provenance-carrying discovered businesses
-- ---------------------------------------------------------------------------
CREATE TABLE public.discovery_candidates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mission_id uuid NOT NULL REFERENCES public.discovery_missions(id) ON DELETE CASCADE,
  source text NOT NULL CHECK (length(btrim(source)) BETWEEN 2 AND 80),
  provider_business_id text CHECK (provider_business_id IS NULL OR length(provider_business_id) <= 200),
  source_url text CHECK (source_url IS NULL OR (source_url LIKE 'http%' AND length(source_url) <= 2000)),
  business_name text CHECK (business_name IS NULL OR length(business_name) <= 200),
  website text CHECK (website IS NULL OR length(website) <= 2000),
  canonical_domain text CHECK (canonical_domain IS NULL OR canonical_domain = lower(canonical_domain)),
  public_phone text CHECK (public_phone IS NULL OR length(public_phone) <= 40),
  locality text CHECK (locality IS NULL OR length(locality) <= 200),
  discovery_query text CHECK (discovery_query IS NULL OR length(discovery_query) <= 400),
  -- The layered deterministic deduplication key (domain > provider-id > phone > name+locality).
  dedup_key text NOT NULL CHECK (length(dedup_key) BETWEEN 1 AND 400),
  disposition text NOT NULL DEFAULT 'discovered'
    CHECK (disposition IN ('discovered', 'duplicate', 'rejected', 'accepted', 'demo_ready', 'failed')),
  -- The earlier candidate this one duplicates (within the mission), when disposition='duplicate'.
  duplicate_of uuid REFERENCES public.discovery_candidates(id) ON DELETE SET NULL,
  -- Explainable acceptance/duplicate/rejection reason code.
  reason text CHECK (reason IS NULL OR length(reason) <= 200),
  accepted_prospect_id uuid REFERENCES public.prospects(id) ON DELETE SET NULL,
  raw_hash text CHECK (raw_hash IS NULL OR raw_hash ~ '^[a-f0-9]{64}$'),
  discovered_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- Idempotency + concurrency: a given identity can appear at most once per mission, so two
  -- workers racing on the same candidate cannot both insert it.
  UNIQUE (mission_id, dedup_key)
);

CREATE INDEX discovery_candidates_mission_disposition_idx
  ON public.discovery_candidates (mission_id, disposition);
CREATE INDEX discovery_candidates_mission_discovered_idx
  ON public.discovery_candidates (mission_id, discovered_at);
CREATE INDEX discovery_candidates_domain_idx
  ON public.discovery_candidates (canonical_domain)
  WHERE canonical_domain IS NOT NULL;

CREATE TRIGGER discovery_candidates_set_updated_at
BEFORE UPDATE ON public.discovery_candidates
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.discovery_candidates ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.discovery_candidates FROM anon, authenticated;
GRANT ALL ON public.discovery_candidates TO service_role;
CREATE POLICY "service_role_manages_discovery_candidates"
  ON public.discovery_candidates FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- discovery_mission_events — append-only mission/action audit
-- ---------------------------------------------------------------------------
CREATE TABLE public.discovery_mission_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mission_id uuid NOT NULL REFERENCES public.discovery_missions(id) ON DELETE CASCADE,
  event_type text NOT NULL CHECK (event_type IN (
    'created', 'approved', 'started', 'paused', 'resumed', 'cancelled',
    'page_fetched', 'page_failed', 'candidate_processed', 'completed', 'failed'
  )),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX discovery_mission_events_mission_created_idx
  ON public.discovery_mission_events (mission_id, created_at DESC);

ALTER TABLE public.discovery_mission_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.discovery_mission_events FROM anon, authenticated;
GRANT ALL ON public.discovery_mission_events TO service_role;
CREATE POLICY "service_role_manages_discovery_mission_events"
  ON public.discovery_mission_events FOR ALL TO service_role USING (true) WITH CHECK (true);
