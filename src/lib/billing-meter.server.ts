// Stripe Billing Meter event submission and idempotent retry.
// Uses the authoritative billing_usage_events ledger as the source of truth.
// The unique identifier per Vapi call guarantees exactly-once metering within
// the safe retry window. Beyond that window, events are flagged for reconciliation.
import type { SupabaseClient } from '@supabase/supabase-js';
import { getStripe, STRIPE_METER_EVENT_NAME } from './stripe.server';

// Stripe deduplicates meter events by identifier within this window.
// Events older than this MUST NOT be blindly resent — Stripe may have rotated the
// deduplication cache, creating a risk of double-charging the customer.
// Flag such events for manual reconciliation instead.
export const SAFE_METER_RETRY_HOURS = 22;

export interface MeterEventInput {
  usageEventId: string;           // billing_usage_events.id (for ledger update)
  stripeCustomerId: string;        // Stripe customer to charge
  billableSeconds: number;         // integer seconds — never rounded to minutes
  identifier: string;              // e.g. `vapi_${callId}` — Stripe dedup key
  callTimestamp?: Date;            // used as meter event timestamp when provided
  attemptCount?: number;           // current attempt count from ledger (to be incremented)
}

export async function submitMeterEvent(
  input: MeterEventInput,
  supabaseAdmin: SupabaseClient,
): Promise<{ success: boolean; error?: string }> {
  const stripe = getStripe();
  const seconds = Math.round(input.billableSeconds); // enforce integer — never minutes
  const newAttemptCount = (input.attemptCount ?? 0) + 1;
  const now = new Date().toISOString();

  try {
    await stripe.billing.meterEvents.create({
      event_name: STRIPE_METER_EVENT_NAME,
      payload: {
        stripe_customer_id: input.stripeCustomerId,
        value: String(seconds),
      },
      identifier: input.identifier,
      timestamp: input.callTimestamp
        ? Math.floor(input.callTimestamp.getTime() / 1000)
        : Math.floor(Date.now() / 1000),
    });

    await supabaseAdmin
      .from('billing_usage_events')
      .update({
        stripe_meter_event_status: 'sent',
        stripe_meter_event_sent_at: now,
        stripe_meter_event_error: null,
        stripe_meter_event_attempt_count: newAttemptCount,
        stripe_meter_event_last_attempt_at: now,
      })
      .eq('id', input.usageEventId);

    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await supabaseAdmin
      .from('billing_usage_events')
      .update({
        stripe_meter_event_status: 'failed',
        stripe_meter_event_error: message.slice(0, 500),
        stripe_meter_event_attempt_count: newAttemptCount,
        stripe_meter_event_last_attempt_at: now,
      })
      .eq('id', input.usageEventId);

    return { success: false, error: message };
  }
}

// Submit a meter event from a ledger row identified by its Stripe meter identifier.
// Used by the Vapi webhook immediately after ledger insert.
export async function submitMeterEventByIdentifier(
  businessId: string,
  identifier: string,
  stripeCustomerId: string,
  supabaseAdmin: SupabaseClient,
): Promise<{ success: boolean; error?: string; skipped?: boolean }> {
  const { data: row } = await supabaseAdmin
    .from('billing_usage_events')
    .select('id, billable_seconds, ended_at, stripe_meter_event_status, stripe_meter_event_attempt_count, created_at')
    .eq('business_id', businessId)
    .eq('stripe_meter_event_identifier', identifier)
    .maybeSingle();

  if (!row) return { success: false, error: 'Ledger row not found', skipped: true };

  const ledger = row as {
    id: string;
    billable_seconds?: number | null;
    ended_at?: string | null;
    stripe_meter_event_status?: string | null;
    stripe_meter_event_attempt_count?: number | null;
    created_at?: string | null;
  };

  // Already sent — idempotent skip
  if (ledger.stripe_meter_event_status === 'sent') {
    return { success: true, skipped: true };
  }

  // Check safe retry window even on first submission (in case of delayed webhook delivery)
  const safeWindowCutoff = new Date(Date.now() - SAFE_METER_RETRY_HOURS * 60 * 60 * 1000);
  const createdAt = ledger.created_at ? new Date(ledger.created_at) : new Date();
  if (createdAt < safeWindowCutoff) {
    await supabaseAdmin
      .from('billing_usage_events')
      .update({ stripe_meter_event_status: 'reconciliation_needed' })
      .eq('id', ledger.id);
    return { success: false, error: 'Event too old for safe retry — flagged for reconciliation', skipped: true };
  }

  return submitMeterEvent(
    {
      usageEventId: ledger.id,
      stripeCustomerId,
      billableSeconds: ledger.billable_seconds ?? 0,
      identifier,
      callTimestamp: ledger.ended_at ? new Date(ledger.ended_at) : undefined,
      attemptCount: ledger.stripe_meter_event_attempt_count ?? 0,
    },
    supabaseAdmin,
  );
}

// Retry all pending/failed meter events for a single business.
// Events older than SAFE_METER_RETRY_HOURS are flagged for reconciliation, not retried.
// Structured for hourly scheduled execution via runHourlyMeterRetry().
export async function retryPendingMeterEvents(
  businessId: string,
  supabaseAdmin: SupabaseClient,
): Promise<{ retried: number; succeeded: number; failed: number; flagged: number }> {
  const { data: billingRow } = await supabaseAdmin
    .from('business_billing')
    .select('stripe_customer_id')
    .eq('business_id', businessId)
    .maybeSingle();

  const customerId = (billingRow as { stripe_customer_id?: string | null } | null)?.stripe_customer_id;
  if (!customerId) return { retried: 0, succeeded: 0, failed: 0, flagged: 0 };

  const safeWindowCutoff = new Date(Date.now() - SAFE_METER_RETRY_HOURS * 60 * 60 * 1000);

  const { data: pending } = await supabaseAdmin
    .from('billing_usage_events')
    .select('id, billable_seconds, stripe_meter_event_identifier, ended_at, created_at, stripe_meter_event_attempt_count')
    .eq('business_id', businessId)
    .in('stripe_meter_event_status', ['pending', 'failed'])
    .eq('billable', true)
    .order('created_at', { ascending: true })
    .limit(100);

  if (!pending?.length) return { retried: 0, succeeded: 0, failed: 0, flagged: 0 };

  let succeeded = 0;
  let failed = 0;
  let flagged = 0;

  for (const row of pending as {
    id: string;
    billable_seconds?: number | null;
    stripe_meter_event_identifier?: string | null;
    ended_at?: string | null;
    created_at?: string | null;
    stripe_meter_event_attempt_count?: number | null;
  }[]) {
    if (!row.stripe_meter_event_identifier) { failed++; continue; }

    // Events older than the safe retry window must not be resent.
    // Stripe may no longer deduplicate by identifier, risking double charges.
    const createdAt = row.created_at ? new Date(row.created_at) : new Date(0);
    if (createdAt < safeWindowCutoff) {
      await supabaseAdmin
        .from('billing_usage_events')
        .update({ stripe_meter_event_status: 'reconciliation_needed' })
        .eq('id', row.id);
      flagged++;
      console.warn(
        `[billing-meter] event ${row.id} (${row.stripe_meter_event_identifier}) is older than ${SAFE_METER_RETRY_HOURS}h — flagged for reconciliation`,
      );
      continue;
    }

    const result = await submitMeterEvent(
      {
        usageEventId: row.id,
        stripeCustomerId: customerId,
        billableSeconds: row.billable_seconds ?? 0,
        identifier: row.stripe_meter_event_identifier,
        callTimestamp: row.ended_at ? new Date(row.ended_at) : undefined,
        attemptCount: row.stripe_meter_event_attempt_count ?? 0,
      },
      supabaseAdmin,
    );

    if (result.success) succeeded++; else failed++;
  }

  return { retried: pending.length - flagged, succeeded, failed, flagged };
}
