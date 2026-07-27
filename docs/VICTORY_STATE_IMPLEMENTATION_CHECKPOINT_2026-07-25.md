# Customer Call Handling Reconstruction Checkpoint — 2026-07-25

## Release identity

- Repository: `lazyluke16-dotcom/richmond-rapid-connect`
- Branch: `feat/customer-call-handling-reconstructed`
- Verified base: `fb90a72331d7108ee0e2172d8cb61dd14c2a85fa`
- Production deployment: not performed
- Live migration: not applied
- Lovable/provider configuration: not changed

The missing historical commits and branches were not recoverable. This branch is a clean-room reconstruction from the verified GitHub base and the preserved functional prose.

## Audited baseline

The repository already contained:

- authenticated signup/onboarding, business profile storage, plans, and Stripe billing;
- tenant-scoped Text Link settings and a slug-based Twilio missed-call callback;
- tenant questionnaires and Job Centre lead creation;
- AI receptionist settings, Vapi provisioning, trusted provider mappings, end-of-call lead creation, enrichment, exact voice usage, and Stripe metering;
- lead and usage uniqueness constraints;
- RLS-based dashboard isolation and owner/admin checks for provider provisioning.

The critical gap was split routing authority: Text Link and AI had independent `enabled` and `mode` fields. Provider routing was not dynamically resolved from a customer-allocated platform number.

## Reconstructed behavior

### Signup and business number

Signup and onboarding now require a valid Australian business number. The server normalizes Australian mobile, geographic, 13, 1300, and 1800 formats to E.164. The browser is not authoritative.

### Entitlements versus routing

The existing AI subscription continues to include both Text Link and AI Receptionist entitlement. The active route is separately controlled by `business_telephony_settings.answering_mode`:

- `off`
- `text_link`
- `ai_receptionist`

Only an owner or administrator can change it. The database RPC updates the legacy flags atomically, and deferred constraint triggers reject inconsistent or both-active states.

### Number inventory and forwarding

`platform_phone_inventory` contains only platform-admin-provisioned numbers. Customer allocation:

- requires a normalized Australian business number;
- chooses an available voice-and-SMS-capable row by lowest recorded monthly cost;
- uses `FOR UPDATE SKIP LOCKED`;
- prevents duplicate reservation/assignment by unique indexes;
- never purchases or imports a carrier number.

Forwarding verification requires the customer to start a 15-minute window and then make a real call that reaches the allocated platform number. Live Text Link or AI mode cannot be selected before verification.

### Dynamic inbound routing

Vapi `assistant-request` resolves the inbound provider phone ID/number to the allocated tenant:

- Off returns no customer workflow.
- Text Link uses a leased provider-event state machine. It speaks confirmation only after Twilio acceptance and transactional persistence; concurrent or uncertain attempts receive a truthful reconciliation message.
- AI Receptionist returns the tenant’s existing trusted assistant ID.

The existing Vapi end-of-call lead, enrichment, exact-second usage, grace handling, and Stripe metering sequence remains in place. It now additionally requires the central AI mode and current AI entitlement before any AI lead or voice usage write.

The generic AI lead webhook has the same central AI gate.

### Questionnaire and tenant isolation

The questionnaire still resolves the tenant from the public business slug. A Text Link submission now fails closed when its missed-call ID is absent, fabricated, or belongs to another tenant; it no longer creates an unattributed job card after a mismatch.

### Usage

Recovery SMS creates `outbound_sms` usage with:

- quantity `1`;
- `billable=true`;
- customer unit price and estimated base charge `25` integer AUD cents (`0.25` in the existing major-unit compatibility fields);
- GST-exclusive tax metadata so the invoicing/tax layer applies GST;
- the tenant, Twilio SID, SMS audit ID, and durable provider-event identity;
- Stripe meter status `skipped`, because the existing meter is AI voice-seconds-only and this phase does not trigger customer billing.

Billing and Call Handling views expose the settled A$0.25 excluding GST price. SMS invoice aggregation sums integer minor units, while existing AI usage behavior remains separate and unchanged behind the AI gate.

### Customer UI

The new Call Handling page is the only customer routing control. It shows:

- the existing Australian business number;
- allocated platform number and verification state;
- one active-mode selector;
- service entitlements;
- AI and SMS usage visibility.

The Text Link and AI pages remain configuration surfaces but no longer expose independent routing switches.

## Database change

Call-handling migration:

`supabase/migrations/20260725160000_customer_call_handling.sql`

Hardening migration:

`supabase/migrations/20260726120000_text_link_dispatch_hardening.sql`

SMS pricing migration:

`supabase/migrations/20260727120000_text_link_sms_billable.sql`

Onboarding continuity migration:

`supabase/migrations/20260728100000_onboarding_step.sql`

Commercial invoice migration:

`supabase/migrations/20260728120000_commercial_sms_invoicing.sql`

The complete 28-file deployment order and hashes are frozen in
`supabase/migration-manifest.json`. No hosted migration was applied. The
stable-record backfill contains no hard-coded production tenant, assistant,
phone, call, lead, or billing-event ID.

The second migration adds atomic claim, begin-send, reconciliation, retry, failure, and completion transitions. The third replaces the provisional non-billable policy: completion now persists the provider SID, SMS audit, missed-call state, and exactly one billable 25-cent AUD usage row in one transaction. Leases permit stale pre-send recovery; uncertain provider outcomes must reconcile by the original destination, sender, unique body, and send time before a resend is allowed. A reconciled Twilio SID proves provider acceptance even if its later delivery status is `undelivered`, so the incurred provider-cost event remains chargeable.

## Verification checkpoint

Current source verification:

- full Vitest suite: 311 tests passing across 20 files;
- TypeScript `tsc --noEmit`: passing;
- production Vite/Nitro build: passing with `LOCAL_BUILD_DISABLE_MCP_PLUGIN=1` on the Windows linked worktree;
- changed-file ESLint and Prettier checks: passing;
- `git diff --check`: passing.

The repository-wide `npm run lint` remains blocked by 2,798 pre-existing Prettier errors in recovered, untouched source files. The Windows line-ending false positives were removed by setting Prettier `endOfLine` to `auto`, but the remaining quote, semicolon, and wrapping differences would require a broad unrelated reformat. No such reformat was included in this hardening change.

The environment flag bypasses only `@lovable.dev/mcp-js` route generation on Windows because version 0.24.0 compares mixed slash styles before Vite starts. The committed MCP routes remain present, and normal Lovable/Linux builds retain the plugin.

Local database verification was completed on 2026-07-26 with WSL 2.7.11, Docker Desktop 4.83.0 / Engine 29.6.2, PostgreSQL 17.6.1.143, and the project-pinned Supabase CLI 2.109.1.

The settled billable SMS policy was verified on 2026-07-27 using the same local toolchain. No customer invoice, Stripe meter event, or live provider operation was triggered.

- Fresh replay: all 28 frozen migrations applied to an empty disposable database.
- Upgrade replay: the 23-migration baseline was seeded with trusted AI, live Text Link, and Off fixtures before migrations 24 through 28 were applied by `supabase migration up --local`. AI, Text Link, and Off were preserved correctly.
- Fresh and upgraded schemas produced the same 1,135-component semantic fingerprint, `80c4edd480b13442d60e0c3842669fa8`, covering columns, constraints, functions, grants, indexes, policies, relations, triggers, and views.
- Database assertions exercised concurrent claim exclusion, frozen retry identity, one and four-message aggregation, 25-cent AUD lines, aggregate GST, deterministic cut-off, late carry-forward, provider SID preservation, exact tenant attribution, AI-meter exclusion, rejected/unresolved exclusion, and exactly-once invoice linkage.
- Behavioural Vitest coverage invokes the real Vapi webhook and dispatch/provider code with controlled database and Twilio boundaries. It covers Off, Text Link, AI routing, successful 25-cent dispatch, concurrent duplicates, stale claims, post-provider persistence interruption, provider rejection, uncertain outcome without charge, reconciliation-confirmed charge, missing caller ID, tenant-specific links, cross-tenant replay rejection, single-segment enforcement, usage isolation, and no Text Link AI lead/voice usage.
- Signup phone continuity uses validated same-tab `sessionStorage` first and otherwise validated authenticated JWT metadata. Existing tenant-scoped business data remains authoritative on resume; malformed metadata is ignored.
- The first fresh replay exposed an older recovered migration that unconditionally inserted a production-specific Vapi mapping. That migration is now guarded by the existence of its historical business row, preserving its behavior for the intended row while making clean replays safe.
- No Supabase login, link, pull, push, hosted database, Lovable, Vapi, Twilio, or Stripe operation was used.

Controlled staging migration execution, real Vapi deadline observation, Twilio reconciliation observation, and live backfill verification remain external prerequisites. Local source and disposable-database verification do not certify hosted or provider state.

The 2026-07-27 read-only production dependency audit reports four existing advisories (one low, three moderate) in the unchanged `@lovable.dev/mcp-js` chain: `@hono/node-server`, `@modelcontextprotocol/sdk`, and esbuild. The full audit additionally reports five high development-only findings through the unchanged ESLint/minimatch/brace-expansion chain. This release candidate changes no dependency or lockfile entry, so it introduces zero new dependency findings. No forced override or automatic audit fix was applied. Local Supabase and Vite services must remain unexposed, and these advisories must be rechecked before release.

## Differences from the preserved functional documents

- This reconstruction has a different commit history because the referenced historical commits did not exist.
- The test total is based on the reconstructed repository, not the preserved document’s claimed count.
- Forwarding verification is tightened to a customer-initiated 15-minute window.
- Invalid cross-tenant questionnaire attribution is rejected rather than silently removed.
- A local Windows-only MCP build workaround is documented.
- No live migration, deploy, provider mutation, number purchase, or live certification is claimed.

## Remaining external prerequisites

1. Verify and execute the complete frozen migration manifest in a controlled staging database environment.
2. Verify the guarded backfill preserves the proven voice tenant.
3. Populate approved spare Australian voice-and-SMS numbers in inventory without changing existing assignments.
4. Configure those spare Vapi phone resources for dynamic `assistant-request`.
5. Verify all encrypted production secret names from the deployment runbook.
6. Deploy the exact approved source commit.
7. Run the ordered live certification in `docs/CALL_HANDLING_DEPLOYMENT.md`.

The branch is ready for source review only until those steps are completed.
