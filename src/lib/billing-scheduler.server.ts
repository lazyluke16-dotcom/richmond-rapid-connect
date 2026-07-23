// Standalone scheduler functions for hourly cron execution.
// These functions are pure server-side utilities — they have no side effects
// beyond database writes and Stripe meter events.
//
// DEPLOYMENT GATE: Do not register these as live scheduled jobs until
// explicitly authorised by Lucas. They are implemented here as callable
// functions so they can be validated, tested, and invoked manually first.
import type { SupabaseClient } from '@supabase/supabase-js';

export interface GraceExpiryResult {
  checked: number;
  suspended: number;
  errors: number;
}

// Find all businesses in past_due state whose grace period has expired and suspend them.
// Suitable for hourly cron execution.
// A business is suspended if: billing_status = 'past_due' AND grace_expires_at <= now().
export async function runGraceExpiryCheck(
  supabaseAdmin: SupabaseClient,
): Promise<GraceExpiryResult> {
  const now = new Date().toISOString();

  const { data: expiredRows, error } = await supabaseAdmin
    .from('business_billing')
    .select('business_id')
    .eq('billing_status', 'past_due')
    .lte('grace_expires_at', now)
    .not('grace_expires_at', 'is', null);

  if (error) {
    console.error('[billing-scheduler] grace expiry query failed:', error.message);
    return { checked: 0, suspended: 0, errors: 1 };
  }

  const rows = (expiredRows ?? []) as { business_id: string }[];
  if (!rows.length) return { checked: 0, suspended: 0, errors: 0 };

  const { suspendBusiness } = await import('./billing.server');
  let suspended = 0;
  let errors = 0;

  for (const row of rows) {
    try {
      await suspendBusiness(row.business_id, supabaseAdmin);
      suspended++;
      console.log(`[billing-scheduler] grace expired — suspended: ${row.business_id}`);
    } catch (e) {
      console.error(`[billing-scheduler] suspend failed for ${row.business_id}:`, (e as Error).message);
      errors++;
    }
  }

  return { checked: rows.length, suspended, errors };
}

export interface HourlyMeterRetryResult {
  businessesChecked: number;
  totalRetried: number;
  totalSucceeded: number;
  totalFailed: number;
  totalFlagged: number;
}

// Retry all pending/failed Stripe meter events across every business.
// Events older than the safe retry window (22h) are flagged for reconciliation, not resent.
// Suitable for hourly cron execution. Does not duplicate work already done in the
// invoice.payment_succeeded webhook — that webhook only retries for the specific
// business whose payment just succeeded. This function catches the rest (e.g. events
// that never got a customer ID, or whose payment recovery came via a different path).
export async function runHourlyMeterRetry(
  supabaseAdmin: SupabaseClient,
): Promise<HourlyMeterRetryResult> {
  // Find all businesses that have pending or failed meter events
  const { data: eventRows, error } = await supabaseAdmin
    .from('billing_usage_events')
    .select('business_id')
    .in('stripe_meter_event_status', ['pending', 'failed'])
    .eq('billable', true)
    .limit(500);

  if (error) {
    console.error('[billing-scheduler] meter retry discovery failed:', error.message);
    return { businessesChecked: 0, totalRetried: 0, totalSucceeded: 0, totalFailed: 0, totalFlagged: 0 };
  }

  // Deduplicate business IDs — one retry call per business
  const businessIds = [...new Set(((eventRows ?? []) as { business_id: string }[]).map((r) => r.business_id))];

  if (!businessIds.length) {
    return { businessesChecked: 0, totalRetried: 0, totalSucceeded: 0, totalFailed: 0, totalFlagged: 0 };
  }

  const { retryPendingMeterEvents } = await import('./billing-meter.server');
  let totalRetried = 0;
  let totalSucceeded = 0;
  let totalFailed = 0;
  let totalFlagged = 0;

  for (const businessId of businessIds) {
    try {
      const result = await retryPendingMeterEvents(businessId, supabaseAdmin);
      totalRetried += result.retried;
      totalSucceeded += result.succeeded;
      totalFailed += result.failed;
      totalFlagged += result.flagged;
    } catch (e) {
      console.error(`[billing-scheduler] meter retry error for ${businessId}:`, (e as Error).message);
    }
  }

  return {
    businessesChecked: businessIds.length,
    totalRetried,
    totalSucceeded,
    totalFailed,
    totalFlagged,
  };
}
