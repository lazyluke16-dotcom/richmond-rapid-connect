import { createFileRoute } from '@tanstack/react-router';
import { scoreLead, summariseLead, recommendAction } from '@/lib/leads';
import type { Lead, JobType, Urgency, PropertyType } from '@/lib/leads';
import { fireOutboundWebhook } from '@/lib/webhooks';

async function sha256Hex(input: string): Promise<string> {
  const enc = new TextEncoder().encode(input);
  const buf = await crypto.subtle.digest('SHA-256', enc);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Exported handler body for route-boundary regression tests.
 */
export async function handleAiPhoneLead(request: Request): Promise<Response> {
        // Fail closed: if WEBHOOK_SECRET is not available in this runtime
        // we refuse the request rather than silently accepting it.
        const expected = process.env.WEBHOOK_SECRET ?? '';
        if (!expected) {
          console.error('[webhook/ai-phone-lead] WEBHOOK_SECRET not configured — refusing request');
          return new Response(JSON.stringify({ error: 'Server misconfigured' }), {
            status: 503,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        const secret = request.headers.get('x-webhook-secret') ?? '';
        if (secret !== expected) {
          return new Response(JSON.stringify({ error: 'Unauthorized' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' },
          });
        }

        const body = (await request.json()) as {
          customer_name?: string;
          customer_phone?: string;
          suburb?: string;
          job_type?: string;
          urgency?: string;
          callback_preference?: string;
          transcript?: string;
          call_summary?: string;
          ai_summary?: string;
          recommended_action?: string;
          call_recording_url?: string;
          source?: string;
          external_call_id?: string;
          // Trusted per-tenant integration token OR provider identifiers.
          integration_token?: string;
          provider_assistant_id?: string;
          provider_phone_id?: string;
          provider_phone_number?: string;
          provider?: string;
        };

        // TENANT RESOLUTION — trusted server-side lookup only.
        // Client-supplied business_id / business_slug are ignored by design.
        const { supabaseAdmin } = await import('@/integrations/supabase/client.server');
        let businessId: string | null = null;
        if (body.integration_token) {
          const tokenHash = await sha256Hex(body.integration_token);
          const { data: m } = await supabaseAdmin.from('ai_provider_mappings')
            .select('business_id').eq('integration_token_hash', tokenHash).eq('active', true).maybeSingle();
          businessId = (m as { business_id: string } | null)?.business_id ?? null;
        }
        if (!businessId) {
          const { data: tenantId } = await supabaseAdmin.rpc('resolve_ai_tenant', {
            _provider: body.provider ?? 'vapi',
            _assistant_id: body.provider_assistant_id ?? null,
            _phone_id: body.provider_phone_id ?? null,
            _phone_number: body.provider_phone_number ?? null,
          } as never);
          businessId = (tenantId as unknown as string) ?? null;
        }
        if (!businessId) {
          console.warn('[ai-phone-lead] no trusted tenant mapping — rejecting');
          return new Response(JSON.stringify({ error: 'Unknown tenant mapping' }), {
            status: 404, headers: { 'Content-Type': 'application/json' },
          });
        }

        const jobType = (body.job_type ?? 'other') as JobType;
        const urgency = (body.urgency ?? 'today') as Urgency;
        const propertyType: PropertyType = 'house';

        const lead: Lead = {
          id: `ai-${crypto.randomUUID()}`,
          createdAt: Date.now(),
          jobType,
          suburb: body.suburb ?? '',
          urgency,
          propertyType,
          photos: [],
          name: body.customer_name ?? 'Unknown caller',
          phone: body.customer_phone ?? '',
          bestTime: body.callback_preference ?? '',
          chat: body.transcript
            ? [{ role: 'ai', text: body.transcript, ts: Date.now() }]
            : [],
          aiSummary: '',
          leadScore: 0,
          recommendedAction: '',
          status: 'new',
          source: 'ai_phone_agent',
          external_call_id: body.external_call_id,
          call_recording_url: body.call_recording_url,
        };

        lead.aiSummary = body.ai_summary ?? body.call_summary ?? summariseLead(lead);
        lead.leadScore = scoreLead(lead);
        lead.recommendedAction = body.recommended_action ?? recommendAction(lead.leadScore, lead.urgency);

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
        if (error) {
          if (/duplicate key|leads_source_external_call_uk/i.test(error.message)) {
            return new Response(JSON.stringify({ ok: true, deduped: true, lead_id: lead.id }), { status: 200, headers: { 'Content-Type': 'application/json' } });
          }
          console.error('[webhook] DB insert failed:', error.message);
          return new Response(JSON.stringify({ error: 'DB error', detail: error.message }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
          });
        }

        await fireOutboundWebhook(lead);

        return new Response(JSON.stringify({ success: true, lead_id: lead.id }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        });
}

export const Route = createFileRoute('/api/webhooks/ai-phone-lead')({
  server: {
    handlers: {
      POST: async ({ request }) => handleAiPhoneLead(request),
    },
  },
});