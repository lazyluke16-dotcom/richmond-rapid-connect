import { createFileRoute } from '@tanstack/react-router';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  processJob,
  retryDelaySec,
  ENRICHMENT_BATCH_LIMIT,
  type EnrichmentJob,
  type CurrentLeadValues,
  type ProcessJobDeps,
} from '@/lib/enrichment.server';

export const Route = createFileRoute('/api/public/process-enrichment-jobs')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { supabaseAdmin } = await import('@/integrations/supabase/client.server');
        const db = supabaseAdmin as unknown as SupabaseClient;

        // Auth: x-processor-key validated against vault-stored secret.
        // get_processor_key() is SECURITY DEFINER; callable by service_role only.
        // Route is under /api/public/* for external reachability from Supabase pg_net.
        // "public" means externally reachable — NOT unauthenticated. 401 on bad/missing key.
        const { data: expectedKey, error: keyErr } = await db.rpc('get_processor_key');
        if (keyErr || !expectedKey) {
          console.error('[enrichment-processor] vault key unavailable:', keyErr?.message);
          return new Response(JSON.stringify({ error: 'Processor key unavailable' }), { status: 503 });
        }
        if (request.headers.get('x-processor-key') !== expectedKey) {
          return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
        }

        // Atomic claim: FOR UPDATE SKIP LOCKED + stale lease recovery in one RPC call.
        // Eliminates the SELECT-then-UPDATE race that could double-process a job.
        const { data: jobs, error: claimErr } = await db.rpc('claim_enrichment_jobs', {
          _limit: ENRICHMENT_BATCH_LIMIT,
          _lease_seconds: 300,
        });

        if (claimErr) {
          console.error('[enrichment-processor] job claim failed:', claimErr.message);
          return new Response(JSON.stringify({ error: 'Job claim failed' }), { status: 500 });
        }

        if (!jobs || (jobs as unknown[]).length === 0) {
          return new Response(JSON.stringify({ ok: true, processed: 0, results: [] }), { status: 200 });
        }

        const { getVapiCall, vapiCredentialsAvailable } = await import('@/lib/vapi.server');

        const results: { job_id: string; outcome: string; error?: string; fields?: string[] }[] = [];

        for (const job of jobs as EnrichmentJob[]) {
          const deps: ProcessJobDeps = {
            getVapiCall: async (id: string) => {
              if (!vapiCredentialsAvailable()) throw new Error('vapi_credentials_unavailable');
              return getVapiCall(id);
            },
            getLead: async (leadId: string) => {
              const { data, error } = await db
                .from('leads')
                .select('id, business_id, name, phone, suburb, job_type, urgency, best_time, ai_summary, external_call_id')
                .eq('id', leadId)
                .single();
              if (error || !data) return null;
              return data as CurrentLeadValues;
            },
            updateLead: async (leadId: string, businessId: string, updates: Record<string, unknown>) => {
              const { error } = await db
                .from('leads')
                .update(updates as never)
                .eq('id', leadId)
                .eq('business_id', businessId);
              return { error: error?.message ?? null };
            },
            markCompleted: async (jobId: string) => {
              const { error } = await db
                .from('enrichment_jobs')
                .update({
                  status: 'completed',
                  error_message: null,
                  processing_started_at: null,
                  updated_at: new Date().toISOString(),
                })
                .eq('id', jobId);
              if (error) throw new Error(`markCompleted: ${error.message}`);
            },
            markFailed: async (jobId: string, reason: string) => {
              const { error } = await db
                .from('enrichment_jobs')
                .update({
                  status: 'failed',
                  error_message: reason,
                  processing_started_at: null,
                  updated_at: new Date().toISOString(),
                })
                .eq('id', jobId);
              if (error) throw new Error(`markFailed: ${error.message}`);
            },
            scheduleRetry: async (jobId: string, attempt: number, reason: string) => {
              const delaySec = retryDelaySec(attempt);
              const runAfter = new Date(Date.now() + delaySec * 1000).toISOString();
              const { error } = await db
                .from('enrichment_jobs')
                .update({
                  status: 'pending',
                  attempt_count: attempt + 1,
                  run_after: runAfter,
                  error_message: reason,
                  processing_started_at: null,
                  updated_at: new Date().toISOString(),
                })
                .eq('id', jobId);
              if (error) throw new Error(`scheduleRetry: ${error.message}`);
            },
          };

          try {
            const result = await processJob(job, deps);
            results.push({
              job_id: job.id,
              outcome: result.outcome,
              error: result.error,
              fields: result.fields,
            });
            if (result.outcome === 'completed') {
              console.log(
                `[enrichment-processor] completed lead ${job.lead_id} from call ${job.call_id}:`,
                result.fields ?? [],
              );
            }
          } catch (e) {
            console.error(
              '[enrichment-processor] unexpected error for job',
              job.id,
              ':',
              (e as Error).message,
            );
            try {
              if (job.attempt_count + 1 >= job.max_attempts) {
                await deps.markFailed(job.id, 'unexpected_processor_error_max_attempts');
                results.push({
                  job_id: job.id,
                  outcome: 'failed',
                  error: 'unexpected_processor_error_max_attempts',
                });
              } else {
                await deps.scheduleRetry(job.id, job.attempt_count, 'unexpected_processor_error');
                results.push({
                  job_id: job.id,
                  outcome: 'retry_scheduled',
                  error: 'unexpected_processor_error',
                });
              }
            } catch (stateErr) {
              console.error(
                '[enrichment-processor] state transition failed for job',
                job.id,
                ':',
                (stateErr as Error).message,
              );
              results.push({
                job_id: job.id,
                outcome: 'failed',
                error: 'state_transition_failed',
              });
            }
          }
        }

        return new Response(
          JSON.stringify({ ok: true, processed: results.length, results }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        );
      },
    },
  },
});