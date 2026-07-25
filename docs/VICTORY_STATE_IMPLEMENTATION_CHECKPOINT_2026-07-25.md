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
- Text Link claims the provider event, creates a tenant-scoped missed-call row, sends one recovery SMS, records non-billable SMS usage, and returns a spoken completion response.
- AI Receptionist returns the tenant’s existing trusted assistant ID.

The existing Vapi end-of-call lead, enrichment, exact-second usage, grace handling, and Stripe metering sequence remains in place. It now additionally requires the central AI mode and current AI entitlement before any AI lead or voice usage write.

The generic AI lead webhook has the same central AI gate.

### Questionnaire and tenant isolation

The questionnaire still resolves the tenant from the public business slug. A Text Link submission now fails closed when its missed-call ID is absent, fabricated, or belongs to another tenant; it no longer creates an unattributed job card after a mismatch.

### Usage

Recovery SMS creates `outbound_sms` usage with:

- quantity `1`;
- `billable=false`;
- `non_billable_reason='sms_retail_pricing_unapproved'`;
- Stripe meter status `skipped`.

Billing and Call Handling views expose SMS counts without inventing a customer SMS price. Existing AI usage behavior remains unchanged behind the new gate.

### Customer UI

The new Call Handling page is the only customer routing control. It shows:

- the existing Australian business number;
- allocated platform number and verification state;
- one active-mode selector;
- service entitlements;
- AI and SMS usage visibility.

The Text Link and AI pages remain configuration surfaces but no longer expose independent routing switches.

## Database change

Pending migration:

`supabase/migrations-pending/20260725160000_customer_call_handling.sql`

It is intentionally unapplied. Its stable-record backfill contains no hard-coded production tenant, assistant, phone, call, lead, or billing-event ID.

## Verification checkpoint

Current source verification:

- full Vitest suite: 269 tests passing across 15 files;
- TypeScript `tsc --noEmit`: passing;
- production Vite/Nitro build: passing with `LOCAL_BUILD_DISABLE_MCP_PLUGIN=1` on the Windows linked worktree;
- changed-file lint and final Git checks: to be recorded before publication.

The environment flag bypasses only `@lovable.dev/mcp-js` route generation on Windows because version 0.24.0 compares mixed slash styles before Vite starts. The committed MCP routes remain present, and normal Lovable/Linux builds retain the plugin.

No local PostgreSQL runtime was available, so the migration has static regression coverage but has not been executed against a local database. Controlled staging migration execution is an external prerequisite.

## Differences from the preserved functional documents

- This reconstruction has a different commit history because the referenced historical commits did not exist.
- The test total is based on the reconstructed repository, not the preserved document’s claimed count.
- Forwarding verification is tightened to a customer-initiated 15-minute window.
- Invalid cross-tenant questionnaire attribution is rejected rather than silently removed.
- A local Windows-only MCP build workaround is documented.
- No live migration, deploy, provider mutation, number purchase, or live certification is claimed.

## Remaining external prerequisites

1. Review and execute the pending migration in a controlled database environment.
2. Verify the guarded backfill preserves the proven voice tenant.
3. Populate approved spare Australian voice-and-SMS numbers in inventory without changing existing assignments.
4. Configure those spare Vapi phone resources for dynamic `assistant-request`.
5. Verify all encrypted production secret names from the deployment runbook.
6. Deploy the exact approved source commit.
7. Run the ordered live certification in `docs/CALL_HANDLING_DEPLOYMENT.md`.

The branch is ready for source review only until those steps are completed.
