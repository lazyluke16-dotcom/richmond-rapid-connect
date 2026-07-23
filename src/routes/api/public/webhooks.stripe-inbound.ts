// Public Stripe webhook endpoint — no auth header, verified by Stripe signature.
// Fail closed: any signature failure returns 400 and does not process the event.
import { createFileRoute } from '@tanstack/react-router';
import type Stripe from 'stripe';
import { getStripe } from '@/lib/stripe.server';
import {
  setGracePeriod,
  clearGraceAndActivate,
  suspendBusiness,
} from '@/lib/billing.server';

function jsonOk(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function getBusinessIdFromSubscription(
  subscriptionId: string,
  supabaseAdmin: typeof import('@/integrations/supabase/client.server').supabaseAdmin,
): Promise<string | null> {
  const { data } = await supabaseAdmin
    .from('business_billing')
    .select('business_id')
    .eq('stripe_subscription_id', subscriptionId)
    .maybeSingle();
  return (data as { business_id?: string } | null)?.business_id ?? null;
}

async function getBusinessIdFromCustomer(
  customerId: string,
  supabaseAdmin: typeof import('@/integrations/supabase/client.server').supabaseAdmin,
): Promise<string | null> {
  const { data } = await supabaseAdmin
    .from('business_billing')
    .select('business_id')
    .eq('stripe_customer_id', customerId)
    .maybeSingle();
  return (data as { business_id?: string } | null)?.business_id ?? null;
}

export const Route = createFileRoute('/api/public/webhooks/stripe-inbound')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET ?? '';
        if (!webhookSecret) {
          console.error('[stripe-inbound] STRIPE_WEBHOOK_SECRET not configured');
          return jsonOk({ error: 'Server misconfigured' }, 503);
        }

        const rawBody = await request.text();
        const sig = request.headers.get('stripe-signature') ?? '';

        const stripe = getStripe();
        let event: Stripe.Event;
        try {
          event = await stripe.webhooks.constructEventAsync(rawBody, sig, webhookSecret);
        } catch (err) {
          console.warn('[stripe-inbound] signature verification failed:', (err as Error).message);
          return new Response(JSON.stringify({ error: 'Invalid Stripe signature' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          });
        }

        const { supabaseAdmin } = await import('@/integrations/supabase/client.server');

        const { error: insertErr } = await supabaseAdmin
          .from('stripe_webhook_events')
          .insert({
            stripe_event_id: event.id,
            event_type: event.type,
            status: 'received',
            metadata: { livemode: event.livemode },
          });

        if (insertErr) {
          if (/unique|stripe_event_id/i.test(insertErr.message)) {
            return jsonOk({ ok: true, duplicate: true });
          }
          console.error('[stripe-inbound] receipt insert failed:', insertErr.message);
          // Never mutate billing state when the durable idempotency receipt
          // could not be stored. Stripe will retry this event.
          return jsonOk({ error: 'Could not persist webhook receipt' }, 500);
        }

        let handled = false;
        let businessId: string | null = null;

        try {
          switch (event.type) {
            case 'checkout.session.completed': {
              const session = event.data.object as Stripe.Checkout.Session;
              businessId = (session.metadata?.business_id) ?? null;
              const subscriptionId = typeof session.subscription === 'string' ? session.subscription : session.subscription?.id ?? null;
              const customerId = typeof session.customer === 'string' ? session.customer : session.customer?.id ?? null;
              const plan = session.metadata?.plan ?? null;

              if (!businessId || !subscriptionId) {
                console.warn('[stripe-inbound] checkout.session.completed missing metadata', { businessId, subscriptionId });
                break;
              }

              const sub = await stripe.subscriptions.retrieve(subscriptionId);

              const { error: activationError } = await supabaseAdmin
                .from('business_billing')
                .update({
                  billing_status: 'active',
                  stripe_customer_id: customerId,
                  stripe_subscription_id: subscriptionId,
                  stripe_subscription_status: sub.status,
                  selected_plan: plan,
                  billing_cycle_anchor: sub.billing_cycle_anchor
                    ? new Date(sub.billing_cycle_anchor * 1000).toISOString()
                    : null,
                  current_period_start: new Date((sub as unknown as { billing_cycle_anchor: number }).billing_cycle_anchor * 1000).toISOString(),
                  current_period_end: (() => {
                    const anchor = new Date((sub as unknown as { billing_cycle_anchor: number }).billing_cycle_anchor * 1000);
                    const end = new Date(anchor);
                    const item = sub.items.data[0];
                    const interval = (item?.price as unknown as { recurring?: { interval?: string; interval_count?: number } } | null)?.recurring?.interval ?? 'month';
                    const count = (item?.price as unknown as { recurring?: { interval?: string; interval_count?: number } } | null)?.recurring?.interval_count ?? 1;
                    if (interval === 'month') end.setMonth(end.getMonth() + count);
                    else if (interval === 'year') end.setFullYear(end.getFullYear() + count);
                    else if (interval === 'week') end.setDate(end.getDate() + 7 * count);
                    else end.setDate(end.getDate() + count);
                    return end.toISOString();
                  })(),
                  grace_started_at: null,
                  grace_expires_at: null,
                  suspended_at: null,
                  last_synced_at: new Date().toISOString(),
                })
                .eq('business_id', businessId);
              if (activationError) {
                throw new Error(`Failed to activate paid subscription: ${activationError.message}`);
              }

              const { data: billingRow } = await supabaseAdmin
                .from('business_billing')
                .select('union_offer_eligible, union_offer_redeemed_at')
                .eq('business_id', businessId)
                .maybeSingle();

              const bb = billingRow as {
                union_offer_eligible?: boolean;
                union_offer_redeemed_at?: string | null;
              } | null;

              if (bb?.union_offer_eligible && !bb?.union_offer_redeemed_at) {
                const { error: offerError } = await supabaseAdmin
                  .from('business_billing')
                  .update({
                    union_offer_redeemed_at: new Date().toISOString(),
                    platform_fee_waiver_ends_at: new Date(
                      (() => { const anchor = new Date((sub as unknown as { billing_cycle_anchor: number }).billing_cycle_anchor * 1000); const end = new Date(anchor); end.setMonth(end.getMonth() + 1); return end.getTime(); })()
                    ).toISOString(),
                  })
                  .eq('business_id', businessId);
                if (offerError) {
                  throw new Error(`Failed to record union offer redemption: ${offerError.message}`);
                }
              }

              handled = true;
              break;
            }

            case 'customer.subscription.created':
            case 'customer.subscription.updated': {
              const sub = event.data.object as Stripe.Subscription & {
                billing_cycle_anchor: number;
              };
              businessId = (sub.metadata?.business_id) ?? null;
              if (!businessId) {
                const cid = typeof sub.customer === 'string' ? sub.customer : sub.customer.id;
                businessId = await getBusinessIdFromCustomer(cid, supabaseAdmin as unknown as typeof import('@/integrations/supabase/client.server').supabaseAdmin);
              }
              if (!businessId) break;

              const { error: subscriptionUpdateError } = await supabaseAdmin
                .from('business_billing')
                .update({
                  stripe_subscription_status: sub.status,
                  current_period_start: new Date(sub.billing_cycle_anchor * 1000).toISOString(),
                  current_period_end: (() => {
                    const anchor = new Date(sub.billing_cycle_anchor * 1000);
                    const end = new Date(anchor);
                    const item = sub.items.data[0];
                    const interval = (item?.price as unknown as { recurring?: { interval?: string; interval_count?: number } } | null)?.recurring?.interval ?? 'month';
                    const count = (item?.price as unknown as { recurring?: { interval?: string; interval_count?: number } } | null)?.recurring?.interval_count ?? 1;
                    if (interval === 'month') end.setMonth(end.getMonth() + count);
                    else if (interval === 'year') end.setFullYear(end.getFullYear() + count);
                    else if (interval === 'week') end.setDate(end.getDate() + 7 * count);
                    else end.setDate(end.getDate() + count);
                    return end.toISOString();
                  })(),
                  billing_cycle_anchor: sub.billing_cycle_anchor
                    ? new Date(sub.billing_cycle_anchor * 1000).toISOString()
                    : null,
                  last_synced_at: new Date().toISOString(),
                })
                .eq('business_id', businessId);
              if (subscriptionUpdateError) {
                throw new Error(`Failed to update subscription: ${subscriptionUpdateError.message}`);
              }

              handled = true;
              break;
            }

            case 'customer.subscription.deleted': {
              const sub = event.data.object as Stripe.Subscription;
              businessId = (sub.metadata?.business_id) ?? null;
              if (!businessId) {
                const cid = typeof sub.customer === 'string' ? sub.customer : sub.customer.id;
                businessId = await getBusinessIdFromCustomer(cid, supabaseAdmin as unknown as typeof import('@/integrations/supabase/client.server').supabaseAdmin);
              }
              if (!businessId) break;

              const { error: cancellationError } = await supabaseAdmin
                .from('business_billing')
                .update({
                  billing_status: 'canceled',
                  stripe_subscription_status: sub.status,
                  canceled_at: new Date().toISOString(),
                  last_synced_at: new Date().toISOString(),
                })
                .eq('business_id', businessId);
              if (cancellationError) {
                throw new Error(`Failed to record cancellation: ${cancellationError.message}`);
              }

              handled = true;
              break;
            }

            case 'invoice.payment_succeeded': {
              const invoice = event.data.object as Stripe.Invoice;
              const subId = typeof invoice.subscription === 'string'
                ? invoice.subscription
                : (invoice.subscription as Stripe.Subscription | null)?.id ?? null;
              if (!subId) break;

              businessId = await getBusinessIdFromSubscription(subId, supabaseAdmin as unknown as typeof import('@/integrations/supabase/client.server').supabaseAdmin);
              if (!businessId) break;

              await clearGraceAndActivate(businessId, supabaseAdmin);
              try { await (supabaseAdmin.rpc as unknown as (fn: string, args: unknown) => Promise<unknown>)('increment_invoice_count', { _business_id: businessId }); } catch { /* optional RPC */ }
              const { error: syncError } = await supabaseAdmin
                .from('business_billing')
                .update({ last_synced_at: new Date().toISOString() })
                .eq('business_id', businessId);
              if (syncError) throw new Error(`Failed to record payment recovery: ${syncError.message}`);

              try {
                const { retryPendingMeterEvents } = await import('@/lib/billing-meter.server');
                const result = await retryPendingMeterEvents(businessId, supabaseAdmin);
                if (result.retried > 0) {
                  console.log(`[stripe-inbound] meter retry: ${result.succeeded}/${result.retried} succeeded`);
                }
              } catch (e) {
                console.warn('[stripe-inbound] meter retry failed:', (e as Error).message);
              }

              handled = true;
              break;
            }

            case 'invoice.payment_failed': {
              const invoice = event.data.object as Stripe.Invoice;
              const subId = typeof invoice.subscription === 'string'
                ? invoice.subscription
                : (invoice.subscription as Stripe.Subscription | null)?.id ?? null;
              if (!subId) break;

              businessId = await getBusinessIdFromSubscription(subId, supabaseAdmin as unknown as typeof import('@/integrations/supabase/client.server').supabaseAdmin);
              if (!businessId) break;

              await setGracePeriod(businessId, supabaseAdmin);

              const { data: bbRow } = await supabaseAdmin
                .from('business_billing')
                .select('grace_started_at')
                .eq('business_id', businessId)
                .maybeSingle();
              const graceStart = (bbRow as { grace_started_at?: string | null } | null)?.grace_started_at;

              if (graceStart) {
                const { checkGraceUsageCap } = await import('@/lib/billing.server');
                const cap = await checkGraceUsageCap(businessId, new Date(graceStart), supabaseAdmin);
                if (cap.shouldSuspend) {
                  await suspendBusiness(businessId, supabaseAdmin);
                }
              }

              handled = true;
              break;
            }

            case 'invoice.finalized': {
              handled = true;
              break;
            }

            default:
              handled = false;
          }

          const { error: receiptUpdateError } = await supabaseAdmin
            .from('stripe_webhook_events')
            .update({
              status: handled ? 'processed' : 'ignored',
              processed_at: new Date().toISOString(),
              business_id: businessId,
            })
            .eq('stripe_event_id', event.id);
          if (receiptUpdateError) {
            throw new Error(`Failed to finalize webhook receipt: ${receiptUpdateError.message}`);
          }

          return jsonOk({ ok: true, handled, eventType: event.type });
        } catch (err) {
          const message = (err as Error).message ?? 'Unknown error';
          console.error('[stripe-inbound] processing error:', event.type, message);

          await supabaseAdmin
            .from('stripe_webhook_events')
            .update({
              status: 'failed',
              error_message: message.slice(0, 500),
              processed_at: new Date().toISOString(),
              business_id: businessId,
            })
            .eq('stripe_event_id', event.id);

          return jsonOk({ error: 'Processing error', message }, 500);
        }
      },
    },
  },
});
