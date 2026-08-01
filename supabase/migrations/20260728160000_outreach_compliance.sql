-- Permissioned outreach operations.
--
-- The database is the final enforcement boundary: a message cannot enter a
-- sendable state without reviewed permission evidence, a complete sender
-- identity, an unsubscribe instruction and a clear suppression check.

CREATE TABLE public.outreach_campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 3 AND 120),
  code text NOT NULL UNIQUE CHECK (code = lower(code) AND code ~ '^[a-z0-9][a-z0-9-]{2,63}$'),
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','ready','paused','completed')),
  sender_legal_name text NOT NULL CHECK (length(btrim(sender_legal_name)) BETWEEN 2 AND 160),
  sender_contact text NOT NULL CHECK (length(btrim(sender_contact)) BETWEEN 3 AND 240),
  landing_path text NOT NULL DEFAULT '/plumbers'
    CHECK (landing_path LIKE '/%' AND length(landing_path) <= 240),
  promotion_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER outreach_campaigns_set_updated_at
BEFORE UPDATE ON public.outreach_campaigns
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE public.outreach_recipients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES public.outreach_campaigns(id) ON DELETE RESTRICT,
  channel text NOT NULL CHECK (channel IN ('sms','email','social')),
  business_name text NOT NULL CHECK (length(btrim(business_name)) BETWEEN 2 AND 160),
  contact_name text,
  contact_value text NOT NULL CHECK (length(btrim(contact_value)) BETWEEN 3 AND 320),
  endpoint_hash text NOT NULL CHECK (endpoint_hash ~ '^[a-f0-9]{64}$'),
  permission_basis text NOT NULL CHECK (permission_basis IN ('express','inferred')),
  permission_source text NOT NULL CHECK (length(btrim(permission_source)) BETWEEN 3 AND 500),
  permission_recorded_at timestamptz NOT NULL,
  permission_reviewed_at timestamptz,
  permission_reviewed_by uuid,
  permission_notes text,
  eligibility_status text NOT NULL DEFAULT 'pending_review'
    CHECK (eligibility_status IN ('pending_review','eligible','suppressed','invalid')),
  unsubscribe_token_hash text UNIQUE
    CHECK (unsubscribe_token_hash IS NULL OR unsubscribe_token_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, channel, endpoint_hash),
  CHECK (
    eligibility_status <> 'eligible'
    OR (permission_reviewed_at IS NOT NULL AND permission_reviewed_by IS NOT NULL)
  )
);

CREATE INDEX outreach_recipients_endpoint_idx
  ON public.outreach_recipients (channel, endpoint_hash);
CREATE INDEX outreach_recipients_campaign_status_idx
  ON public.outreach_recipients (campaign_id, eligibility_status);

CREATE TRIGGER outreach_recipients_set_updated_at
BEFORE UPDATE ON public.outreach_recipients
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE public.outreach_suppressions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel text NOT NULL CHECK (channel IN ('sms','email','social')),
  endpoint_hash text NOT NULL CHECK (endpoint_hash ~ '^[a-f0-9]{64}$'),
  reason text NOT NULL CHECK (reason IN (
    'unsubscribe','stop_reply','complaint','hard_bounce','invalid','manual','legal_hold'
  )),
  source text NOT NULL CHECK (length(btrim(source)) BETWEEN 2 AND 80),
  source_event_id text,
  suppressed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (channel, endpoint_hash)
);

CREATE UNIQUE INDEX outreach_suppressions_source_event_idx
  ON public.outreach_suppressions (source, source_event_id)
  WHERE source_event_id IS NOT NULL;

CREATE TABLE public.outreach_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES public.outreach_campaigns(id) ON DELETE RESTRICT,
  recipient_id uuid NOT NULL REFERENCES public.outreach_recipients(id) ON DELETE RESTRICT,
  channel text NOT NULL CHECK (channel IN ('sms','email','social')),
  template_key text NOT NULL CHECK (length(btrim(template_key)) BETWEEN 2 AND 80),
  body text NOT NULL CHECK (length(btrim(body)) BETWEEN 3 AND 10000),
  unsubscribe_instruction text NOT NULL
    CHECK (length(btrim(unsubscribe_instruction)) BETWEEN 3 AND 500),
  campaign_link text NOT NULL CHECK (campaign_link LIKE 'http%' AND length(campaign_link) <= 1000),
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN (
      'draft','queued','sending','sent','delivered','failed','suppressed','cancelled'
    )),
  provider_message_id text,
  queued_at timestamptz,
  sent_at timestamptz,
  delivered_at timestamptz,
  failure_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, recipient_id, template_key)
);

CREATE INDEX outreach_messages_campaign_status_idx
  ON public.outreach_messages (campaign_id, status, created_at);

CREATE OR REPLACE FUNCTION public.enforce_outreach_message_gate()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  campaign public.outreach_campaigns%ROWTYPE;
  recipient public.outreach_recipients%ROWTYPE;
BEGIN
  IF NEW.status NOT IN ('queued','sending','sent','delivered') THEN
    RETURN NEW;
  END IF;

  SELECT * INTO campaign FROM public.outreach_campaigns WHERE id = NEW.campaign_id;
  SELECT * INTO recipient FROM public.outreach_recipients WHERE id = NEW.recipient_id;

  IF campaign.id IS NULL OR campaign.status <> 'ready' THEN
    RAISE EXCEPTION 'Outreach campaign is not approved for sending';
  END IF;
  IF recipient.id IS NULL
     OR recipient.campaign_id <> NEW.campaign_id
     OR recipient.channel <> NEW.channel
     OR recipient.eligibility_status <> 'eligible'
     OR recipient.permission_reviewed_at IS NULL
     OR recipient.permission_reviewed_by IS NULL
  THEN
    RAISE EXCEPTION 'Recipient does not have reviewed permission evidence';
  END IF;
  IF length(btrim(campaign.sender_legal_name)) < 2
     OR length(btrim(campaign.sender_contact)) < 3
     OR position(lower(campaign.sender_legal_name) IN lower(NEW.body)) = 0
  THEN
    RAISE EXCEPTION 'Message does not identify the authorised sender';
  END IF;
  IF length(btrim(NEW.unsubscribe_instruction)) < 3
     OR position(lower(btrim(NEW.unsubscribe_instruction)) IN lower(NEW.body)) = 0
  THEN
    RAISE EXCEPTION 'Message does not contain its unsubscribe instruction';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.outreach_suppressions s
     WHERE s.channel = recipient.channel
       AND s.endpoint_hash = recipient.endpoint_hash
  ) THEN
    RAISE EXCEPTION 'Recipient is suppressed';
  END IF;

  IF NEW.status = 'queued' AND NEW.queued_at IS NULL THEN
    NEW.queued_at := now();
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER outreach_messages_send_gate
BEFORE INSERT OR UPDATE OF status ON public.outreach_messages
FOR EACH ROW EXECUTE FUNCTION public.enforce_outreach_message_gate();

CREATE TRIGGER outreach_messages_set_updated_at
BEFORE UPDATE ON public.outreach_messages
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE OR REPLACE FUNCTION public.record_outreach_suppression(
  _channel text,
  _endpoint_hash text,
  _reason text,
  _source text,
  _source_event_id text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  suppression_id uuid;
BEGIN
  IF _channel NOT IN ('sms','email','social')
     OR _endpoint_hash !~ '^[a-f0-9]{64}$'
     OR _reason NOT IN (
       'unsubscribe','stop_reply','complaint','hard_bounce','invalid','manual','legal_hold'
     )
  THEN
    RAISE EXCEPTION 'Invalid suppression request';
  END IF;

  INSERT INTO public.outreach_suppressions (
    channel, endpoint_hash, reason, source, source_event_id
  ) VALUES (
    _channel, _endpoint_hash, _reason, left(btrim(_source), 80),
    left(nullif(btrim(_source_event_id), ''), 240)
  )
  ON CONFLICT (channel, endpoint_hash) DO UPDATE
    SET reason = EXCLUDED.reason,
        source = EXCLUDED.source,
        source_event_id = COALESCE(
          public.outreach_suppressions.source_event_id,
          EXCLUDED.source_event_id
        ),
        suppressed_at = LEAST(
          public.outreach_suppressions.suppressed_at,
          now()
        )
  RETURNING id INTO suppression_id;

  UPDATE public.outreach_recipients
     SET eligibility_status = 'suppressed'
   WHERE channel = _channel
     AND endpoint_hash = _endpoint_hash;

  UPDATE public.outreach_messages m
     SET status = 'suppressed'
    FROM public.outreach_recipients r
   WHERE m.recipient_id = r.id
     AND r.channel = _channel
     AND r.endpoint_hash = _endpoint_hash
     AND m.status IN ('draft','queued');

  RETURN suppression_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.unsubscribe_outreach_recipient(
  _token_hash text,
  _source text DEFAULT 'web'
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  recipient public.outreach_recipients%ROWTYPE;
BEGIN
  IF _token_hash !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'Invalid unsubscribe token';
  END IF;

  SELECT * INTO recipient
    FROM public.outreach_recipients
   WHERE unsubscribe_token_hash = _token_hash;
  IF recipient.id IS NULL THEN
    RAISE EXCEPTION 'Unsubscribe link is invalid';
  END IF;

  RETURN public.record_outreach_suppression(
    recipient.channel,
    recipient.endpoint_hash,
    'unsubscribe',
    left(btrim(_source), 80),
    recipient.id::text
  );
END;
$$;

ALTER TABLE public.outreach_campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.outreach_recipients ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.outreach_suppressions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.outreach_messages ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.outreach_campaigns FROM anon, authenticated;
REVOKE ALL ON public.outreach_recipients FROM anon, authenticated;
REVOKE ALL ON public.outreach_suppressions FROM anon, authenticated;
REVOKE ALL ON public.outreach_messages FROM anon, authenticated;
GRANT ALL ON public.outreach_campaigns TO service_role;
GRANT ALL ON public.outreach_recipients TO service_role;
GRANT ALL ON public.outreach_suppressions TO service_role;
GRANT ALL ON public.outreach_messages TO service_role;

CREATE POLICY "service_role_manages_outreach_campaigns"
  ON public.outreach_campaigns FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_role_manages_outreach_recipients"
  ON public.outreach_recipients FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_role_manages_outreach_suppressions"
  ON public.outreach_suppressions FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_role_manages_outreach_messages"
  ON public.outreach_messages FOR ALL TO service_role USING (true) WITH CHECK (true);

REVOKE ALL ON FUNCTION public.enforce_outreach_message_gate() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_outreach_suppression(
  text, text, text, text, text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.unsubscribe_outreach_recipient(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_outreach_suppression(
  text, text, text, text, text
) TO service_role;
GRANT EXECUTE ON FUNCTION public.unsubscribe_outreach_recipient(text, text) TO service_role;
