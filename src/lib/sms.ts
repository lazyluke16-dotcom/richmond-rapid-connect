export interface SmsResult {
  id: string;
  status: 'simulated' | 'sent' | 'failed';
  to: string;
  body: string;
  mode: string;
  twilioSid?: string;
  errorMessage?: string;
}

/**
 * Send an SMS. `businessId` is required to attribute the logged
 * `sms_events` row to the correct tenant; there is no fallback. Callers
 * that don't know the tenant should not use this helper.
 */
export async function sendSms(to: string, body: string, businessId?: string | null): Promise<SmsResult> {
  const mode = process.env.SMS_MODE ?? 'demo';
  const fromNumber = process.env.TWILIO_FROM_NUMBER ?? 'DEMO_NUMBER';

  if (mode === 'twilio') {
    const sid = process.env.TWILIO_ACCOUNT_SID;
    const token = process.env.TWILIO_AUTH_TOKEN;
    if (!sid || !token) {
      console.warn('[SMS] TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN not set — falling back to demo mode');
    } else {
      try {
        const url = `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`;
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            Authorization: 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64'),
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({ To: to, From: fromNumber, Body: body }).toString(),
        });
        const json = (await res.json()) as { sid?: string; status?: string; message?: string };
        const result: SmsResult = {
          id: json.sid ?? crypto.randomUUID(),
          status: res.ok ? 'sent' : 'failed',
          to,
          body,
          mode: 'twilio',
          twilioSid: json.sid,
          errorMessage: res.ok ? undefined : json.message,
        };
        await logSmsEvent({ ...result, fromNumber }, businessId ?? null);
        return result;
      } catch (err) {
        console.error('[SMS] Twilio send failed:', err);
      }
    }
  }

  const result: SmsResult = {
    id: crypto.randomUUID(),
    status: 'simulated',
    to,
    body,
    mode: 'demo',
  };
  await logSmsEvent({ ...result, fromNumber }, businessId ?? null);
  return result;
}

async function logSmsEvent(e: SmsResult & { fromNumber: string }, businessId: string | null) {
  if (!businessId) {
    // Fail-closed: without a tenant we cannot attribute the row, and
    // there is no safe default. Skip the audit row rather than writing
    // it against a wrong tenant.
    console.warn('[SMS] logSmsEvent skipped — no businessId supplied');
    return;
  }
  const { supabaseAdmin } = await import('@/integrations/supabase/client.server');
  await supabaseAdmin.from('sms_events').insert({
    id: e.id,
    to_number: e.to,
    from_number: e.fromNumber,
    body: e.body,
    mode: e.mode,
    status: e.status,
    twilio_sid: e.twilioSid ?? null,
    error_message: e.errorMessage ?? null,
    business_id: businessId,
  } as never);
}