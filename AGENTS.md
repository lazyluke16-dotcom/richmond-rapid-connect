<!-- LOVABLE:BEGIN -->
> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.
<!-- LOVABLE:END -->

## Session: Missed-call demo backend (2026-07-11)

Added:
- Lovable Cloud database (PostgreSQL) with tables: `leads`, `sms_events`, `missed_calls`
- `src/lib/supabase.ts` — Supabase client
- `src/lib/db-leads.ts` — server functions: `insertLead`, `updateLeadStatus`, `fetchLeads`
- `src/lib/sms.ts` — SMS abstraction (demo/twilio modes via `SMS_MODE` env var)
- `src/lib/webhooks.ts` — optional outbound webhook on lead creation
- `src/routes/missed-call.tsx` — demo missed-call recovery trigger page
- `src/routes/api/demo.trigger-sms.ts` — POST /api/demo/trigger-sms
- `src/routes/api/dashboard.verify-pin.ts` — POST /api/dashboard/verify-pin
- `src/routes/api/webhooks.ai-phone-lead.ts` — POST /api/webhooks/ai-phone-lead
- `src/components/PinGate.tsx` — PIN gate for /dashboard
- `src/components/DemoSmsPreview.tsx` — phone mockup for simulated SMS

Key env vars (set in Project Settings → Secrets):
- `DASHBOARD_PIN` — PIN to unlock /dashboard
- `SMS_MODE` — "demo" (default) or "twilio"
- `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER` — Twilio (optional)
- `DEMO_PLUMBER_PHONE` — plumber's mobile for lead notifications
- `PUBLIC_JOB_REQUEST_URL` — base URL for SMS recovery links
- `WEBHOOK_SECRET` — shared secret for /api/webhooks/ai-phone-lead
- `OUTBOUND_WEBHOOK_URL` — optional Make.com/Zapier/n8n URL for lead automation
