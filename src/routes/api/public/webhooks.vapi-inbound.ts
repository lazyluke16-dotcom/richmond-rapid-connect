import { createFileRoute } from '@tanstack/react-router';
import { scoreLead, summariseLead, recommendAction } from '@/lib/leads';
import type { Lead, JobType, Urgency } from '@/lib/leads';
import { fireOutboundWebhook } from '@/lib/webhooks';
import { needsEnrichment, needsLeadEnrichment, normalizeVapiJobType } from '@/lib/enrichment.server';

// A$0.59 / 60 sec. Kept as a fallback if billing_config is unreachable.
const AI_VOICE_FALLBACK_RATE_AUD_PER_SEC = 0.00983333;

/**
 * Best-effort authoritative duration extraction from an end-of-call payload.
 * Prefers explicit numeric fields; falls back to computing from startedAt/endedAt.
 * Returns null when nothing usable is present (caller should then fetch /call/:id).
 */
function extractDurationSeconds(msg: Record<string, unknown>, call: Record<string, unknown>): number | null {
  const num = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
  const secs =
    num((msg as { durationSeconds?: unknown }).durationSeconds) ??
    num((call as { durationSeconds?: unknown }).durationSeconds);
  if (secs !== null) return Math.round(secs);
  const mins =
    num((msg as { durationMinutes?: unknown }).durationMinutes) ??
    num((call as { durationMinutes?: unknown }).durationMinutes);
  if (mins !== null) return Math.round(mins * 60);
  const startedAt = (msg as { startedAt?: string }).startedAt ?? (call as { startedAt?: string }).startedAt;
  const endedAt = (msg as { endedAt?: string }).endedAt ?? (call as { endedAt?: string }).endedAt;
  if (startedAt && endedAt) {
    const ms = new Date(endedAt).getTime() - new Date(startedAt).getTime();
    if (Number.isFinite(ms) && ms > 0) return Math.round(ms / 1000);
  }
  return null;
}

function extractProviderCost(msg: Record<string, unknown>): { amount: number | null; currency: string | null } {
  const cost = (msg as { cost?: unknown }).cost;
  if (typeof cost === 'number' && Number.isFinite(cost)) {
    return { amount: cost, currency: 'USD' }; // Vapi reports in USD
  }
  return { amount: null, currency: null };
}

export const Route = createFileRoute('/api/public/webhooks/vapi-inbound')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        // Validate x-vapi-secret header against VAPI_SERVER_SECRET env var
        // Fail closed: refuse when the secret is unavailable in this runtime.
        const expected = process.env.VAPI_SERVER_SECRET ?? '';
        if (!expected) {
          console.error('[vapi-inbound] VAPI_SERVER_SECRET not configured — refusing request');
          return new Response(JSON.stringify({ error: 'Server misconfigured' }), {
            status: 503,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        const secret = request.headers.get('x-vapi-secret') ?? '';
        if (secret !== expected) {
          return new Response(JSON.stringify({ error: 'Unauthorized' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' },
          });
        }

        const body = (await request.json()) as {
          message?: {
            type?: string;
            endedReason?: string;
            analysis?: {
              structuredData?: Record<string, string | undefined>;
              summary?: string;
            };
            call?: {
              id?: string;
              assistantId?: string;
              customer?: { number?: string };
              recordingUrl?: string;
              phoneNumberId?: string;
              phoneNumber?: { number?: string };
            };
            transcript?: string;
            summary?: string;
            startedAt?: string;
            endedAt?: string;
            durationSeconds?: number;
            cost?: number;
          };
        };

        const msg = body.message;

        // Only process end-of-call reports; silently ignore other Vapi event types
        if (!msg || msg.type !== 'end-of-call-report') {
          return new Response(JSON.stringify({ ok: true, ignored: true }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }

        // Vapi end-of-call-report places analysis at message.analysis, not message.structuredData.
        let sd: Record<string, string | undefined> = { ...(msg.analysis?.structuredData ?? {}) };
        const call = msg.call ?? {};

        // ── EARLY REMOTE ENRICHMENT ────────────────────────────────────────────
        // For webCall type, durationSeconds=0 in the webhook payload. Fetch the
        // authoritative call record once. If analysis.structuredData is already
        // available (rare within seconds of call end) it enriches the lead fields.
        // If not (typical — Vapi analysis takes 90 s+), the enrichment endpoint
        // will be triggered asynchronously after the lead is saved.
        let remoteCall: Record<string, unknown> | null = null;
        const payloadDuration = extractDurationSeconds(
          msg as unknown as Record<string, unknown>,
          call as unknown as Record<string, unknown>,
        );
        const needsRemoteFetch = !sd.customer_name || !sd.suburb || !sd.callback_number || payloadDuration === null || payloadDuration < 1;

        if (needsRemoteFetch && call.id) {
          try {
            const { getVapiCall, vapiCredentialsAvailable } = await import('@/lib/vapi.server');
            if (vapiCredentialsAvailable()) {
              const fetched = await getVapiCall(call.id);
              const remoteSd: Record<string, string | undefined> =
                ((fetched as { analysis?: { structuredData?: Record<string, string | undefined> } })
                  .analysis?.structuredData) ?? {};
              sd = { ...remoteSd, ...sd };
              remoteCall = fetched;
            }
          } catch (e) {
            console.warn('[vapi-inbound] early remote fetch failed:', (e as Error).message);
          }
        }

        // TENANT RESOLUTION — trusted provider identifiers only.
        // Never accept business_id/business_slug supplied in structured data.
        const assistantId = (call as { assistantId?: string }).assistantId
          ?? (msg as unknown as { assistant?: { id?: string } }).assistant?.id
          ?? null;
        const phoneId = (call as { phoneNumberId?: string }).phoneNumberId ?? null;
        const phoneNumber = (call as { phoneNumber?: { number?: string } }).phoneNumber?.number ?? null;

        const { supabaseAdmin } = await import('@/integrations/supabase/client.server');
        const { data: tenantId, error: resolveErr } = await supabaseAdmin
          .rpc('resolve_ai_tenant', {
            _provider: 'vapi',
            _assistant_id: assistantId ?? null,
            _phone_id: phoneId ?? null,
            _phone_number: phoneNumber ?? null,
          } as never);
        if (resolveErr) {
          console.error('[vapi-inbound] tenant resolve error', resolveErr.message);
          return new Response(JSON.stringify({ error: 'Tenant resolution failed' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
        }
        if (!tenantId) {
          console.warn('[vapi-inbound] unknown provider identifiers — rejecting', { assistantId, phoneId, phoneNumber });
          return new Response(JSON.stringify({ error: 'Unknown assistant/phone mapping' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
        }
        const businessId = tenantId as unknown as string;

        const jobType: JobType = normalizeVapiJobType(sd.job_type);
        const urgency = (sd.urgency ?? 'today') as Urgency;

        const lead: Lead = {
          id: `vapi-${crypto.randomUUID()}`,
          createdAt: Date.now(),
          jobType,
          suburb: sd.suburb ?? 'unknown',
          urgency,
          propertyType: 'house',
          photos: [],
          name: sd.customer_name ?? 'Unknown caller',
          phone: sd.callback_number ?? call.customer?.number ?? '',
          bestTime: sd.callback_preference ?? '',
          chat: msg.transcript
            ? [{ role: 'ai', text: msg.transcript, ts: Date.now() }]
            : [],
          aiSummary: '',
          leadScore: 0,
          recommendedAction: '',
          status: 'new',
          source: 'ai_phone_agent',
          external_call_id: call.id,
          call_recording_url: call.recordingUrl ?? undefined,
        };

        lead.aiSummary = sd.ai_summary ?? msg.summary ?? summariseLead(lead);
        lead.leadScore = scoreLead(lead);
        lead.recommendedAction = recommendAction(lead.leadScore, lead.urgency);

        const row = {
          id: lead.id,
          created_at: lead.createdAt,
          job_type: lead.jobType,
          suburb: lead.suburb,
          urgency: lead.urgency,
          property_type: lead.propertyType,
          photos: lead.photos,
          name: lead.name,
          phone: lead.phone,
          best_time: lead.bestTime,
          chat: lead.chat,
          ai_summary: lead.aiSummary,
          lead_score: lead.leadScore,
          recommended_action: lead.recommendedAction,
          status: lead.status,
          source: lead.source,
          external_call_id: lead.external_call_id ?? null,
          call_recording_url: lead.call_recording_url ?? null,
          business_id: businessId,
        };

        const { error } = await supabaseAdmin.from('leads').insert(row as never);
        let leadDeduped = false;
        if (error) {
          // Duplicate call id → idempotent no-op
          if (/duplicate key|leads_source_external_call_uk/i.test(error.message)) {
            leadDeduped = true;
          } else {
            console.error('[vapi-inbound] DB insert failed:', error.message);
            return new Response(JSON.stringify({ error: 'DB error', detail: error.message }), {
              status: 500,
              headers: { 'Content-Type': 'application/json' },
            });
          }
        }

        // ── DURABLE ENRICHMENT JOB ────────────────────────────────────────────
        // Queue an enrichment job when structured data is currently incomplete, OR
        // when the existing persisted lead is still holding webhook-time placeholders.
        //
        // Recovery gap: initial webhook creates lead, job creation fails → 503 → Vapi
        // retries → Vapi analysis is now complete → needsEnrichment(sd)=false → without
        // the DB lead check, no job would be queued and the lead stays permanently
        // incomplete. needsLeadEnrichment(existingLead) closes this gap.
        //
        // Not gated on !leadDeduped: duplicate webhooks must be able to repair a missing
        // job. ON CONFLICT (call_id) ignoreDuplicates prevents double-rows.
        // authoritativeLeadId: the persisted row's ID. Starts as lead.id (new insert path).
        // Overwritten to the existing row's ID when the insert deduped — lead.id was never
        // persisted in that case. Billing metadata and the deduped response must use this
        // value, not lead.id, to avoid reporting a random UUID that does not exist in the DB.
        let authoritativeLeadId = lead.id;
        let shouldQueueEnrichment = Boolean(call.id) && needsEnrichment(sd);
        if (call.id && leadDeduped) {
          // Resolve the persisted lead to:
          //   1. Get the real lead ID (authoritativeLeadId) — lead.id was never persisted.
          //   2. Check DB field completeness for the recovery-gap path.
          const { data: existingLead } = await supabaseAdmin
            .from('leads')
            .select('id, name, phone, suburb, job_type, urgency, best_time')
            .eq('external_call_id', call.id)
            .eq('business_id', businessId)
            .single();
          if (!existingLead?.id) {
            console.error(
              '[vapi-inbound] leadDeduped but no persisted lead found for call',
              call.id,
            );
            return new Response(
              JSON.stringify({
                error: 'Lead resolution failed',
                code: 'LEAD_RESOLVE_FAILED',
              }),
              {
                status: 503,
                headers: { 'Content-Type': 'application/json' },
              },
            );
          }
          const typedLead = existingLead as {
            id: string;
            name: string;
            phone: string | null;
            suburb: string;
            job_type: string;
            urgency: string | null;
            best_time: string | null;
          };
          authoritativeLeadId = typedLead.id;
          if (!shouldQueueEnrichment) {
            shouldQueueEnrichment = needsLeadEnrichment(typedLead);
          }
        }

        if (call.id && shouldQueueEnrichment) {
          try {
            const { error: jobErr } = await supabaseAdmin
              .from('enrichment_jobs')
              .upsert(
                {
                  call_id: call.id,
                  lead_id: authoritativeLeadId,
                  business_id: businessId,
                  status: 'pending',
                  attempt_count: 0,
                  max_attempts: 5,
                  run_after: new Date(Date.now() + 90_000).toISOString(),
                } as never,
                {
                  onConflict: 'call_id',
                  ignoreDuplicates: true,
                },
              );
            if (jobErr) {
              console.error(
                '[vapi-inbound] enrichment job upsert failed:',
                jobErr.message,
              );
              return new Response(
                JSON.stringify({
                  error: 'Enrichment queue unavailable',
                  code: 'ENRICH_QUEUE_FAILED',
                }),
                {
                  status: 503,
                  headers: { 'Content-Type': 'application/json' },
                },
              );
            }
            console.log(
              `[vapi-inbound] enrichment job queued (or already exists) for call ${call.id}`,
            );
          } catch (e) {
            console.error(
              '[vapi-inbound] enrichment job upsert threw:',
              (e as Error).message,
            );
            return new Response(
              JSON.stringify({
                error: 'Enrichment queue error',
                code: 'ENRICH_QUEUE_ERROR',
              }),
              {
                status: 503,
                headers: { 'Content-Type': 'application/json' },
              },
            );
          }
        }

        // ---------- Phase C: authoritative usage ledger ----------
        // Runs even on dedupe so the ledger dedupes independently (idempotent).
        // Phase 2F: billableForMeter and meterIdentifier set inside try; consumed outside.
        let billableForMeter = false;
        let meterIdentifier: string | null = null;

        try {
          if (call.id) {
            let seconds = extractDurationSeconds(
              msg as unknown as Record<string, unknown>,
              call as unknown as Record<string, unknown>,
            );
            let providerCost = extractProviderCost(msg as unknown as Record<string, unknown>);
            const startedAtIso = (msg as { startedAt?: string }).startedAt ?? (call as { startedAt?: string }).startedAt ?? null;
            const endedAtIso = (msg as { endedAt?: string }).endedAt ?? (call as { endedAt?: string }).endedAt ?? null;

            // Reuse the remote call already fetched for lead enrichment; avoids a
            // duplicate Vapi API call. Falls back to a fresh fetch if enrichment did not run.
            if (seconds === null || seconds < 1) {
              try {
                let callRecord = remoteCall;
                if (!callRecord) {
                  const { getVapiCall, vapiCredentialsAvailable } = await import('@/lib/vapi.server');
                  if (vapiCredentialsAvailable()) callRecord = await getVapiCall(call.id as string);
                }
                if (callRecord) {
                  seconds = extractDurationSeconds({}, callRecord);
                  if (providerCost.amount === null) providerCost = extractProviderCost(callRecord);
                }
              } catch (e) {
                console.warn('[vapi-inbound] Vapi /call fetch failed:', (e as Error).message);
              }
            }

            // Never estimate from transcript. If still no duration, record 0
            // seconds and mark non-billable so we don't invent charges.
            const billableSeconds = seconds ?? 0;

            // Retail rate from billing_config (falls back to hardcoded rate).
            const { data: rateRow } = await supabaseAdmin
              .from('billing_config')
              .select('value_numeric')
              .eq('key', 'ai_voice_per_second_aud')
              .maybeSingle();
            const customerRate =
              Number((rateRow as { value_numeric?: number } | null)?.value_numeric ?? AI_VOICE_FALLBACK_RATE_AUD_PER_SEC);

            // Determine billable: authoritative billing state + AI mode.
            const [{ data: stateRow }, { data: aiSettings }] = await Promise.all([
              supabaseAdmin.rpc('effective_billing_state', { _business_id: businessId } as never),
              supabaseAdmin
                .from('business_ai_receptionist_settings')
                .select('mode')
                .eq('business_id', businessId)
                .maybeSingle(),
            ]);
            const effectiveState = (stateRow as unknown as string) ?? 'unknown';
            const aiMode = (aiSettings as { mode?: string } | null)?.mode ?? 'demo';

            let billable = false;
            let nonBillableReason: string | null = null;
            if (billableSeconds < 1) {
              nonBillableReason = 'no_duration';
            } else if (aiMode !== 'live') {
              nonBillableReason = 'demo_mode';
            } else if (effectiveState === 'billing_exempt_test') {
              nonBillableReason = 'billing_exempt_test';
            } else if (effectiveState === 'active' || effectiveState === 'past_due_grace') {
              billable = true;
            } else {
              nonBillableReason = `billing_state:${effectiveState}`;
            }

            const estimatedCharge = billable
              ? Math.round(billableSeconds * customerRate * 10000) / 10000
              : null;

            // Phase 2F: stable identifier used for both ledger and Stripe deduplication.
            const identifier = `vapi_${call.id}`;

            // Insert ledger event. Unique index (provider, usage_type, external_call_id)
            // guarantees at most one row per Vapi call — replayed webhooks are no-ops.
            const { error: ledgerErr } = await supabaseAdmin.from('billing_usage_events').insert({
              business_id: businessId,
              usage_type: 'ai_voice_seconds',
              provider: 'vapi',
              provider_event_id: null,
              external_call_id: call.id,
              quantity: billableSeconds,
              unit: 'seconds',
              started_at: startedAtIso,
              ended_at: endedAtIso,
              billable_seconds: billableSeconds,
              provider_cost_amount: providerCost.amount,
              provider_cost_currency: providerCost.currency,
              customer_rate: billable ? customerRate : null,
              customer_rate_currency: 'AUD',
              estimated_customer_charge: estimatedCharge,
              billable,
              non_billable_reason: nonBillableReason,
              stripe_meter_event_identifier: identifier,
              stripe_meter_event_status: billable ? 'pending' : 'skipped',
              metadata: {
                ended_reason: msg.endedReason ?? null,
                effective_state: effectiveState,
                ai_mode: aiMode,
                lead_id: authoritativeLeadId,
                lead_deduped: leadDeduped,
              },
            } as never);

            if (ledgerErr && !/duplicate key|billing_usage_events_provider_call_uk/i.test(ledgerErr.message)) {
              console.error('[vapi-inbound] usage ledger insert failed:', ledgerErr.message);
            }

            // Phase 2F: track for meter dispatch outside the try block.
            // Only set when the ledger insert succeeded (no error = new row).
            if (billable && effectiveState !== 'billing_exempt_test' && !ledgerErr) {
              billableForMeter = true;
              meterIdentifier = identifier;

              // Grace cap enforcement: suspend immediately if A$10 reached mid-grace.
              if (effectiveState === 'past_due_grace') {
                try {
                  const { data: bbRow } = await supabaseAdmin
                    .from('business_billing')
                    .select('grace_started_at')
                    .eq('business_id', businessId)
                    .maybeSingle();
                  const graceStart = (bbRow as { grace_started_at?: string | null } | null)?.grace_started_at;
                  if (graceStart) {
                    const { checkGraceUsageCap, suspendBusiness } = await import('@/lib/billing.server');
                    const cap = await checkGraceUsageCap(businessId, new Date(graceStart), supabaseAdmin);
                    if (cap.shouldSuspend) {
                      await suspendBusiness(businessId, supabaseAdmin);
                      console.log(`[vapi-inbound] grace cap A$${cap.currentUsageAud.toFixed(2)} >= A$10 — suspended: ${businessId}`);
                    }
                  }
                } catch (graceErr) {
                  console.warn('[vapi-inbound] grace cap check failed (non-fatal):', (graceErr as Error).message);
                }
              }
            }
          }
        } catch (e) {
          // Ledger failures must never bring down the webhook — lead is already saved.
          console.error('[vapi-inbound] usage ledger error:', (e as Error).message);
        }

        // Phase 2F: dispatch Stripe billing meter event immediately after ledger insert.
        // Non-fatal — failures are logged and the event is queued for retry.
        if (billableForMeter && meterIdentifier) {
          try {
            const { data: bbRow } = await supabaseAdmin
              .from('business_billing')
              .select('stripe_customer_id')
              .eq('business_id', businessId)
              .maybeSingle();
            const stripeCustomerId = (bbRow as { stripe_customer_id?: string | null } | null)?.stripe_customer_id;
            if (stripeCustomerId) {
              const { submitMeterEventByIdentifier } = await import('@/lib/billing-meter.server');
              const result = await submitMeterEventByIdentifier(businessId, meterIdentifier, stripeCustomerId, supabaseAdmin);
              if (!result.success && !result.skipped) {
                console.warn('[vapi-inbound] meter event queued for retry:', result.error);
              }
            }
          } catch (meterErr) {
            console.warn('[vapi-inbound] meter dispatch error (non-fatal):', (meterErr as Error).message);
          }
        }

        if (leadDeduped) {
          return new Response(JSON.stringify({ ok: true, deduped: true, lead_id: authoritativeLeadId }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }

        // AI-call notification (tenant-scoped)
        try {
          await supabaseAdmin.from('sms_events').insert({
            to_number: 'demo:no-destination',
            from_number: 'AI_PHONE',
            body: `AI phone call captured for ${lead.name} — ${lead.jobType} in ${lead.suburb} (${lead.urgency}).`,
            mode: 'demo',
            status: 'simulated',
            event_type: 'ai_call_notification',
            business_id: businessId,
          } as never);
        } catch (e) { console.warn('[vapi-inbound] notify failed', e); }

        await fireOutboundWebhook(lead);

        return new Response(JSON.stringify({ success: true, lead_id: lead.id }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        });
      },
    },
  },
});