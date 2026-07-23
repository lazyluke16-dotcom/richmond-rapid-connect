-- Phase 3B — Reproducibility of the deployed enrichment pipeline.
-- Idempotent capture of the live enrichment_jobs contract, the
-- claim_enrichment_jobs() FOR UPDATE SKIP LOCKED processor helper,
-- the get_processor_key() vault reader, grants/revokes, and a
-- guarded pg_cron scheduling stanza. Safe on fresh DB and current live DB —
-- must NOT rotate any secret, modify existing rows, or duplicate the
-- currently active cron job.

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- enrichment_jobs — durable queue for post-call Vapi enrichment.
CREATE TABLE IF NOT EXISTS public.enrichment_jobs (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  call_id               text NOT NULL,
  lead_id               text NOT NULL,
  business_id           uuid NOT NULL,
  status                text NOT NULL DEFAULT 'pending',
  attempt_count         integer NOT NULL DEFAULT 0,
  max_attempts          integer NOT NULL DEFAULT 5,
  run_after             timestamptz NOT NULL DEFAULT (now() + interval '90 seconds'),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  error_message         text,
  processing_started_at timestamptz
);

ALTER TABLE public.enrichment_jobs
  DROP CONSTRAINT IF EXISTS enrichment_jobs_status_check;
ALTER TABLE public.enrichment_jobs
  ADD  CONSTRAINT enrichment_jobs_status_check
  CHECK (status IN ('pending','processing','completed','failed'));

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'enrichment_jobs_call_id_key'
      AND conrelid = 'public.enrichment_jobs'::regclass
  ) THEN
    ALTER TABLE public.enrichment_jobs
      ADD CONSTRAINT enrichment_jobs_call_id_key UNIQUE (call_id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS enrichment_jobs_poll_idx
  ON public.enrichment_jobs (status, run_after)
  WHERE status IN ('pending','processing');

CREATE INDEX IF NOT EXISTS enrichment_jobs_stale_lease_idx
  ON public.enrichment_jobs (processing_started_at)
  WHERE status = 'processing';

-- RLS on. No policies: system queue accessed only by service_role (bypasses RLS)
-- via /api/public/process-enrichment-jobs. authenticated/anon have no grants.
ALTER TABLE public.enrichment_jobs ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.enrichment_jobs FROM anon, authenticated;
GRANT  ALL ON public.enrichment_jobs TO   service_role;

-- claim_enrichment_jobs — atomic claim with stale-lease recovery.
-- Fully-qualifies pending_job.id to avoid the "column reference id is ambiguous"
-- regression fixed on 2026-07-21. SECURITY DEFINER, empty search_path,
-- service_role-only execution.
CREATE OR REPLACE FUNCTION public.claim_enrichment_jobs(
  _limit          integer DEFAULT 5,
  _lease_seconds  integer DEFAULT 120
)
RETURNS TABLE (
  id            uuid,
  call_id       text,
  lead_id       text,
  business_id   uuid,
  attempt_count integer,
  max_attempts  integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
BEGIN
  UPDATE public.enrichment_jobs AS stale_job
     SET status     = 'pending',
         updated_at = now()
   WHERE stale_job.status = 'processing'
     AND stale_job.processing_started_at IS NOT NULL
     AND stale_job.processing_started_at
           < now() - (_lease_seconds * interval '1 second');

  RETURN QUERY
  UPDATE public.enrichment_jobs AS ej
     SET status                = 'processing',
         processing_started_at = now(),
         updated_at            = now()
    FROM (
      SELECT pending_job.id
        FROM public.enrichment_jobs AS pending_job
       WHERE pending_job.status = 'pending'
         AND pending_job.run_after <= now()
       ORDER BY pending_job.run_after ASC
       LIMIT _limit
       FOR UPDATE OF pending_job SKIP LOCKED
    ) AS claimed
   WHERE ej.id = claimed.id
  RETURNING
    ej.id,
    ej.call_id,
    ej.lead_id,
    ej.business_id,
    ej.attempt_count,
    ej.max_attempts;
END;
$function$;

REVOKE ALL ON FUNCTION public.claim_enrichment_jobs(integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_enrichment_jobs(integer, integer) TO service_role;

-- get_processor_key — reads processor auth key from Supabase Vault.
-- Never embeds/prints/rotates the key. service_role-only execute.
CREATE OR REPLACE FUNCTION public.get_processor_key()
RETURNS text
LANGUAGE sql
SECURITY DEFINER
SET search_path TO ''
AS $function$
  SELECT decrypted_secret
    FROM vault.decrypted_secrets
   WHERE name = 'processor_api_key'
   LIMIT 1;
$function$;

REVOKE ALL ON FUNCTION public.get_processor_key() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_processor_key() TO service_role;

-- pg_cron scheduling contract (guarded).
-- Schedules the 'phase3b-enrichment-processor' job every two minutes only
-- when (a) no job with that exact name exists AND (b) no other job already
-- points at /api/public/process-enrichment-jobs. No secret value is read,
-- resolved, or interpolated at migration time — the scheduled command
-- calls public.get_processor_key() at each execution so the key lives only
-- inside the transient request built by pg_net.
DO $$
DECLARE
  v_existing      int;
  v_cron_job_name text := 'phase3b-enrichment-processor';
BEGIN
  SELECT count(*) INTO v_existing
    FROM cron.job
   WHERE jobname = v_cron_job_name
      OR command ILIKE '%/api/public/process-enrichment-jobs%';

  IF v_existing > 0 THEN
    RAISE NOTICE 'enrichment cron already scheduled — leaving live schedule untouched';
    RETURN;
  END IF;

  PERFORM cron.schedule(
    v_cron_job_name,
    '*/2 * * * *',
    $cmd$
    SELECT net.http_post(
      url     := 'https://your-ai-trade-assistant.lovable.app/api/public/process-enrichment-jobs',
      headers := jsonb_build_object(
                   'Content-Type',    'application/json',
                   'x-processor-key', public.get_processor_key()
                 ),
      body    := '{}'::jsonb
    );
    $cmd$
  );
END $$;
