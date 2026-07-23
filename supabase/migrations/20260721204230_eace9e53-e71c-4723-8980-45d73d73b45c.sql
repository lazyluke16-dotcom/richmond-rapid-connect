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
  -- Stale processing rows with attempts remaining: consume one attempt and
  -- return to 'pending' so the next tick will re-claim them. Recording a
  -- non-secret category in error_message keeps the failure diagnosable.
  UPDATE public.enrichment_jobs AS stale_job
     SET status                = 'pending',
         attempt_count         = stale_job.attempt_count + 1,
         error_message         = 'stale_processing_lease',
         processing_started_at = NULL,
         updated_at            = now()
   WHERE stale_job.status = 'processing'
     AND stale_job.processing_started_at IS NOT NULL
     AND stale_job.processing_started_at
           < now() - (_lease_seconds * interval '1 second')
     AND stale_job.attempt_count + 1 < stale_job.max_attempts;

  -- Stale processing rows that have exhausted their budget: mark failed.
  UPDATE public.enrichment_jobs AS dead_job
     SET status                = 'failed',
         attempt_count         = dead_job.attempt_count + 1,
         error_message         = 'stale_processing_lease_max_attempts',
         processing_started_at = NULL,
         updated_at            = now()
   WHERE dead_job.status = 'processing'
     AND dead_job.processing_started_at IS NOT NULL
     AND dead_job.processing_started_at
           < now() - (_lease_seconds * interval '1 second')
     AND dead_job.attempt_count + 1 >= dead_job.max_attempts;

  -- Atomic claim of due pending jobs — identical to the Phase 3B contract.
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