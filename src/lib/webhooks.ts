import type { Lead } from './leads';

export async function fireOutboundWebhook(lead: Lead): Promise<void> {
  const url = process.env.OUTBOUND_WEBHOOK_URL;
  if (!url) {
    console.log('[outbound webhook] OUTBOUND_WEBHOOK_URL not configured — skipping');
    return;
  }
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lead, timestamp: new Date().toISOString() }),
    });
    console.log('[outbound webhook] Fired to', url);
  } catch (err) {
    console.error('[outbound webhook] Failed:', err);
  }
}