
-- ── billing_usage_alerts_sent ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.billing_usage_alerts_sent (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id   uuid        NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  period_start  timestamptz NOT NULL,
  threshold_aud numeric     NOT NULL,
  sent_at       timestamptz NOT NULL DEFAULT now(),
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT billing_usage_alerts_sent_business_period_threshold_key
    UNIQUE (business_id, period_start, threshold_aud)
);

GRANT ALL ON public.billing_usage_alerts_sent TO service_role;

ALTER TABLE public.billing_usage_alerts_sent ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service role manages usage alerts"
  ON public.billing_usage_alerts_sent
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE INDEX IF NOT EXISTS billing_usage_alerts_sent_business_period_idx
  ON public.billing_usage_alerts_sent (business_id, period_start);

-- ── stripe_webhook_events index ───────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS stripe_webhook_events_event_id_idx
  ON public.stripe_webhook_events (stripe_event_id)
  WHERE status = 'received';

-- ── get_my_billing_detail() ───────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_my_billing_detail()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_business_id uuid;
  v_billing_row jsonb;
  v_usage_aud   numeric;
  v_usage_secs  integer;
  v_pending     integer;
  v_eff_state   text;
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
    COALESCE(SUM(estimated_customer_charge), 0),
    COALESCE(SUM(billable_seconds), 0),
    COUNT(*) FILTER (WHERE stripe_meter_event_status IN ('pending', 'failed'))
  INTO v_usage_aud, v_usage_secs, v_pending
  FROM public.billing_usage_events
  WHERE business_id = v_business_id
    AND billable = true
    AND (
      (v_billing_row->>'current_period_start') IS NULL
      OR created_at >= (v_billing_row->>'current_period_start')::timestamptz
    );

  v_eff_state := public.effective_billing_state(v_business_id);

  RETURN jsonb_build_object(
    'business_id',          v_business_id,
    'billing',              v_billing_row,
    'effective_state',      v_eff_state,
    'usage_aud',            v_usage_aud,
    'usage_seconds',        v_usage_secs,
    'pending_meter_events', v_pending
  );
END;
$$;

-- ── billing_usage_events hardening ────────────────────────────────────────────
ALTER TABLE public.billing_usage_events
  ADD COLUMN IF NOT EXISTS stripe_meter_event_attempt_count   integer     NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS stripe_meter_event_last_attempt_at timestamptz;

DO $$
DECLARE
  v_con text;
BEGIN
  SELECT conname INTO v_con
  FROM pg_constraint
  WHERE conrelid = 'public.billing_usage_events'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) LIKE '%stripe_meter_event_status%'
  LIMIT 1;

  IF v_con IS NOT NULL THEN
    EXECUTE 'ALTER TABLE public.billing_usage_events DROP CONSTRAINT ' || quote_ident(v_con);
  END IF;
END
$$;

ALTER TABLE public.billing_usage_events
  ADD CONSTRAINT billing_usage_events_meter_status_check
  CHECK (stripe_meter_event_status IN ('pending', 'sent', 'failed', 'skipped', 'reconciliation_needed'));

CREATE INDEX IF NOT EXISTS billing_usage_events_meter_retry_idx
  ON public.billing_usage_events (business_id, stripe_meter_event_status)
  WHERE stripe_meter_event_status IN ('pending', 'failed') AND billable = true;
