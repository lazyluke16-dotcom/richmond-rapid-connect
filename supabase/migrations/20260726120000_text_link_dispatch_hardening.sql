-- Durable Text Link dispatch state machine.
--
-- The provider event is the aggregate root. Claims and terminal persistence
-- are performed by SECURITY DEFINER functions so concurrent serverless
-- invocations cannot both send, stale work can be recovered, and a Twilio SID
-- discovered by reconciliation is preserved without sending again.

ALTER TABLE public.telephony_provider_events
  ADD COLUMN IF NOT EXISTS claim_token uuid,
  ADD COLUMN IF NOT EXISTS claim_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS send_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS provider_attempted_at timestamptz,
  ADD COLUMN IF NOT EXISTS provider_message_sid text,
  ADD COLUMN IF NOT EXISTS provider_status text,
  ADD COLUMN IF NOT EXISTS to_number text,
  ADD COLUMN IF NOT EXISTS from_number text,
  ADD COLUMN IF NOT EXISTS sms_body text,
  ADD COLUMN IF NOT EXISTS sms_body_hash text,
  ADD COLUMN IF NOT EXISTS attempt_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_reconciled_at timestamptz,
  ADD COLUMN IF NOT EXISTS failure_kind text,
  ADD COLUMN IF NOT EXISTS usage_recorded_at timestamptz;

ALTER TABLE public.telephony_provider_events
  DROP CONSTRAINT IF EXISTS telephony_provider_events_status_check;

UPDATE public.telephony_provider_events event_row
SET provider_message_sid = sms.twilio_sid,
    provider_status = sms.status
FROM public.sms_events sms
WHERE sms.id = event_row.sms_event_id
  AND sms.business_id = event_row.business_id
  AND event_row.provider_message_sid IS NULL
  AND sms.twilio_sid IS NOT NULL;

UPDATE public.telephony_provider_events
SET status = CASE status
  WHEN 'processing' THEN 'claimed'
  WHEN 'processed' THEN 'sent'
  ELSE status
END
WHERE status IN ('processing', 'processed');

ALTER TABLE public.telephony_provider_events
  ADD CONSTRAINT telephony_provider_events_status_check
    CHECK (status IN ('claimed','sending','reconciling','sent','failed','ignored')),
  DROP CONSTRAINT IF EXISTS telephony_provider_events_failure_kind_check,
  ADD CONSTRAINT telephony_provider_events_failure_kind_check
    CHECK (failure_kind IS NULL OR failure_kind IN ('pre_send','provider_rejected')),
  DROP CONSTRAINT IF EXISTS telephony_provider_events_attempt_count_check,
  ADD CONSTRAINT telephony_provider_events_attempt_count_check
    CHECK (attempt_count >= 0);

CREATE INDEX IF NOT EXISTS telephony_provider_events_stale_claim_idx
  ON public.telephony_provider_events (claim_expires_at)
  WHERE status IN ('claimed','sending','reconciling');

CREATE OR REPLACE FUNCTION public.claim_text_link_dispatch(
  _provider text,
  _provider_event_id text,
  _business_id uuid,
  _missed_call_id text,
  _caller_phone text,
  _lease_seconds integer DEFAULT 30
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  event_row public.telephony_provider_events%ROWTYPE;
  new_token uuid := gen_random_uuid();
  lease_seconds integer := greatest(5, least(coalesce(_lease_seconds, 30), 300));
BEGIN
  -- Insert-first closes the nonexistent-row locking gap: concurrent callers
  -- race on the unique event key, exactly one wins, and the loser then locks
  -- and observes the winner's durable state.
  INSERT INTO public.telephony_provider_events (
    provider, event_type, provider_event_id, business_id, status, workflow,
    missed_call_id, sms_event_id, claim_token, claim_expires_at
  ) VALUES (
    _provider, 'inbound_call', _provider_event_id, _business_id, 'claimed', 'text_link',
    _missed_call_id, gen_random_uuid()::text, new_token,
    now() + make_interval(secs => lease_seconds)
  )
  ON CONFLICT (provider, event_type, provider_event_id) DO NOTHING
  RETURNING * INTO event_row;

  IF FOUND THEN
    INSERT INTO public.missed_calls (
      id, caller_phone, sms_sent, source, business_id
    ) VALUES (
      _missed_call_id, _caller_phone, false,
      _provider || ':' || _provider_event_id, _business_id
    );

    RETURN jsonb_build_object(
      'action', 'send',
      'status', event_row.status,
      'claimToken', event_row.claim_token,
      'missedCallId', event_row.missed_call_id,
      'smsEventId', event_row.sms_event_id,
      'providerMessageSid', event_row.provider_message_sid,
      'sendStartedAt', event_row.send_started_at,
      'toNumber', event_row.to_number,
      'fromNumber', event_row.from_number,
      'smsBody', event_row.sms_body
    );
  END IF;

  SELECT * INTO event_row
  FROM public.telephony_provider_events
  WHERE provider = _provider
    AND event_type = 'inbound_call'
    AND provider_event_id = _provider_event_id
  FOR UPDATE;

  IF event_row.business_id <> _business_id THEN
    RAISE EXCEPTION 'Provider event belongs to another tenant' USING ERRCODE = '42501';
  END IF;

  IF event_row.workflow <> 'text_link' THEN
    RAISE EXCEPTION 'Provider event belongs to another workflow' USING ERRCODE = '23514';
  END IF;

  IF event_row.status = 'sent' THEN
    RETURN jsonb_build_object(
      'action', 'sent',
      'status', event_row.status,
      'claimToken', NULL,
      'missedCallId', event_row.missed_call_id,
      'smsEventId', event_row.sms_event_id,
      'providerMessageSid', event_row.provider_message_sid,
      'sendStartedAt', event_row.send_started_at,
      'toNumber', event_row.to_number,
      'fromNumber', event_row.from_number,
      'smsBody', event_row.sms_body
    );
  END IF;

  IF event_row.status = 'failed' AND event_row.failure_kind = 'provider_rejected' THEN
    RETURN jsonb_build_object(
      'action', 'failed',
      'status', event_row.status,
      'claimToken', NULL,
      'missedCallId', event_row.missed_call_id,
      'smsEventId', event_row.sms_event_id,
      'providerMessageSid', event_row.provider_message_sid,
      'sendStartedAt', event_row.send_started_at,
      'toNumber', event_row.to_number,
      'fromNumber', event_row.from_number,
      'smsBody', event_row.sms_body
    );
  END IF;

  IF event_row.claim_expires_at IS NOT NULL
    AND event_row.claim_expires_at > now()
    AND (
      event_row.status IN ('claimed','sending','reconciling')
      OR (event_row.status = 'failed' AND event_row.failure_kind = 'pre_send')
    ) THEN
    RETURN jsonb_build_object(
      'action', 'busy',
      'status', event_row.status,
      'claimToken', NULL,
      'missedCallId', event_row.missed_call_id,
      'smsEventId', event_row.sms_event_id,
      'providerMessageSid', event_row.provider_message_sid,
      'sendStartedAt', event_row.send_started_at,
      'toNumber', event_row.to_number,
      'fromNumber', event_row.from_number,
      'smsBody', event_row.sms_body
    );
  END IF;

  IF event_row.status IN ('sending','reconciling')
    OR (
      event_row.provider_attempted_at IS NOT NULL
      AND event_row.provider_message_sid IS NULL
      AND event_row.failure_kind IS DISTINCT FROM 'provider_rejected'
    ) THEN
    UPDATE public.telephony_provider_events
    SET status = 'reconciling',
        claim_token = new_token,
        claim_expires_at = now() + make_interval(secs => lease_seconds),
        error_message = NULL
    WHERE id = event_row.id
    RETURNING * INTO event_row;

    RETURN jsonb_build_object(
      'action', 'reconcile',
      'status', event_row.status,
      'claimToken', event_row.claim_token,
      'missedCallId', event_row.missed_call_id,
      'smsEventId', event_row.sms_event_id,
      'providerMessageSid', event_row.provider_message_sid,
      'sendStartedAt', event_row.send_started_at,
      'toNumber', event_row.to_number,
      'fromNumber', event_row.from_number,
      'smsBody', event_row.sms_body
    );
  END IF;

  -- A stale never-attempted claim, or a retryable pre-send failure, is safe to
  -- reclaim because no provider request has started.
  UPDATE public.telephony_provider_events
  SET status = 'claimed',
      claim_token = new_token,
      claim_expires_at = now() + make_interval(secs => lease_seconds),
      failure_kind = NULL,
      error_message = NULL
  WHERE id = event_row.id
  RETURNING * INTO event_row;

  RETURN jsonb_build_object(
    'action', 'send',
    'status', event_row.status,
    'claimToken', event_row.claim_token,
    'missedCallId', event_row.missed_call_id,
    'smsEventId', event_row.sms_event_id,
    'providerMessageSid', event_row.provider_message_sid,
    'sendStartedAt', event_row.send_started_at,
    'toNumber', event_row.to_number,
    'fromNumber', event_row.from_number,
    'smsBody', event_row.sms_body
  );
END
$$;

CREATE OR REPLACE FUNCTION public.begin_text_link_send(
  _provider text,
  _provider_event_id text,
  _claim_token uuid,
  _to_number text,
  _from_number text,
  _sms_body text,
  _sms_body_hash text,
  _lease_seconds integer DEFAULT 30
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  changed integer;
  lease_seconds integer := greatest(5, least(coalesce(_lease_seconds, 30), 300));
BEGIN
  UPDATE public.telephony_provider_events
  SET status = 'sending',
      to_number = _to_number,
      from_number = _from_number,
      sms_body = _sms_body,
      sms_body_hash = _sms_body_hash,
      send_started_at = now(),
      provider_attempted_at = now(),
      attempt_count = attempt_count + 1,
      claim_expires_at = now() + make_interval(secs => lease_seconds),
      failure_kind = NULL,
      error_message = NULL
  WHERE provider = _provider
    AND event_type = 'inbound_call'
    AND provider_event_id = _provider_event_id
    AND claim_token = _claim_token
    AND status = 'claimed'
    AND claim_expires_at > now();
  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN changed = 1;
END
$$;

CREATE OR REPLACE FUNCTION public.mark_text_link_reconciling(
  _provider text,
  _provider_event_id text,
  _claim_token uuid,
  _error_message text,
  _lease_seconds integer DEFAULT 60
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  changed integer;
  lease_seconds integer := greatest(15, least(coalesce(_lease_seconds, 60), 600));
BEGIN
  UPDATE public.telephony_provider_events
  SET status = 'reconciling',
      error_message = left(coalesce(_error_message, 'provider_outcome_uncertain'), 500),
      claim_expires_at = now() + make_interval(secs => lease_seconds)
  WHERE provider = _provider
    AND event_type = 'inbound_call'
    AND provider_event_id = _provider_event_id
    AND claim_token = _claim_token
    AND status = 'sending';
  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN changed = 1;
END
$$;

CREATE OR REPLACE FUNCTION public.retry_text_link_after_reconciliation(
  _provider text,
  _provider_event_id text,
  _claim_token uuid,
  _lease_seconds integer DEFAULT 30
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  changed integer;
  lease_seconds integer := greatest(5, least(coalesce(_lease_seconds, 30), 300));
BEGIN
  UPDATE public.telephony_provider_events
  SET status = 'claimed',
      provider_attempted_at = NULL,
      send_started_at = NULL,
      last_reconciled_at = now(),
      claim_expires_at = now() + make_interval(secs => lease_seconds),
      error_message = NULL
  WHERE provider = _provider
    AND event_type = 'inbound_call'
    AND provider_event_id = _provider_event_id
    AND claim_token = _claim_token
    AND status = 'reconciling';
  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN changed = 1;
END
$$;

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

  INSERT INTO public.billing_usage_events (
    business_id, usage_type, provider, provider_event_id, external_call_id,
    quantity, unit, billable, non_billable_reason,
    stripe_meter_event_status, metadata
  ) VALUES (
    event_row.business_id, 'outbound_sms', 'twilio', _provider_message_sid,
    event_row.provider_event_id, 1, 'message', false,
    'sms_retail_pricing_unapproved', 'skipped',
    jsonb_build_object(
      'sms_event_id', event_row.sms_event_id,
      'workflow', 'text_link'
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

CREATE OR REPLACE FUNCTION public.fail_text_link_dispatch(
  _provider text,
  _provider_event_id text,
  _claim_token uuid,
  _failure_kind text,
  _error_message text,
  _provider_message_sid text,
  _provider_status text,
  _to_number text,
  _from_number text,
  _sms_body text
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  event_row public.telephony_provider_events%ROWTYPE;
BEGIN
  IF _failure_kind NOT IN ('pre_send','provider_rejected') THEN
    RAISE EXCEPTION 'Invalid Text Link failure kind' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO event_row
  FROM public.telephony_provider_events
  WHERE provider = _provider
    AND event_type = 'inbound_call'
    AND provider_event_id = _provider_event_id
  FOR UPDATE;

  IF NOT FOUND OR event_row.claim_token IS DISTINCT FROM _claim_token THEN
    RETURN false;
  END IF;

  INSERT INTO public.sms_events (
    id, to_number, from_number, body, mode, status, twilio_sid,
    error_message, business_id, event_type
  ) VALUES (
    event_row.sms_event_id, _to_number, _from_number, _sms_body,
    'twilio', 'failed', _provider_message_sid, left(_error_message, 500),
    event_row.business_id, 'customer_recovery_sms'
  )
  ON CONFLICT (id) DO UPDATE
  SET status = 'failed',
      error_message = EXCLUDED.error_message,
      twilio_sid = coalesce(public.sms_events.twilio_sid, EXCLUDED.twilio_sid)
  WHERE public.sms_events.business_id = EXCLUDED.business_id
    AND public.sms_events.twilio_sid IS NULL;

  UPDATE public.telephony_provider_events
  SET status = 'failed',
      failure_kind = _failure_kind,
      error_message = left(_error_message, 500),
      provider_message_sid = coalesce(provider_message_sid, _provider_message_sid),
      provider_status = coalesce(_provider_status, provider_status),
      to_number = coalesce(to_number, _to_number),
      from_number = coalesce(from_number, _from_number),
      sms_body = coalesce(sms_body, _sms_body),
      claim_expires_at = CASE
        WHEN _failure_kind = 'pre_send' THEN now() + interval '5 seconds'
        ELSE NULL
      END,
      claim_token = CASE
        WHEN _failure_kind = 'pre_send' THEN claim_token
        ELSE NULL
      END
  WHERE id = event_row.id;
  RETURN true;
END
$$;

REVOKE EXECUTE ON FUNCTION public.claim_text_link_dispatch(text,text,uuid,text,text,integer)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.begin_text_link_send(text,text,uuid,text,text,text,text,integer)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.mark_text_link_reconciling(text,text,uuid,text,integer)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.retry_text_link_after_reconciliation(text,text,uuid,integer)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.complete_text_link_dispatch(text,text,uuid,text,text)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fail_text_link_dispatch(text,text,uuid,text,text,text,text,text,text,text)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.claim_text_link_dispatch(text,text,uuid,text,text,integer)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.begin_text_link_send(text,text,uuid,text,text,text,text,integer)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.mark_text_link_reconciling(text,text,uuid,text,integer)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.retry_text_link_after_reconciliation(text,text,uuid,integer)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_text_link_dispatch(text,text,uuid,text,text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.fail_text_link_dispatch(text,text,uuid,text,text,text,text,text,text,text)
  TO service_role;
