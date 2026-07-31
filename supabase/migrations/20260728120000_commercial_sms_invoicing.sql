-- Commercial Text Link SMS invoicing.
--
-- Accepted Twilio Text Link usage is aggregated in integer AUD cents. Each
-- usage event can appear on one invoice line only. GST is calculated once on
-- the batch subtotal at the invoice/tax boundary and is never embedded in the
-- 25-cent usage event.

INSERT INTO public.billing_config (
  key, value_numeric, currency, active, notes
) VALUES (
  'sms_per_message_aud', 0.25, 'AUD', true,
  'A$0.25 excluding GST per Twilio-accepted Text Link recovery SMS'
)
ON CONFLICT (key) DO UPDATE
SET value_numeric = EXCLUDED.value_numeric,
    currency = EXCLUDED.currency,
    active = EXCLUDED.active,
    notes = EXCLUDED.notes,
    updated_at = now();

CREATE TABLE public.sms_invoice_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE RESTRICT,
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  currency text NOT NULL DEFAULT 'AUD',
  status text NOT NULL DEFAULT 'claimed'
    CHECK (status IN ('claimed', 'submitting', 'submitted', 'failed', 'void')),
  base_amount_minor integer NOT NULL DEFAULT 0 CHECK (base_amount_minor >= 0),
  tax_rate_bps integer NOT NULL DEFAULT 1000 CHECK (tax_rate_bps = 1000),
  gst_amount_minor integer NOT NULL DEFAULT 0 CHECK (gst_amount_minor >= 0),
  total_amount_minor integer NOT NULL DEFAULT 0 CHECK (total_amount_minor >= 0),
  provider text NOT NULL DEFAULT 'stripe' CHECK (provider = 'stripe'),
  provider_customer_id text,
  provider_invoice_id text UNIQUE,
  provider_idempotency_key text NOT NULL UNIQUE,
  claim_token uuid,
  claim_expires_at timestamptz,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_attempt_at timestamptz,
  last_error text,
  submitted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sms_invoice_batches_period_check CHECK (period_end > period_start),
  CONSTRAINT sms_invoice_batches_currency_check CHECK (currency = 'AUD'),
  CONSTRAINT sms_invoice_batches_amount_check CHECK (
    gst_amount_minor = round(base_amount_minor::numeric * tax_rate_bps / 10000)::integer
    AND total_amount_minor = base_amount_minor + gst_amount_minor
  ),
  CONSTRAINT sms_invoice_batches_business_period_uk
    UNIQUE (business_id, period_start, period_end, currency),
  CONSTRAINT sms_invoice_batches_id_business_uk UNIQUE (id, business_id)
);

CREATE TABLE public.sms_invoice_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_batch_id uuid NOT NULL,
  business_id uuid NOT NULL,
  usage_event_id uuid NOT NULL UNIQUE
    REFERENCES public.billing_usage_events(id) ON DELETE RESTRICT,
  provider_message_sid text NOT NULL,
  usage_occurred_at timestamptz NOT NULL,
  unit_price_minor integer NOT NULL CHECK (unit_price_minor = 25),
  quantity integer NOT NULL DEFAULT 1 CHECK (quantity = 1),
  line_amount_minor integer NOT NULL CHECK (
    line_amount_minor = unit_price_minor * quantity
  ),
  currency text NOT NULL DEFAULT 'AUD' CHECK (currency = 'AUD'),
  carried_forward boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sms_invoice_lines_batch_business_fkey
    FOREIGN KEY (invoice_batch_id, business_id)
    REFERENCES public.sms_invoice_batches(id, business_id) ON DELETE RESTRICT
);

CREATE INDEX sms_invoice_batches_claim_idx
  ON public.sms_invoice_batches (status, claim_expires_at)
  WHERE status IN ('claimed', 'submitting', 'failed');
CREATE INDEX sms_invoice_lines_batch_idx
  ON public.sms_invoice_lines (invoice_batch_id, usage_occurred_at, usage_event_id);
CREATE INDEX sms_invoice_lines_business_idx
  ON public.sms_invoice_lines (business_id, usage_occurred_at);

COMMENT ON TABLE public.sms_invoice_batches IS
  'Exactly-once invoice aggregates for accepted Text Link SMS usage. Amounts are integer AUD cents.';
COMMENT ON COLUMN public.sms_invoice_batches.gst_amount_minor IS
  'GST calculated once on the aggregate base subtotal using half-up minor-unit rounding.';
COMMENT ON COLUMN public.sms_invoice_batches.provider_idempotency_key IS
  'Stable across retries and provider-boundary interruptions.';
COMMENT ON COLUMN public.sms_invoice_lines.carried_forward IS
  'True when an unbilled eligible event predates this batch period and is safely carried forward.';

GRANT SELECT ON public.sms_invoice_batches, public.sms_invoice_lines TO authenticated;
GRANT ALL ON public.sms_invoice_batches, public.sms_invoice_lines TO service_role;
ALTER TABLE public.sms_invoice_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sms_invoice_lines ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Tenant members read own SMS invoice batches"
  ON public.sms_invoice_batches FOR SELECT TO authenticated
  USING (business_id = public.current_business_id());
CREATE POLICY "Service role manages SMS invoice batches"
  ON public.sms_invoice_batches FOR ALL TO service_role
  USING (true) WITH CHECK (true);
CREATE POLICY "Tenant members read own SMS invoice lines"
  ON public.sms_invoice_lines FOR SELECT TO authenticated
  USING (business_id = public.current_business_id());
CREATE POLICY "Service role manages SMS invoice lines"
  ON public.sms_invoice_lines FOR ALL TO service_role
  USING (true) WITH CHECK (true);

CREATE TRIGGER trg_sms_invoice_batches_updated
  BEFORE UPDATE ON public.sms_invoice_batches
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE OR REPLACE FUNCTION public.claim_sms_invoice_batch(
  _business_id uuid,
  _period_start timestamptz,
  _period_end timestamptz,
  _claim_token uuid,
  _lease_seconds integer DEFAULT 60
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  batch_row public.sms_invoice_batches%ROWTYPE;
  line_count integer;
  base_minor integer;
  lease_seconds integer := greatest(15, least(coalesce(_lease_seconds, 60), 600));
BEGIN
  IF _business_id IS NULL OR _claim_token IS NULL THEN
    RAISE EXCEPTION 'Business and claim token are required' USING ERRCODE = '22023';
  END IF;
  IF _period_start IS NULL OR _period_end IS NULL OR _period_end <= _period_start THEN
    RAISE EXCEPTION 'A valid half-open billing period is required' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.businesses WHERE id = _business_id) THEN
    RAISE EXCEPTION 'Business not found' USING ERRCODE = 'P0002';
  END IF;

  -- Serialize only this tenant and fixed period. This closes both the
  -- nonexistent-row race and concurrent line-selection race.
  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      _business_id::text || '|' || _period_start::text || '|' || _period_end::text,
      0
    )
  );

  SELECT * INTO batch_row
  FROM public.sms_invoice_batches
  WHERE business_id = _business_id
    AND period_start = _period_start
    AND period_end = _period_end
    AND currency = 'AUD'
  FOR UPDATE;

  IF FOUND THEN
    IF batch_row.status = 'submitted' THEN
      RETURN jsonb_build_object(
        'action', 'submitted',
        'batchId', batch_row.id,
        'providerInvoiceId', batch_row.provider_invoice_id
      );
    END IF;
    IF batch_row.status = 'void' THEN
      RETURN jsonb_build_object('action', 'void', 'batchId', batch_row.id);
    END IF;
    IF batch_row.status IN ('claimed', 'submitting')
      AND batch_row.claim_expires_at IS NOT NULL
      AND batch_row.claim_expires_at > now() THEN
      RETURN jsonb_build_object('action', 'busy', 'batchId', batch_row.id);
    END IF;

    -- Failed or stale work reuses the frozen lines and provider idempotency
    -- key. It never selects a second set of usage events.
    UPDATE public.sms_invoice_batches
    SET status = 'claimed',
        claim_token = _claim_token,
        claim_expires_at = now() + make_interval(secs => lease_seconds),
        last_error = NULL
    WHERE id = batch_row.id
    RETURNING * INTO batch_row;

    RETURN jsonb_build_object(
      'action', 'submit',
      'batchId', batch_row.id,
      'claimToken', batch_row.claim_token,
      'idempotencyKey', batch_row.provider_idempotency_key,
      'baseAmountMinor', batch_row.base_amount_minor,
      'gstAmountMinor', batch_row.gst_amount_minor,
      'totalAmountMinor', batch_row.total_amount_minor
    );
  END IF;

  INSERT INTO public.sms_invoice_batches (
    business_id, period_start, period_end, currency, status,
    provider_idempotency_key, claim_token, claim_expires_at
  ) VALUES (
    _business_id, _period_start, _period_end, 'AUD', 'claimed',
    'sms-invoice:' || gen_random_uuid()::text,
    _claim_token, now() + make_interval(secs => lease_seconds)
  )
  RETURNING * INTO batch_row;

  INSERT INTO public.sms_invoice_lines (
    invoice_batch_id, business_id, usage_event_id, provider_message_sid,
    usage_occurred_at, unit_price_minor, quantity, line_amount_minor,
    currency, carried_forward
  )
  SELECT
    batch_row.id, usage_row.business_id, usage_row.id,
    usage_row.provider_event_id, usage_row.created_at,
    usage_row.customer_rate_minor, 1,
    usage_row.estimated_customer_charge_minor,
    usage_row.customer_rate_currency,
    usage_row.created_at < _period_start
  FROM public.billing_usage_events usage_row
  WHERE usage_row.business_id = _business_id
    AND usage_row.created_at < _period_end
    AND usage_row.usage_type = 'outbound_sms'
    AND usage_row.provider = 'twilio'
    AND usage_row.billable = true
    AND usage_row.quantity = 1
    AND usage_row.unit = 'message'
    AND usage_row.customer_rate_minor = 25
    AND usage_row.estimated_customer_charge_minor = 25
    AND usage_row.customer_rate_currency = 'AUD'
    AND usage_row.stripe_meter_event_status = 'skipped'
    AND coalesce(usage_row.provider_event_id, '') <> ''
    AND usage_row.metadata->>'workflow' = 'text_link'
    AND usage_row.metadata->>'tax_behavior' = 'exclusive'
    AND usage_row.metadata->>'billing_collection' = 'invoice_aggregation'
    AND NOT EXISTS (
      SELECT 1
      FROM public.sms_invoice_lines existing_line
      WHERE existing_line.usage_event_id = usage_row.id
    )
  ORDER BY usage_row.created_at, usage_row.id
  ON CONFLICT (usage_event_id) DO NOTHING;

  SELECT count(*), coalesce(sum(line_amount_minor), 0)
  INTO line_count, base_minor
  FROM public.sms_invoice_lines
  WHERE invoice_batch_id = batch_row.id
    AND business_id = _business_id;

  IF line_count = 0 THEN
    DELETE FROM public.sms_invoice_batches WHERE id = batch_row.id;
    RETURN jsonb_build_object('action', 'no_work');
  END IF;

  UPDATE public.sms_invoice_batches
  SET base_amount_minor = base_minor,
      gst_amount_minor = round(base_minor::numeric * 1000 / 10000)::integer,
      total_amount_minor =
        base_minor + round(base_minor::numeric * 1000 / 10000)::integer
  WHERE id = batch_row.id
  RETURNING * INTO batch_row;

  RETURN jsonb_build_object(
    'action', 'submit',
    'batchId', batch_row.id,
    'claimToken', batch_row.claim_token,
    'idempotencyKey', batch_row.provider_idempotency_key,
    'baseAmountMinor', batch_row.base_amount_minor,
    'gstAmountMinor', batch_row.gst_amount_minor,
    'totalAmountMinor', batch_row.total_amount_minor
  );
END
$$;

CREATE OR REPLACE FUNCTION public.begin_sms_invoice_submission(
  _business_id uuid,
  _batch_id uuid,
  _claim_token uuid,
  _provider_customer_id text,
  _lease_seconds integer DEFAULT 120
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  changed integer;
  lease_seconds integer := greatest(30, least(coalesce(_lease_seconds, 120), 900));
BEGIN
  IF coalesce(_provider_customer_id, '') = '' THEN
    RAISE EXCEPTION 'Provider customer ID is required' USING ERRCODE = '22023';
  END IF;
  UPDATE public.sms_invoice_batches
  SET status = 'submitting',
      provider_customer_id = _provider_customer_id,
      claim_expires_at = now() + make_interval(secs => lease_seconds),
      attempt_count = attempt_count + 1,
      last_attempt_at = now(),
      last_error = NULL
  WHERE id = _batch_id
    AND business_id = _business_id
    AND status = 'claimed'
    AND claim_token = _claim_token
    AND claim_expires_at > now();
  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN changed = 1;
END
$$;

CREATE OR REPLACE FUNCTION public.complete_sms_invoice_submission(
  _business_id uuid,
  _batch_id uuid,
  _claim_token uuid,
  _provider_invoice_id text
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  batch_row public.sms_invoice_batches%ROWTYPE;
BEGIN
  IF coalesce(_provider_invoice_id, '') = '' THEN
    RAISE EXCEPTION 'Provider invoice ID is required' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO batch_row
  FROM public.sms_invoice_batches
  WHERE id = _batch_id AND business_id = _business_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SMS invoice batch not found' USING ERRCODE = 'P0002';
  END IF;
  IF batch_row.status = 'submitted' THEN
    RETURN batch_row.provider_invoice_id = _provider_invoice_id;
  END IF;
  IF batch_row.status <> 'submitting'
    OR batch_row.claim_token IS DISTINCT FROM _claim_token THEN
    RETURN false;
  END IF;
  UPDATE public.sms_invoice_batches
  SET status = 'submitted',
      provider_invoice_id = _provider_invoice_id,
      submitted_at = now(),
      claim_token = NULL,
      claim_expires_at = NULL,
      last_error = NULL
  WHERE id = batch_row.id;
  RETURN true;
END
$$;

CREATE OR REPLACE FUNCTION public.fail_sms_invoice_submission(
  _business_id uuid,
  _batch_id uuid,
  _claim_token uuid,
  _error_message text
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  changed integer;
BEGIN
  UPDATE public.sms_invoice_batches
  SET status = 'failed',
      claim_token = NULL,
      claim_expires_at = NULL,
      last_error = left(coalesce(_error_message, 'invoice_provider_failed'), 500)
  WHERE id = _batch_id
    AND business_id = _business_id
    AND status IN ('claimed', 'submitting')
    AND claim_token = _claim_token;
  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN changed = 1;
END
$$;

REVOKE EXECUTE ON FUNCTION public.claim_sms_invoice_batch(uuid,timestamptz,timestamptz,uuid,integer)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.begin_sms_invoice_submission(uuid,uuid,uuid,text,integer)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.complete_sms_invoice_submission(uuid,uuid,uuid,text)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fail_sms_invoice_submission(uuid,uuid,uuid,text)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.claim_sms_invoice_batch(uuid,timestamptz,timestamptz,uuid,integer)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.begin_sms_invoice_submission(uuid,uuid,uuid,text,integer)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_sms_invoice_submission(uuid,uuid,uuid,text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.fail_sms_invoice_submission(uuid,uuid,uuid,text)
  TO service_role;
