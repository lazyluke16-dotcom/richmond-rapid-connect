-- Approved Australian customer-facing GST policy.
-- Platform and AI totals include GST. Recovery SMS retains its 25-cent
-- ex-GST ledger amount and is 27.5 cents per accepted message including GST.

INSERT INTO public.billing_config (key, value_numeric, value_text, currency, active, notes)
VALUES
  (
    'missed_call_base_monthly_aud', 9.00, 'inclusive', 'AUD', true,
    'Customer total A$9.00 per month including GST'
  ),
  (
    'ai_receptionist_base_monthly_aud', 15.00, 'inclusive', 'AUD', true,
    'Customer total A$15.00 per month including GST'
  ),
  (
    'ai_voice_per_minute_aud', 0.59, 'inclusive', 'AUD', true,
    'Customer total A$0.59 per minute including GST; metered per second'
  ),
  (
    'ai_voice_per_second_aud', 0.00983333, 'inclusive', 'AUD', true,
    'Inclusive per-second metering rate for the A$0.59 per-minute customer total'
  ),
  (
    'sms_per_message_aud', 0.25, 'exclusive', 'AUD', true,
    'Underlying A$0.25 excluding GST per provider-accepted recovery SMS'
  ),
  (
    'sms_per_message_including_gst_aud', 0.275, 'inclusive', 'AUD', true,
    'Customer unit total A$0.275 including 10% GST per provider-accepted recovery SMS'
  ),
  (
    'australian_gst_rate_percent', 10.00, 'approved', NULL, true,
    'Approved Australian GST rate used by inclusive subscription and exclusive SMS tax policies'
  )
ON CONFLICT (key) DO UPDATE
SET value_numeric = EXCLUDED.value_numeric,
    value_text = EXCLUDED.value_text,
    currency = EXCLUDED.currency,
    active = EXCLUDED.active,
    notes = EXCLUDED.notes,
    updated_at = now();
