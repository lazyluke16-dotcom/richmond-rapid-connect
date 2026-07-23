
CREATE TABLE IF NOT EXISTS public.leads (
  id TEXT PRIMARY KEY,
  created_at BIGINT NOT NULL,
  job_type TEXT NOT NULL,
  suburb TEXT NOT NULL,
  urgency TEXT NOT NULL,
  property_type TEXT NOT NULL,
  photos JSONB DEFAULT '[]',
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  best_time TEXT DEFAULT '',
  chat JSONB DEFAULT '[]',
  ai_summary TEXT DEFAULT '',
  lead_score INT DEFAULT 0,
  recommended_action TEXT DEFAULT '',
  status TEXT DEFAULT 'new',
  source TEXT DEFAULT 'form',
  external_call_id TEXT,
  call_recording_url TEXT
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.leads TO anon, authenticated;
GRANT ALL ON public.leads TO service_role;
ALTER TABLE public.leads ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Demo open access on leads" ON public.leads FOR ALL USING (true) WITH CHECK (true);

CREATE TABLE IF NOT EXISTS public.sms_events (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  to_number TEXT NOT NULL,
  from_number TEXT NOT NULL,
  body TEXT NOT NULL,
  mode TEXT NOT NULL,
  status TEXT NOT NULL,
  twilio_sid TEXT,
  error_message TEXT
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.sms_events TO anon, authenticated;
GRANT ALL ON public.sms_events TO service_role;
ALTER TABLE public.sms_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Demo open access on sms_events" ON public.sms_events FOR ALL USING (true) WITH CHECK (true);

CREATE TABLE IF NOT EXISTS public.missed_calls (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  caller_phone TEXT NOT NULL,
  sms_sent BOOLEAN DEFAULT FALSE,
  sms_event_id TEXT,
  source TEXT DEFAULT 'demo'
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.missed_calls TO anon, authenticated;
GRANT ALL ON public.missed_calls TO service_role;
ALTER TABLE public.missed_calls ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Demo open access on missed_calls" ON public.missed_calls FOR ALL USING (true) WITH CHECK (true);
