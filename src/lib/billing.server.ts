// Server-side billing state helpers — grace periods, suspension, usage alerts.
// Never import from client-side code.
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  GRACE_PERIOD_HOURS,
  GRACE_USAGE_CAP_AUD,
  USAGE_ALERT_THRESHOLDS_AUD,
  type UsageAlertThreshold,
} from './billing-types';

// ─── Auth helpers ───────────────────────────────────────────────────────────

// Extract Bearer token from Authorization header. Returns null if absent/invalid.
export function extractBearerToken(request: Request): string | null {
  const header = request.headers.get('authorization') ?? '';
  if (!header.startsWith('Bearer ')) return null;
  const token = header.slice(7).trim();
  return token || null;
}

// Verify token with supabaseAdmin and return user + businessId.
// Throws a Response-compatible error on auth failure.
export async function requireAuthAndBusiness(
  token: string,
  supabaseAdmin: SupabaseClient,
): Promise<{ userId: string; businessId: string }> {
  const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !user) {
    throw Object.assign(new Error('Unauthorized'), { status: 401 });
  }

  const { data: biz, error: bizErr } = await supabaseAdmin
    .from('businesses')
    .select('id')
    .eq('owner_user_id', user.id)
    .eq('active', true)
    .maybeSingle();

  if (bizErr || !biz) {
    throw Object.assign(new Error('No active business found'), { status: 404 });
  }

  return { userId: user.id, businessId: (biz as { id: string }).id };
}

// ─── Grace period ────────────────────────────────────────────────────────────

export async function setGracePeriod(
  businessId: string,
  supabaseAdmin: SupabaseClient,
): Promise<void> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + GRACE_PERIOD_HOURS * 60 * 60 * 1000);

  // Preserve the original grace_started_at if the business is already in past_due.
  // Stripe retries a failed payment 3–4 times; each retry fires invoice.payment_failed.
  // Resetting grace_started_at on each retry would give indefinitely extended grace.
  const { data: existing } = await supabaseAdmin
    .from('business_billing')
    .select('grace_started_at')
    .eq('business_id', businessId)
    .maybeSingle();

  const existingGraceStart = (existing as { grace_started_at?: string | null } | null)?.grace_started_at;

  const updatePayload: Record<string, unknown> = {
    billing_status: 'past_due',
    grace_started_at: existingGraceStart ?? now.toISOString(),
  };

  if (!existingGraceStart) {
    // Only set expiry on the first failure — don't reset the 48h window on retries
    updatePayload.grace_expires_at = expiresAt.toISOString();
  }

  await supabaseAdmin
    .from('business_billing')
    .update(updatePayload)
    .eq('business_id', businessId);
}

export async function clearGraceAndActivate(
  businessId: string,
  supabaseAdmin: SupabaseClient,
): Promise<void> {
  await supabaseAdmin
    .from('business_billing')
    .update({
      billing_status: 'active',
      grace_started_at: null,
      grace_expires_at: null,
      suspended_at: null,
    })
    .eq('business_id', businessId);
}

export async function suspendBusiness(
  businessId: string,
  supabaseAdmin: SupabaseClient,
): Promise<void> {
  await supabaseAdmin
    .from('business_billing')
    .update({
      billing_status: 'suspended',
      suspended_at: new Date().toISOString(),
    })
    .eq('business_id', businessId);
}

// ─── Grace cap ──────────────────────────────────────────────────────────────

export interface GraceCapStatus {
  withinCap: boolean;
  currentUsageAud: number;
  shouldSuspend: boolean;
}

export async function checkGraceUsageCap(
  businessId: string,
  graceStartedAt: Date,
  supabaseAdmin: SupabaseClient,
): Promise<GraceCapStatus> {
  const { data } = await supabaseAdmin
    .from('billing_usage_events')
    .select('estimated_customer_charge')
    .eq('business_id', businessId)
    .eq('billable', true)
    .gte('created_at', graceStartedAt.toISOString());

  const total = ((data ?? []) as { estimated_customer_charge?: number | null }[]).reduce(
    (sum, r) => sum + (Number(r.estimated_customer_charge) || 0),
    0,
  );

  // Suspend at >= A$10.00. A$9.99 is allowed; A$10.00 and above suspends.
  return {
    withinCap: total < GRACE_USAGE_CAP_AUD,
    currentUsageAud: total,
    shouldSuspend: total >= GRACE_USAGE_CAP_AUD,
  };
}

// ─── Usage aggregation ───────────────────────────────────────────────────────

export interface PeriodUsage {
  totalAud: number;
  totalCents: number;
  billableSeconds: number;
  pendingMeterEvents: number;
}

export async function getCurrentPeriodUsage(
  businessId: string,
  periodStart: Date | null,
  supabaseAdmin: SupabaseClient,
): Promise<PeriodUsage> {
  let query = supabaseAdmin
    .from('billing_usage_events')
    .select('estimated_customer_charge, billable_seconds, stripe_meter_event_status')
    .eq('business_id', businessId)
    .eq('billable', true);

  if (periodStart) {
    query = query.gte('created_at', periodStart.toISOString());
  }

  const { data } = await query;
  const rows = (data ?? []) as {
    estimated_customer_charge?: number | null;
    billable_seconds?: number | null;
    stripe_meter_event_status?: string | null;
  }[];

  const totalAud = rows.reduce((s, r) => s + (Number(r.estimated_customer_charge) || 0), 0);
  const totalSeconds = rows.reduce((s, r) => s + (Number(r.billable_seconds) || 0), 0);
  const pendingCount = rows.filter(
    (r) => r.stripe_meter_event_status === 'pending' || r.stripe_meter_event_status === 'failed',
  ).length;

  return {
    totalAud,
    totalCents: Math.round(totalAud * 100),
    billableSeconds: totalSeconds,
    pendingMeterEvents: pendingCount,
  };
}

// ─── Usage alert thresholds ──────────────────────────────────────────────────

export function computeAlertThresholds(totalAud: number) {
  return USAGE_ALERT_THRESHOLDS_AUD.map((threshold) => ({
    threshold: threshold as UsageAlertThreshold,
    exceeded: totalAud >= threshold,
  }));
}

// Check whether a threshold alert should be sent this period.
// Returns thresholds not yet notified that have been exceeded.
export async function getUnsentAlerts(
  businessId: string,
  periodStart: Date,
  totalAud: number,
  supabaseAdmin: SupabaseClient,
): Promise<UsageAlertThreshold[]> {
  const exceeded = USAGE_ALERT_THRESHOLDS_AUD.filter((t) => totalAud >= t);
  if (!exceeded.length) return [];

  const { data: sent } = await supabaseAdmin
    .from('billing_usage_alerts_sent')
    .select('threshold_aud')
    .eq('business_id', businessId)
    .eq('period_start', periodStart.toISOString())
    .in('threshold_aud', exceeded);

  const sentSet = new Set(((sent ?? []) as { threshold_aud: number }[]).map((r) => r.threshold_aud));
  return exceeded.filter((t) => !sentSet.has(t)) as UsageAlertThreshold[];
}

export async function recordAlertSent(
  businessId: string,
  periodStart: Date,
  thresholdAud: UsageAlertThreshold,
  supabaseAdmin: SupabaseClient,
): Promise<void> {
  await supabaseAdmin.from('billing_usage_alerts_sent').insert({
    business_id: businessId,
    period_start: periodStart.toISOString(),
    threshold_aud: thresholdAud,
  });
}
