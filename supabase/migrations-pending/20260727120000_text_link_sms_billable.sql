-- Text Link SMS pricing policy:
--   A$0.25 excluding GST for each outbound recovery SMS accepted by Twilio.
-- The tax/invoice layer applies GST. This migration records no Stripe meter
-- event and does not perform customer billing.

ALTER TABLE public.billing_usage_events
  ADD COLUMN IF NOT EXISTS customer_rate_minor integer
    CHECK (customer_rate_minor IS NULL OR customer_rate_minor >= 0),
  ADD COLUMN IF NOT EXISTS estimated_customer_charge_minor integer
    CHECK (
      estimated_customer_charge_minor IS NULL
      OR estimated_customer_charge_minor >= 0
    );

COMMENT ON COLUMN public.billing_usage_events.customer_rate_minor IS
  'Per-unit customer rate in the minor unit of customer_rate_currency.';
COMMENT ON COLUMN public.billing_usage_events.estimated_customer_charge_minor IS
  'Base customer charge in integer minor currency units, excluding tax.';

-- Keep the required business identity and recovery link while making the
-- standard GSM-7 template suitable for one segment with normal tenant values.
ALTER TABLE public.business_missed_call_settings
  ALTER COLUMN sms_template SET DEFAULT
    '{{business_name}} missed your call. Tell us what you need: {{recovery_link}}';

UPDATE public.business_missed_call_settings
SET sms_template =
  '{{business_name}} missed your call. Tell us what you need: {{recovery_link}}'
WHERE sms_template =
  'Hi, sorry we missed your call to {{business_name}}. Tell us what you need here and we''ll get back to you as soon as possible: {{recovery_link}}';

CREATE OR REPLACE FUNCTION public.complete_text_link_dispatch(
  _provider text,
  _provider_event_id text,
  _claim_token uuid,
  _provider_message_sid text,
  _provider_status text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  event_row public.telephony_provider_events%ROWTYPE;
  usage_was_inserted boolean := false;
  inserted_count integer;
BEGIN
  SELECT * INTO event_row
  FROM public.telephony_provider_events
  WHERE provider = _provider
    AND event_type = 'inbound_call'
    AND provider_event_id = _provider_event_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Provider event not found' USING ERRCODE = 'P0002';
  END IF;
  IF event_row.status = 'sent' THEN
    RETURN jsonb_build_object(
      'smsEventId', event_row.sms_event_id,
      'missedCallId', event_row.missed_call_id,
      'usageInserted', false,
      'providerMessageSid', event_row.provider_message_sid
    );
  END IF;
  IF event_row.claim_token IS DISTINCT FROM _claim_token
    OR event_row.status NOT IN ('sending','reconciling') THEN
    RAISE EXCEPTION 'Text Link dispatch claim is no longer owned' USING ERRCODE = '40001';
  END IF;
  IF coalesce(_provider_message_sid, '') = '' THEN
    RAISE EXCEPTION 'Provider message SID is required' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.sms_events (
    id, to_number, from_number, body, mode, status, twilio_sid,
    error_message, business_id, event_type
  ) VALUES (
    event_row.sms_event_id, event_row.to_number, event_row.from_number,
    event_row.sms_body, 'twilio', 'sent', _provider_message_sid,
    NULL, event_row.business_id, 'customer_recovery_sms'
  )
  ON CONFLICT (id) DO NOTHING;

  IF NOT EXISTS (
    SELECT 1 FROM public.sms_events
    WHERE id = event_row.sms_event_id
      AND business_id = event_row.business_id
  ) THEN
    RAISE EXCEPTION 'SMS event identity belongs to another tenant' USING ERRCODE = '42501';
  END IF;

  UPDATE public.sms_events
  SET status = 'sent',
      twilio_sid = coalesce(twilio_sid, _provider_message_sid),
      error_message = NULL
  WHERE id = event_row.sms_event_id
    AND business_id = event_row.business_id;

  UPDATE public.missed_calls
  SET sms_sent = true,
      sms_event_id = event_row.sms_event_id
  WHERE id = event_row.missed_call_id
    AND business_id = event_row.business_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Missed call identity belongs to another tenant' USING ERRCODE = '42501';
  END IF;

  -- The insert is in the same transaction as the provider-event completion.
  -- The unique provider-event identity makes duplicate completions no-ops.
  INSERT INTO public.billing_usage_events (
    business_id, usage_type, provider, provider_event_id, external_call_id,
    quantity, unit,
    customer_rate, customer_rate_minor, customer_rate_currency,
    estimated_customer_charge, estimated_customer_charge_minor,
    billable, non_billable_reason,
    stripe_meter_event_status, metadata
  ) VALUES (
    event_row.business_id, 'outbound_sms', 'twilio', _provider_message_sid,
    event_row.provider || ':' || event_row.provider_event_id,
    1, 'message',
    0.25, 25, 'AUD',
    0.25, 25,
    true, NULL,
    'skipped',
    jsonb_build_object(
      'sms_event_id', event_row.sms_event_id,
      'telephony_provider_event_id', event_row.id,
      'inbound_provider', event_row.provider,
      'inbound_provider_event_id', event_row.provider_event_id,
      'provider_message_sid', _provider_message_sid,
      'provider_status_at_acceptance', _provider_status,
      'workflow', 'text_link',
      'pricing_policy', 'text_link_sms_aud_25_ex_gst',
      'tax_behavior', 'exclusive',
      'billing_collection', 'invoice_aggregation'
    )
  )
  ON CONFLICT (provider, usage_type, external_call_id)
    WHERE external_call_id IS NOT NULL
  DO NOTHING;
  GET DIAGNOSTICS inserted_count = ROW_COUNT;
  usage_was_inserted := inserted_count = 1;

  UPDATE public.telephony_provider_events
  SET status = 'sent',
      provider_message_sid = coalesce(provider_message_sid, _provider_message_sid),
      provider_status = _provider_status,
      usage_recorded_at = coalesce(usage_recorded_at, now()),
      last_reconciled_at = CASE
        WHEN status = 'reconciling' THEN now()
        ELSE last_reconciled_at
      END,
      claim_token = NULL,
      claim_expires_at = NULL,
      failure_kind = NULL,
      error_message = NULL
  WHERE id = event_row.id
  RETURNING * INTO event_row;

  RETURN jsonb_build_object(
    'smsEventId', event_row.sms_event_id,
    'missedCallId', event_row.missed_call_id,
    'usageInserted', usage_was_inserted,
    'providerMessageSid', event_row.provider_message_sid
  );
END
$$;

-- Preserve the existing major-unit response while summing integer minor units
-- whenever available. This allows exact addition of repeated 25-cent events.
CREATE OR REPLACE FUNCTION public.get_my_billing_detail()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_business_id uuid;
  v_billing_row jsonb;
  v_usage_minor bigint;
  v_usage_secs integer;
  v_pending integer;
  v_eff_state text;
BEGIN
  SELECT id INTO v_business_id
  FROM public.businesses
  WHERE owner_user_id = auth.uid() AND active = true
  LIMIT 1;

  IF v_business_id IS NULL THEN
    RETURN jsonb_build_object('error', 'no_business');
  END IF;

  SELECT to_jsonb(bb) INTO v_billing_row
  FROM public.business_billing bb
  WHERE bb.business_id = v_business_id;

  SELECT
    COALESCE(
      SUM(
        COALESCE(
          estimated_customer_charge_minor,
          round(coalesce(estimated_customer_charge, 0) * 100)::bigint
        )
      ),
      0
    ),
    COALESCE(SUM(billable_seconds), 0),
    COUNT(*) FILTER (WHERE stripe_meter_event_status IN ('pending', 'failed'))
  INTO v_usage_minor, v_usage_secs, v_pending
  FROM public.billing_usage_events
  WHERE business_id = v_business_id
    AND billable = true
    AND (
      (v_billing_row->>'current_period_start') IS NULL
      OR created_at >= (v_billing_row->>'current_period_start')::timestamptz
    );

  v_eff_state := public.effective_billing_state(v_business_id);

  RETURN jsonb_build_object(
    'business_id', v_business_id,
    'billing', v_billing_row,
    'effective_state', v_eff_state,
    'usage_aud', v_usage_minor / 100.0,
    'usage_minor', v_usage_minor,
    'usage_currency', 'AUD',
    'usage_seconds', v_usage_secs,
    'pending_meter_events', v_pending
  );
END;
$$;

