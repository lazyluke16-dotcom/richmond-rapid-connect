\set ON_ERROR_STOP on

BEGIN;

DO $test$
DECLARE
  tenant_a constant uuid := 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  tenant_b constant uuid := 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  tenant_c constant uuid := 'ffffffff-ffff-4fff-8fff-ffffffffffff';
  claim_a constant uuid := '11111111-1111-4111-8111-111111111111';
  claim_b constant uuid := '22222222-2222-4222-8222-222222222222';
  claim_c constant uuid := '33333333-3333-4333-8333-333333333333';
  retry_claim constant uuid := '44444444-4444-4444-8444-444444444444';
  result jsonb;
  batch_a uuid;
  batch_b uuid;
  first_idempotency text;
  counted integer;
BEGIN
  INSERT INTO public.businesses (id, name, slug)
  VALUES
    (tenant_a, 'Invoice Tenant A', 'invoice-tenant-a'),
    (tenant_b, 'Invoice Tenant B', 'invoice-tenant-b'),
    (tenant_c, 'Invoice Tenant C', 'invoice-tenant-c');

  UPDATE public.business_billing
  SET stripe_customer_id = CASE business_id
    WHEN tenant_a THEN 'cus_test_tenant_a'
    WHEN tenant_b THEN 'cus_test_tenant_b'
    ELSE 'cus_test_tenant_c'
  END
  WHERE business_id IN (tenant_a, tenant_b, tenant_c);

  IF NOT EXISTS (
    SELECT 1 FROM public.billing_config
    WHERE key = 'sms_per_message_aud'
      AND value_numeric = 0.25
      AND currency = 'AUD'
      AND active = true
  ) THEN
    RAISE EXCEPTION 'SMS billing configuration is not the settled 25-cent policy';
  END IF;

  INSERT INTO public.billing_usage_events (
    id, business_id, usage_type, provider, provider_event_id, external_call_id,
    quantity, unit, customer_rate, customer_rate_minor, customer_rate_currency,
    estimated_customer_charge, estimated_customer_charge_minor, billable,
    stripe_meter_event_status, metadata, created_at
  )
  SELECT
    ('10000000-0000-4000-8000-' || lpad(value::text, 12, '0'))::uuid,
    tenant_a, 'outbound_sms', 'twilio', 'SM-A-' || value, 'vapi:CA-A-' || value,
    1, 'message', 0.25, 25, 'AUD', 0.25, 25, true, 'skipped',
    jsonb_build_object(
      'workflow', 'text_link',
      'tax_behavior', 'exclusive',
      'billing_collection', 'invoice_aggregation',
      'telephony_provider_event_id', 'provider-event-a-' || value
    ),
    ('2026-01-' || lpad((10 + value)::text, 2, '0') || 'T00:00:00Z')::timestamptz
  FROM generate_series(1, 4) value;

  -- Same tenant but wrong workflow/type, and another tenant's valid event,
  -- must not enter tenant A's SMS invoice.
  INSERT INTO public.billing_usage_events (
    id, business_id, usage_type, provider, provider_event_id, external_call_id,
    quantity, unit, billable_seconds, customer_rate, customer_rate_currency,
    estimated_customer_charge, billable, stripe_meter_event_status, metadata, created_at
  ) VALUES (
    '20000000-0000-4000-8000-000000000001', tenant_a,
    'ai_voice_seconds', 'vapi', 'call-ai', 'call-ai',
    60, 'second', 60, 0.009833, 'AUD', 0.59, true, 'pending',
    '{"workflow":"ai_receptionist"}', '2026-01-15T00:00:00Z'
  );
  INSERT INTO public.billing_usage_events (
    id, business_id, usage_type, provider, provider_event_id, external_call_id,
    quantity, unit, customer_rate, customer_rate_minor, customer_rate_currency,
    estimated_customer_charge, estimated_customer_charge_minor, billable,
    stripe_meter_event_status, metadata, created_at
  ) VALUES (
    '30000000-0000-4000-8000-000000000001', tenant_b,
    'outbound_sms', 'twilio', 'SM-B-1', 'vapi:CA-B-1',
    1, 'message', 0.25, 25, 'AUD', 0.25, 25, true, 'skipped',
    '{"workflow":"text_link","tax_behavior":"exclusive","billing_collection":"invoice_aggregation"}',
    '2026-01-20T00:00:00Z'
  );

  result := public.claim_sms_invoice_batch(
    tenant_a, '2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z', claim_a, 60
  );
  IF result->>'action' <> 'submit' THEN
    RAISE EXCEPTION 'Tenant A invoice was not claimable: %', result;
  END IF;
  batch_a := (result->>'batchId')::uuid;

  SELECT count(*) INTO counted
  FROM public.sms_invoice_lines
  WHERE invoice_batch_id = batch_a AND business_id = tenant_a;
  IF counted <> 4 THEN
    RAISE EXCEPTION 'Expected four tenant A invoice lines, got %', counted;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.sms_invoice_batches
    WHERE id = batch_a AND business_id = tenant_a
      AND base_amount_minor = 100
      AND gst_amount_minor = 10
      AND total_amount_minor = 110
      AND currency = 'AUD'
      AND tax_rate_bps = 1000
  ) THEN
    RAISE EXCEPTION 'Four-message integer/GST aggregation failed';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.sms_invoice_lines line
    JOIN public.billing_usage_events usage_row ON usage_row.id = line.usage_event_id
    WHERE line.invoice_batch_id = batch_a
      AND (
        usage_row.business_id <> tenant_a
        OR usage_row.usage_type <> 'outbound_sms'
        OR usage_row.stripe_meter_event_status <> 'skipped'
      )
  ) THEN
    RAISE EXCEPTION 'Tenant or AI-meter contamination entered the SMS invoice';
  END IF;

  -- A concurrent/duplicate claimant observes busy and cannot select or submit.
  result := public.claim_sms_invoice_batch(
    tenant_a, '2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z', claim_b, 60
  );
  IF result->>'action' <> 'busy' OR (result->>'batchId')::uuid <> batch_a THEN
    RAISE EXCEPTION 'Concurrent invoice claim was not deduplicated: %', result;
  END IF;

  IF NOT public.begin_sms_invoice_submission(
    tenant_a, batch_a, claim_a, 'cus_test_tenant_a', 120
  ) THEN
    RAISE EXCEPTION 'Could not begin tenant A submission';
  END IF;
  IF NOT public.complete_sms_invoice_submission(
    tenant_a, batch_a, claim_a, 'in_test_tenant_a_jan'
  ) THEN
    RAISE EXCEPTION 'Could not complete tenant A submission';
  END IF;
  IF NOT public.complete_sms_invoice_submission(
    tenant_a, batch_a, claim_b, 'in_test_tenant_a_jan'
  ) THEN
    RAISE EXCEPTION 'Idempotent completion did not preserve provider invoice';
  END IF;
  result := public.claim_sms_invoice_batch(
    tenant_a, '2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z', claim_b, 60
  );
  IF result->>'action' <> 'submitted'
    OR result->>'providerInvoiceId' <> 'in_test_tenant_a_jan' THEN
    RAISE EXCEPTION 'Submitted batch was not stable: %', result;
  END IF;

  -- A late older event and an event exactly at the previous cutoff are both
  -- eligible for the subsequent open period, with distinct carry-forward flags.
  INSERT INTO public.billing_usage_events (
    id, business_id, usage_type, provider, provider_event_id, external_call_id,
    quantity, unit, customer_rate, customer_rate_minor, customer_rate_currency,
    estimated_customer_charge, estimated_customer_charge_minor, billable,
    stripe_meter_event_status, metadata, created_at
  ) VALUES
  (
    '40000000-0000-4000-8000-000000000001', tenant_a,
    'outbound_sms', 'twilio', 'SM-A-LATE', 'vapi:CA-A-LATE',
    1, 'message', 0.25, 25, 'AUD', 0.25, 25, true, 'skipped',
    '{"workflow":"text_link","tax_behavior":"exclusive","billing_collection":"invoice_aggregation"}',
    '2025-12-20T00:00:00Z'
  ),
  (
    '40000000-0000-4000-8000-000000000002', tenant_a,
    'outbound_sms', 'twilio', 'SM-A-CUTOFF', 'vapi:CA-A-CUTOFF',
    1, 'message', 0.25, 25, 'AUD', 0.25, 25, true, 'skipped',
    '{"workflow":"text_link","tax_behavior":"exclusive","billing_collection":"invoice_aggregation"}',
    '2026-02-01T00:00:00Z'
  );

  result := public.claim_sms_invoice_batch(
    tenant_a, '2026-02-01T00:00:00Z', '2026-03-01T00:00:00Z', claim_b, 60
  );
  IF result->>'action' <> 'submit' THEN
    RAISE EXCEPTION 'Subsequent period was not claimable: %', result;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.sms_invoice_lines
    WHERE invoice_batch_id = (result->>'batchId')::uuid
      AND provider_message_sid = 'SM-A-LATE' AND carried_forward = true
  ) OR NOT EXISTS (
    SELECT 1 FROM public.sms_invoice_lines
    WHERE invoice_batch_id = (result->>'batchId')::uuid
      AND provider_message_sid = 'SM-A-CUTOFF' AND carried_forward = false
  ) THEN
    RAISE EXCEPTION 'Cutoff or late-arrival carry-forward behaviour failed';
  END IF;

  -- Provider failure retry freezes tenant B's one line and idempotency key.
  result := public.claim_sms_invoice_batch(
    tenant_b, '2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z', claim_c, 60
  );
  batch_b := (result->>'batchId')::uuid;
  SELECT provider_idempotency_key INTO first_idempotency
  FROM public.sms_invoice_batches WHERE id = batch_b;
  IF NOT public.begin_sms_invoice_submission(
    tenant_b, batch_b, claim_c, 'cus_test_tenant_b', 120
  ) OR NOT public.fail_sms_invoice_submission(
    tenant_b, batch_b, claim_c, 'controlled provider failure'
  ) THEN
    RAISE EXCEPTION 'Controlled failure transition failed';
  END IF;
  result := public.claim_sms_invoice_batch(
    tenant_b, '2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z', retry_claim, 60
  );
  IF result->>'action' <> 'submit'
    OR (result->>'batchId')::uuid <> batch_b
    OR (result->>'idempotencyKey') <> first_idempotency THEN
    RAISE EXCEPTION 'Failed invoice did not reuse frozen identity: %', result;
  END IF;
  SELECT count(*) INTO counted
  FROM public.sms_invoice_lines
  WHERE invoice_batch_id = batch_b AND business_id = tenant_b;
  IF counted <> 1 THEN
    RAISE EXCEPTION 'Failed retry changed tenant B invoice lines';
  END IF;

  -- Rejected/unresolved rows are not eligible.
  INSERT INTO public.billing_usage_events (
    business_id, usage_type, provider, provider_event_id, external_call_id,
    quantity, unit, customer_rate_minor, customer_rate_currency,
    estimated_customer_charge_minor, billable, stripe_meter_event_status,
    metadata, created_at
  ) VALUES
  (
    tenant_c, 'outbound_sms', 'twilio', 'SM-C-REJECTED', 'vapi:CA-C-REJECTED',
    1, 'message', 25, 'AUD', 25, false, 'skipped',
    '{"workflow":"text_link","tax_behavior":"exclusive","billing_collection":"invoice_aggregation"}',
    '2026-01-10T00:00:00Z'
  ),
  (
    tenant_c, 'outbound_sms', 'twilio', NULL, 'vapi:CA-C-UNCERTAIN',
    1, 'message', 25, 'AUD', 25, false, 'skipped',
    '{"workflow":"text_link","tax_behavior":"exclusive","billing_collection":"reconciliation_required"}',
    '2026-01-11T00:00:00Z'
  );
  result := public.claim_sms_invoice_batch(
    tenant_c, '2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z', claim_c, 60
  );
  IF result->>'action' <> 'no_work' THEN
    RAISE EXCEPTION 'Rejected or unresolved SMS became invoiceable: %', result;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'businesses'
      AND column_name = 'onboarding_step'
  ) THEN
    RAISE EXCEPTION 'Promoted onboarding_step migration is absent';
  END IF;
END
$test$;

ROLLBACK;

\echo commercial_sms_invoicing_database_behavior_passed
