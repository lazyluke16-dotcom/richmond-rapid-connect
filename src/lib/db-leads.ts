import { createServerFn } from '@tanstack/react-start';
import type { Lead } from './leads';
import { fireOutboundWebhook } from './webhooks';
import { sendSms } from './sms';
import { resolveBusinessIdBySlug } from './tenant';
import { requireSupabaseAuth } from '@/integrations/supabase/auth-middleware';

/**
 * Public: called by the unauthenticated customer chat flow. Uses the
 * service-role admin client so the row can be written despite the RLS
 * lockdown, and derives `business_id` on the server — any client-supplied
 * business_id in `data` is ignored.
 */
export const insertLead = createServerFn({ method: 'POST' })
  .inputValidator((data: Lead & { businessSlug?: string }) => data)
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import('@/integrations/supabase/client.server');
    // Server-side tenant resolution. The caller MUST pass an explicit
    // `businessSlug`; there is no default-tenant fallback. Any client-
    // supplied `business_id` on the lead payload is ignored.
    if (!data.businessSlug) {
      throw new Error('insertLead: businessSlug is required');
    }
    const resolved = await resolveBusinessIdBySlug(data.businessSlug);
    if (!resolved) throw new Error(`Unknown business slug: ${data.businessSlug}`);
    const businessId: string = resolved;
    // ATTRIBUTION INTEGRITY: if the client claims a missed-call id,
    // it MUST belong to the same tenant we just resolved. Otherwise drop
    // the attribution rather than silently link across tenants.
    let externalCallId: string | null = data.external_call_id ?? null;
    if (externalCallId) {
      const { data: mc } = await supabaseAdmin
        .from('missed_calls')
        .select('business_id')
        .eq('id', externalCallId)
        .maybeSingle();
      if (!mc || (mc as { business_id: string }).business_id !== businessId) {
        console.warn('[attribution] mcid mismatch — dropping external_call_id', {
          mcid: externalCallId, resolvedBusinessId: businessId,
        });
        externalCallId = null;
      }
    }
    const row = {
      id: data.id,
      created_at: data.createdAt,
      job_type: data.jobType,
      suburb: data.suburb,
      urgency: data.urgency,
      property_type: data.propertyType,
      photos: data.photos,
      name: data.name,
      phone: data.phone,
      best_time: data.bestTime,
      chat: data.chat,
      ai_summary: data.aiSummary,
      lead_score: data.leadScore,
      recommended_action: data.recommendedAction,
      status: data.status,
      source: data.source ?? 'form',
      external_call_id: externalCallId,
      call_recording_url: data.call_recording_url ?? null,
      business_id: businessId, // server-derived, never client-supplied
    };
    const { error } = await supabaseAdmin.from('leads').insert(row as never);
    if (error) throw new Error(error.message);

    await fireOutboundWebhook(data);

    // Plumber alert: read tenant settings and log a tenant-scoped event.
    try {
      const { data: mcs } = await supabaseAdmin
        .from('business_missed_call_settings')
        .select('plumber_alert_enabled, alert_method, alert_phone, alert_email')
        .eq('business_id', businessId)
        .maybeSingle();
      const settings = mcs as {
        plumber_alert_enabled: boolean; alert_method: string;
        alert_phone: string | null; alert_email: string | null;
      } | null;
      if (settings?.plumber_alert_enabled) {
        const urgencyText = data.urgency === 'now' ? '🚨 EMERGENCY' : '📋 New lead';
        const alertBody = `${urgencyText}: ${data.name} — ${data.jobType} in ${data.suburb}. Callback: ${data.bestTime || 'ASAP'}. Score: ${data.leadScore}/100.`;
        const smsMode = process.env.SMS_MODE === 'twilio' ? 'twilio' : 'demo';
        const destination = settings.alert_phone || process.env.DEMO_PLUMBER_PHONE || '';
        const live = smsMode === 'twilio' && settings.alert_method === 'sms' && destination;
        await supabaseAdmin.from('sms_events').insert({
          to_number: destination || 'demo:no-destination',
          from_number: process.env.TWILIO_FROM_NUMBER ?? 'DEMO_NUMBER',
          body: alertBody,
          mode: live ? 'twilio' : 'demo',
          status: live ? 'sent' : 'simulated',
          event_type: 'plumber_alert',
          business_id: businessId,
        } as never);
        if (live) {
          try { await sendSms(destination, alertBody, businessId); }
          catch (e) { console.error('[SMS] Plumber alert failed:', e); }
        }
      }
    } catch (e) {
      console.error('[alert] failed to log plumber alert:', e);
    }

    return { success: true, id: data.id };
  });

/**
 * Authenticated: dashboard-only. Uses the caller's auth-scoped supabase
 * client so RLS enforces `business_id = current_business_id()`. The `id`
 * scoping alone is enough — RLS prevents cross-tenant updates even if a
 * caller guessed a lead id from another business.
 */
export const updateLeadStatus = createServerFn({ method: 'POST' })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { id: string; status: Lead['status'] }) => data)
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from('leads')
      .update({ status: data.status })
      .eq('id', data.id);
    if (error) throw new Error(error.message);
    return { success: true };
  });

/**
 * Authenticated: dashboard-only. RLS filters to the caller's tenant.
 */
export const fetchLeads = createServerFn({ method: 'GET' })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from('leads')
      .select('*')
      .order('created_at', { ascending: false });
    if (error) throw new Error(error.message);
    return (data ?? []) as unknown as Lead[];
  });