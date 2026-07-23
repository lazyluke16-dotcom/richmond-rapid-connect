
# Phase 2G Audit — Reusable Multi-Customer SaaS & Setup Wizard

Read-only audit at head `afd1877`. No files changed.

---

## 1. What already exists and is production-ready

**Auth & account creation**
- `src/routes/signup.tsx` — email/password signup with partner/ref attribution stashed in `sessionStorage`.
- `src/routes/auth.tsx` + `src/routes/reset-password.tsx` — sign-in and password reset.
- `src/routes/_authenticated/route.tsx` — SSR-off gate, redirects to `/auth` or `/onboarding` based on `getOnboardingStatus`.

**Server-side tenant model (RLS-enforced)**
- `businesses`, `business_users`, `business_services`, `business_service_areas`, `business_hours`, `business_telephony_settings`, `business_missed_call_settings`, `business_ai_receptionist_settings`, `business_billing`, `ai_provider_mappings`, `leads`, `missed_calls`, `sms_events`, `billing_usage_events`, `enrichment_jobs`.
- `public.current_business_id()` (SECURITY DEFINER) is the single source of truth for the caller's tenant; all authenticated server fns resolve tenant via RLS instead of trusting client input.
- `create_business_for_current_user()` is idempotent (one business per user), reserves a unique slug via `reserve_business_slug`, and `seed_business_defaults` trigger creates the four settings rows + `business_billing` on insert.

**Wizard scaffold (`_authenticated/onboarding.tsx`)**
- 8 steps: Business → Branding → Services → Areas → Hours → Plan → Website copy → Finish. Resume detection reads `getOnboardingStatus` and reloads the business record.
- Server fns for each step: `createMyBusiness`, `updateMyBusiness`, `setMyServices`, `setMyAreas`, `setMyHours`, `setMyPlan`, `completeOnboarding`, `updateMySlug`. All go through `requireSupabaseAuth` + RLS.

**Post-onboarding product settings pages (multi-tenant-safe)**
- `_authenticated/missed-call-settings.tsx` — per-tenant SMS template, mode, alerts, test-send.
- `_authenticated/ai-receptionist.tsx` — per-tenant assistant name/voice/tone/first message/responses/privacy + simulator.
- Both read `has_access` from `has_missed_call_access` / `has_ai_receptionist_access` for plan gating.
- `/b/$slug` public tenant site (`src/routes/b.$slug.tsx` + children) is fully data-driven; branding/CSS vars come from the loader bundle.

**Billing scaffold**
- Stripe subs, immutable ledger, meter dispatch, `effective_billing_state()`, `billing_exempt` flag, Union offer eligibility, grace-period logic — Phase 2F work is in place (test mode).

**Vapi/AI receptionist provisioning**
- Real assistant provisioning via `ai-provisioning.functions.ts`, resolved server-side via `ai_provider_mappings` + `resolve_ai_tenant()`. Deduplicating unique index on `leads` for external call IDs.

---

## 2. What exists but is incomplete or unsafe

**Wizard UX gaps**
- **Logo is URL-only** (`onboarding.tsx` line 258; note says "Direct file upload is coming soon"). No storage bucket exists (`storage-buckets` is empty in project info).
- **Step navigation is forward-only, one-way**: each `saveX` bumps `step` to the next, but no persistent per-step "completed" marker — reload lands the user at step 1 (branding) regardless of how far they got. Wizard resume is coarse: it distinguishes "no business" vs "has business, not finished", not which step.
- **`setMyServices` / `setMyAreas` are destructive replaces** (delete-then-insert). If a user re-visits step 2 on resume the current in-memory `services` state is `DEFAULT_SERVICES` (not the DB state), so "Next" overwrites any earlier customisation with defaults. Same class of bug for areas (empty `areas` state on resume) and hours (default template).
- **No review step** before `completeOnboarding()`; no explicit validation gate on required fields beyond business name length ≥ 2.
- **No preview of the public `/b/:slug` site** other than the small side-card; no "open in new tab before publishing" step.
- **Plan step doesn't take a payment method** — `setMyPlan` sets plan + starts a 30-day trial but the wizard never routes through `/api/public/billing.checkout`. Copy says "First month free — no card required" which conflicts with the Union Member Offer copy on `/signup` ("A valid payment method is required to activate service").
- **Trade type**: hardcoded plumbing service list (`DEFAULT_SERVICES`). No `trade_type` column on `businesses`; the AI receptionist and public site all assume plumbing verbiage.
- **Postcodes and radius**: `business_service_areas` supports `postcode`, but the wizard only captures `suburb` strings. No radius model at all.
- **After-hours rules / emergency handling**: only a free-text `emergency_message` on `businesses` and per-day open/close. No "after-hours divert to voicemail", "after-hours AI still answers", or emergency contact routing.
- **Telephony provisioning**: `business_telephony_settings` exists but is not surfaced in the wizard or dashboard. Owners cannot see inbound/forwarding phone or its provisioning state.
- **Lead notification recipients**: only `alert_phone` / `alert_email` on `business_missed_call_settings`; no separate recipients table, no per-channel preferences, no per-lead routing rules. AI receptionist has no notification config at all.
- **Booking/callback preferences**: some fields exist on `business_ai_receptionist_settings` (`callback_message`) but there is no separate booking-preferences model (slot windows, quote vs job, callback SLA).
- **Save/resume** is implicit through DB reads; there is no `onboarding_step` / `onboarding_state` column, so we cannot restore the wizard to the exact step the user left.

**Branding fallback that could mislead a second customer**
- `src/components/AppShell.tsx` has a hard-coded `DEFAULT_TENANT` (Richmond Rapid Plumbing, 1300 000 000, Melbourne, Lic #12345) used whenever a screen forgets to pass `tenant`. Every authenticated screen that does not use `useMyTenantBrand()` will render Richmond branding on top of another customer's data.
- `useMyTenantBrand()` fetches client-side after mount → a visible Richmond flash before the real tenant loads.

**Hard-coded "Richmond" content on public pages (product-level, not routing)**
- `src/routes/index.tsx`, `services.emergency.tsx`, `services.blocked-drains.tsx`, `areas.tsx`, `chat.tsx`, `request.tsx`, `confirmation.tsx`, `missed-call.tsx`, `reset-password.tsx`, `__root.tsx`, `_authenticated/dashboard.tsx` all embed "Richmond Rapid Plumbing" text/meta.
- These are the *marketing site* pages for the demo tenant. They don't misroute leads (see §4), but they are not customer-neutral.

**Default-tenant misrouting risk (see §4)**
- `src/lib/tenant.ts` `resolveBusinessId()` returns the Richmond business id from either env or `slug='richmond-rapid-plumbing'` for any unauth/legacy write path. Fine for demo, dangerous once a second customer sends real traffic through the same public code paths.
- `src/lib/db-leads.ts` `insertLead` falls back to `resolveBusinessId()` when no business is supplied.
- `src/lib/sms.ts` looks up SMS settings with the same fallback.
- `src/routes/api/demo.trigger-sms.ts` and `src/routes/api/webhooks.ai-phone-lead.ts` also fall back to the default tenant.

**Security posture already fixed but worth noting**
- `businesses` public read is now via `businesses_public` view; anon direct SELECT is revoked. RLS grants on all tenant tables scope to `current_business_id()` — that part is solid.

---

## 3. What is missing

- Owner identity fields on `businesses` beyond `owner_user_id` (no `owner_display_name`, `owner_phone`).
- `trade_type` on `businesses` and a trade-type registry with per-trade default services + service prompts.
- `logo_url` upload path (storage bucket, signed upload, image validation, size cap, delete-on-replace).
- Postcode-list capture and/or `service_radius_km` + centroid on `business_service_areas`.
- After-hours rules table or JSON column (`ah_behaviour: divert|ai_answers|voicemail`, `ah_message`, `emergency_service_ids`).
- Dedicated `business_notification_recipients` table (owner + optional teammates, per-channel, per-event: `missed_call_recovered`, `ai_lead_captured`, `emergency_lead`).
- Booking/callback preferences (SLA, hours, "quote first" vs "book directly", preferred callback window).
- `business_telephony_settings` UI: inbound number status, forwarding target, provisioning workflow, port-in vs new-number.
- Payment method capture wired into the wizard (Stripe Checkout before activation, or SetupIntent + subscription-create-on-activate).
- Persistent wizard state: `onboarding_step` (int) and/or `onboarding_state` (jsonb) on `businesses`; per-step "completed" flags so resume lands on the exact next step.
- Review step + preview link before `completeOnboarding()`.
- Validation for every wizard write on the server (Zod input validators are not used in `onboarding.functions.ts` — inputs are trusted as-is).
- A neutral marketing home for un-scoped visitors (no Richmond copy).
- Onboarding-complete + billing-active gating: `completeOnboarding` currently only flips a bool; there is no activation gate that also requires a payment method (or `billing_exempt`).

---

## 4. Hard-coded Richmond/default paths that would misroute a second customer's traffic

| Path | Where | Risk |
|---|---|---|
| Default tenant slug `richmond-rapid-plumbing` | `src/lib/tenant.ts` line 25 | Any unauth write with no slug lands on Richmond |
| `insertLead` fallback | `src/lib/db-leads.ts` line 28 | Legacy `POST /api/webhooks/ai-phone-lead` and demo triggers without an explicit tenant will file leads under Richmond |
| SMS mode/settings lookup | `src/lib/sms.ts` line 64 | An outbound SMS with no `business_id` uses Richmond's telephony settings |
| Demo trigger route | `src/routes/api/demo.trigger-sms.ts` line 38 | Same |
| AI phone lead webhook | `src/routes/api/webhooks.ai-phone-lead.ts` line 90 | Suburb default "Richmond" hardcoded even when payload is another tenant's lead |
| Public marketing pages | `src/routes/index.tsx`, `areas.tsx`, `services.*.tsx`, `chat.tsx`, `request.tsx`, `confirmation.tsx`, `missed-call.tsx`, `__root.tsx` | Presentation-only, but a second customer visiting the top-level domain sees Richmond copy; the `/b/:slug` route is the correct customer-facing surface |
| AppShell fallback | `src/components/AppShell.tsx` line 27 | Any authenticated screen that forgets to pass `tenant` renders Richmond header for a different customer |
| Meta titles | `_authenticated/dashboard.tsx` line 12, `reset-password.tsx`, `auth.tsx`, `__root.tsx` | Wrong tab title for other customers |

Nothing on the server-side authenticated data path misroutes (RLS pins the tenant to `auth.uid()`), but the unauth/webhook/marketing surface is Richmond-shaped.

---

## 5. Is onboarding resumable without overwriting saved services/areas/hours?

**No.** Resume today:

1. `getOnboardingStatus` tells us "has business, not completed" and we jump to step 1 (branding). We do **not** refetch services/areas/hours.
2. Wizard state for those steps is initialised from **hardcoded defaults**, not the DB.
3. If the user clicks through step 2/3/4 again, `setMyServices` / `setMyAreas` / `setMyHours` delete-then-insert with those defaults — silently reverting the user's earlier work.

Fixes needed: persist `onboarding_step`, prefetch and hydrate services/areas/hours on resume, and change the "replace all" semantics into an idempotent upsert (or gate the replace behind explicit "Save").

---

## 6. Is tenant isolation enforced server-side/RLS for every wizard write?

**Authenticated wizard writes: yes.** Every wizard server fn goes through `requireSupabaseAuth` and either targets `current_business_id()` (RLS) or the SECURITY DEFINER RPC (`create_business_for_current_user`, `update_my_business_slug`), which derive the tenant from `auth.uid()`. Client-supplied `id` on `updateMyBusiness` is ignored — the fn re-reads its own business first and updates by that id.

**Gaps to close before we call this "safe for multi-customer":**
- No Zod validation on wizard inputs (`.inputValidator((data) => data)` is an identity function today). Not a tenant-isolation bug, but hostile input hits the DB unchecked.
- `setMyServices` / `setMyAreas` / `setMyHours` are DELETE-then-INSERT: safe for tenant boundary (they always filter by `bid`), but destructive for wizard UX (see §5).
- `setMyPlan` writes to `businesses` via RLS but then upserts `business_billing` with the service-role admin client — correct, but that path also relies on `current_business_id()` — the code passes `biz.id` explicitly, so it's fine, just worth flagging in review.
- `signup.tsx` stores `partner_code`/`referral_code` in `sessionStorage` and forwards them to `createMyBusiness`. These are attribution-only and safe, but should be validated against an allow-list to keep partner offers honest.

**Unauthenticated writes** (missed-call demo, AI phone webhook, Stripe/Vapi webhooks) all resolve tenant server-side, but as noted in §4 several fall back to Richmond if a slug is missing. Multi-customer readiness requires making tenant resolution required (no default) on every unauth write path.

---

## 7. Phased implementation plan with go/no-go gates

Each phase ends with a hard gate that must pass before the next starts. No behaviour changes to already-CERTIFIED phases (2A/2B/2C/2D/2E/2E.1/2F/3B/3C).

### Phase 2G.1 — Wizard state, resume-safety, and neutralise defaults (smallest safe first slice)

Scope
- Add `onboarding_step` (smallint) + `onboarding_state` (jsonb) columns to `businesses`.
- `getOnboardingStatus` returns those fields.
- Wizard reads them and re-hydrates services/areas/hours from the DB on mount (not defaults).
- Add Zod validators to every wizard server fn.
- Add server-side "diff" for `setMyServices` (upsert by `service_key`, delete only what the user removed) so re-visiting a step no longer wipes it.
- Same idempotent behaviour for `setMyAreas` (upsert by `(business_id, lower(suburb))`) and `setMyHours` (upsert by `(business_id, day_of_week)` — already effectively per-day).
- Delete `DEFAULT_TENANT` fallback from `AppShell` (fail closed to "Set up your account" instead of Richmond copy).
- Remove `richmond-rapid-plumbing` as `resolveBusinessId` default. Require callers to pass a slug or throw. Update `db-leads`, `sms`, `demo.trigger-sms`, `webhooks.ai-phone-lead` to require an explicit tenant.

Migrations
- `businesses`: add `onboarding_step smallint not null default 0`, `onboarding_state jsonb not null default '{}'::jsonb`.
- `business_service_areas`: add `unique (business_id, lower(suburb))` if not already present.
- `business_services`: confirm `unique (business_id, service_key)` (should already exist from seed defaults).

Tests
- Unit: wizard idempotency (revisit step 2 with only `Hot Water` disabled → only that row deleted, others preserved).
- Unit: `resolveBusinessId` with no slug throws.
- Regression: existing 104 tests remain green.

Go/no-go
- ✅ Two synthetic tenants can complete onboarding in parallel and see each other's data nowhere.
- ✅ Resuming after every step lands on the correct next step and no earlier state is lost.
- ✅ Removing `DEFAULT_TENANT` doesn't blank any authenticated screen (grep for `<AppShell` without `tenant=`).

### Phase 2G.2 — Logo upload, trade type, review step

Scope
- Storage bucket `business-assets` (private, tenant-scoped path `business_id/logo.<ext>`), signed uploads via a server fn, MIME + size validation.
- Wizard step 1: replace URL field with `<input type="file">` → server-fn upload → returns public URL → written to `businesses.logo_url`.
- Add `trade_type` enum on `businesses` (`plumbing`, `electrical`, `hvac`, `locksmith`, `general_handyman` — start with `plumbing` only, others as inactive placeholders), per-trade default service list.
- Add a Review step (step 7) rendering all captured data + link to `/b/:slug` preview in a new tab before `completeOnboarding`.

Migrations
- `businesses`: add `trade_type text not null default 'plumbing' check (...)`.
- Storage: create bucket, policies (owner can read/write files under their business_id prefix; anon can read logos).

Go/no-go
- ✅ Two tenants uploading logos never see each other's files (storage RLS test).
- ✅ Preview link renders the new tenant's real settings before activation.

### Phase 2G.3 — Notification recipients & booking preferences

Scope
- `business_notification_recipients` table (business_id, method sms|email, target, events jsonb array, active).
- Wizard step for recipients + a "who gets alerted for what" matrix.
- Booking preferences on `businesses` (`callback_sla_minutes`, `accept_after_hours`, `preferred_callback_window`).
- Wire `missed-call.functions` and Vapi webhook to fan-out via this table.

### Phase 2G.4 — Telephony provisioning & AI receptionist config in the wizard

Scope
- Wizard steps for AI receptionist name/voice/tone/greeting/business instructions (reuse existing `ai-receptionist.functions`).
- Telephony state UI: show current provisioning status, allow "connect existing number" (forwarding target) vs "provision new" (deferred to Phase 2G.5).
- Do NOT purchase real numbers here.

### Phase 2G.5 — Payment method + activation gate

Scope
- Replace `setMyPlan → completeOnboarding` with `setMyPlan → checkout(SetupIntent) → activate`.
- `completeOnboarding` requires either a valid Stripe payment method attached OR `billing_exempt=true`.
- Union Member Offer flow: still $0 today, but a card must be captured for the second month.

Go/no-go for 2G overall
- ✅ Full end-to-end: three brand-new plumber accounts sign up, onboard, activate, and receive test missed-call + AI-lead traffic that never crosses tenants.
- ✅ No hardcoded Richmond default remains in any unauth write path or authenticated UI shell.
- ✅ Resume from any step, on any device, restores exact state.

---

## 8. Files likely to change in the first slice (Phase 2G.1)

Server / DB
- `supabase/migrations/<new>.sql` — add `onboarding_step`, `onboarding_state`; add unique constraints on services/areas if missing.
- `src/integrations/supabase/types.ts` — regenerated after migration.
- `src/lib/onboarding.functions.ts` — Zod validators; idempotent `setMyServices`/`setMyAreas`/`setMyHours`; add `setOnboardingStep`.
- `src/lib/tenant.ts` — remove default slug fallback; new `requireBusinessIdBySlug`.
- `src/lib/db-leads.ts` — require explicit tenant, no fallback.
- `src/lib/sms.ts` — require explicit tenant.
- `src/lib/business-settings.functions.ts` — no change expected (already RLS-clean).

Routes
- `src/routes/_authenticated/onboarding.tsx` — hydrate services/areas/hours from server on resume; persist `onboarding_step` after each save.
- `src/routes/api/demo.trigger-sms.ts` — require slug; drop default.
- `src/routes/api/webhooks.ai-phone-lead.ts` — require resolved tenant; drop the `'Richmond'` suburb fallback (leave the field null).

UI
- `src/components/AppShell.tsx` — remove `DEFAULT_TENANT`; render a neutral placeholder if no tenant is provided in authenticated context.
- `src/hooks/use-my-tenant-brand.ts` — optionally return a stable "Loading…" brand instead of `undefined` to avoid Richmond flash (mostly moot once fallback is gone).

Tests
- `src/lib/__tests__/onboarding-idempotency.test.ts` (new) — services/areas/hours diff behaviour.
- `src/lib/__tests__/tenant-resolution.test.ts` (new) — `resolveBusinessId` no longer defaults.
- Existing 104 tests: all must remain green.

Nothing about Phase 2A→3C behaviour changes: the DB shape stays additive, the AI receptionist / billing / enrichment code is untouched, and RLS boundaries are only tightened (never widened).

---

## Assumptions I'm making (please correct any before we start slicing)

- The demo top-level marketing site (`/`, `/services/*`, `/areas`, `/chat`, `/request`, `/missed-call`) will remain a Richmond demo for now, and multi-customer traffic goes through `/b/:slug`. Neutralising the top-level pages is a separate phase, not part of 2G.1.
- Plumbing stays the only live trade. Trade-type is scaffolded but no additional trades are activated in 2G.
- Storage bucket for logos is acceptable as a Phase 2G.2 dependency; we don't try to solve logo upload inside the first slice.
- The Union Member Offer copy is authoritative: a payment method IS required to activate (contradicting the "no card required" copy currently in the wizard). Payment method capture is 2G.5.
