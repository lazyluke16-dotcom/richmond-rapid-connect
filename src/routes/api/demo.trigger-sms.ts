import { createFileRoute } from '@tanstack/react-router';
import { resolveBusinessIdBySlug } from '@/lib/tenant';
import { renderSmsTemplate } from '@/lib/missed-call.functions';

/**
 * Exported handler body so route-boundary regression tests can invoke the
 * exact intake code without going through the router. Behaviour identical
 * to the wired POST handler.
 */
export async function handleTriggerSms(request: Request): Promise<Response> {
        const body = (await request.json()) as { callerPhone?: string; businessSlug?: string };
        const callerPhone = (body.callerPhone ?? '').trim();
        if (!callerPhone) {
          return new Response(JSON.stringify({ error: 'callerPhone required' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (!body.businessSlug) {
          return new Response(JSON.stringify({ error: 'businessSlug required' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          });
        }

        const mcid = crypto.randomUUID();
        const baseUrl = process.env.PUBLIC_JOB_REQUEST_URL ?? new URL(request.url).origin;
        const { supabaseAdmin } = await import('@/integrations/supabase/client.server');

        // Resolve tenant server-side from the explicit slug — no default fallback.
        const resolved = await resolveBusinessIdBySlug(body.businessSlug);
        if (!resolved) {
          return new Response(JSON.stringify({ error: 'Unknown business slug' }), {
            status: 404,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        const businessId: string = resolved;
        const slugForLink: string = body.businessSlug;
        let businessName = '';
        let publicPhone: string | null = null;
        const { data: biz } = await supabaseAdmin
          .from('businesses')
          .select('name, slug, public_phone')
          .eq('id', businessId)
          .maybeSingle();
        if (biz) {
          businessName = (biz.name as string) ?? '';
          publicPhone = (biz.public_phone as string) ?? null;
        }
        const jobLink = `${baseUrl}/b/${slugForLink}/request?source=missed_call&mcid=${mcid}`;

        const { data: settings } = await supabaseAdmin
          .from('business_missed_call_settings')
          .select('sms_template')
          .eq('business_id', businessId)
          .maybeSingle();
        const template = (settings?.sms_template as string | undefined) ??
          'Sorry we missed your call to {{business_name}}. Send us the job here: {{recovery_link}}';
        const smsBody = renderSmsTemplate(template, {
          business_name: businessName,
          recovery_link: jobLink,
          public_phone: publicPhone,
        });

        await supabaseAdmin.from('missed_calls').insert({
          id: mcid,
          caller_phone: callerPhone,
          sms_sent: true,
          source: 'demo',
          business_id: businessId,
        } as never);

        await supabaseAdmin.from('sms_events').insert({
          to_number: callerPhone,
          from_number: process.env.TWILIO_FROM_NUMBER ?? 'DEMO_NUMBER',
          body: smsBody,
          mode: 'demo',
          status: 'simulated',
          event_type: 'customer_recovery_sms',
          business_id: businessId,
        } as never);

        return new Response(JSON.stringify({ missedCallId: mcid, smsBody }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
}

export const Route = createFileRoute('/api/demo/trigger-sms')({
  server: {
    handlers: {
      POST: async ({ request }) => handleTriggerSms(request),
    },
  },
});