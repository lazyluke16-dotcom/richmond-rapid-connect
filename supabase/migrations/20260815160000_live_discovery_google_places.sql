-- Autonomous Acquisition V1 — Slice 2.5: Live Discovery Provider (Issue #25)
--
-- Adds the two prerequisites the independent Slice-2 review required before enabling a
-- metered live provider (Google Places), plus retention metadata for temporarily-cacheable
-- Google-derived content. No new tables; extends the Slice-2 discovery schema. Still
-- service-role only, no lifecycle beyond feeding Slice-1 (DB-CHECK capped at demo_ready).

-- ---------------------------------------------------------------------------
-- discovery_missions: single-flight lease (prerequisite #1)
-- ---------------------------------------------------------------------------
-- A DB-backed lease makes it impossible for two concurrent workers to advance the SAME
-- mission at once, which in turn makes the (read-modify-write) cost accumulation and cursor
-- updates race-free and guarantees the operator spend ceiling cannot be bypassed. The lease
-- is acquired via an atomic conditional UPDATE (see SupabaseMissionStore.acquireLease):
--   UPDATE ... SET lease_token, lease_expires_at
--   WHERE id = $id AND (lease_expires_at IS NULL OR lease_expires_at < now())
ALTER TABLE public.discovery_missions
  ADD COLUMN IF NOT EXISTS lease_token text
    CHECK (lease_token IS NULL OR lease_token ~ '^[a-f0-9]{32}$'),
  ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz;

-- ---------------------------------------------------------------------------
-- discovery_candidates: Google content retention metadata
-- ---------------------------------------------------------------------------
-- Google Place IDs are exempt from caching limits (stored indefinitely as
-- provider_business_id). Other Google-derived display content (name, formatted address,
-- locality) is temporary cache under the Google Maps Platform Service Specific Terms, so for
-- google_places candidates we stamp an expiry and purge the display fields after it (keeping
-- only the durable Place ID + internal state + the business's own website). Latitude/longitude
-- is never requested or stored. See docs/LIVE_DISCOVERY_GOOGLE_PLACES.md.
ALTER TABLE public.discovery_candidates
  ADD COLUMN IF NOT EXISTS provider_content_expires_at timestamptz;

CREATE INDEX IF NOT EXISTS discovery_candidates_content_expiry_idx
  ON public.discovery_candidates (provider_content_expires_at)
  WHERE provider_content_expires_at IS NOT NULL;
