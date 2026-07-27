# Staging certification runbook

This runbook is staging-only. It does not authorize production access, deployment, provider changes, invoice finalization, or customer charging.

## 1. Local checks first

From the exact release-candidate checkout:

```text
npm run certify:local
npm run certify:staging -- --plan
```

The plan command performs no network access and lists every certification case.

## 2. Inject staging values safely

Set values only in the operator's ephemeral process environment or approved staging secret store. Do not paste them into source, documentation, shell arguments, screenshots, evidence, or logs.

Required preflight names:

- `CERTIFICATION_TARGET=staging`
- `CERTIFICATION_ENVIRONMENT_ID` beginning with `staging-` or `staging_`
- `CERTIFICATION_BASE_URL`
- `CERTIFICATION_STAGING_HOSTNAME`, exactly matching the base URL hostname and containing `staging`
- `STAGING_SUPABASE_URL`
- `STAGING_SUPABASE_PROJECT_REF`, exactly matching the Supabase URL hostname
- `STAGING_SUPABASE_SERVICE_ROLE_KEY`
- `VAPI_SERVER_SECRET`

Webhook cases additionally use:

- `CERTIFICATION_OFF_PHONE_ID`
- `CERTIFICATION_TEXT_LINK_PHONE_ID`
- `CERTIFICATION_AI_PHONE_ID`
- `CERTIFICATION_OTHER_TENANT_PHONE_ID`
- `CERTIFICATION_CALLER_E164`

Stripe draft certification additionally requires `STRIPE_MODE=test`, a test secret key, and `STRIPE_SMS_GST_TAX_RATE_ID` for a preconfigured 10% exclusive Australian GST rate.

Run the no-network validation:

```text
npm run certify:staging -- --preflight --environment-id <exact-staging-id>
```

The harness rejects HTTP, hostname mismatch, missing identifiers, mismatched Supabase project references, and production-like/live targets. It never prints credential values.

## 3. Prepare isolated fixtures

Apply every migration in `supabase/migration-manifest.json` to an empty staging database in order. Verify the manifest SHA before and after transfer. Create dedicated, disposable fixture tenants:

- Off with its own mapped staging phone;
- Text Link with an isolated questionnaire slug and Twilio test/staging sender;
- AI Receptionist with its own staging assistant mapping;
- a second tenant for replay rejection.

Use unique caller and call IDs. Never use a production tenant, provider mapping, phone number, customer, or subscription. Configure provider rejection, timeout/uncertain, reconciliation-accepted, and later-undelivered scenarios one at a time. Record the active fixture state without recording credentials.

## 4. Enable one hosted command explicitly

Network execution is disabled unless all preflight variables pass, the exact environment ID is supplied twice, and:

```text
STAGING_CERTIFICATION_EXECUTE=I_UNDERSTAND_STAGING_ONLY
```

Then run one case at a time:

```text
npm run certify:staging -- --execute-webhook text_link_accepted --environment-id <exact-staging-id>
```

Supported webhook commands are `off`, `text_link_accepted`, `ai_receptionist`, `duplicate_webhook`, `provider_rejected`, `provider_uncertain`, `reconciliation_accepted`, `later_undelivered`, `missing_caller_id`, and `cross_tenant_replay`.

For the four controlled provider outcomes, set `CERTIFICATION_PROVIDER_SCENARIO` to the exact case only after confirming the matching staging provider fixture is active. The harness refuses otherwise. Output contains only call ID, HTTP status, response key names, and booleans—not secrets or raw provider responses.

## 5. Evidence assertions

For each case, query the staging database through an approved read-only evidence session. Parameterize the tenant and call ID; never paste service-role keys into SQL or saved files.

Confirm:

- Off: no provider event that sends, no SMS, no SMS usage, no AI usage or lead.
- Text Link accepted: exactly one sent provider event, SMS record, missed-call linkage, Twilio SID, 25-cent billable AUD usage row, correct questionnaire URL/slug, and no AI lead/voice usage.
- Duplicate: the two deliveries retain one provider event, one SID, one SMS, and one usage event.
- Rejected and uncertain: no SMS invoice-eligible usage. Uncertain remains reconciling.
- Reconciled acceptance: the original event becomes sent with one SID and one usage event, without a second provider send.
- Later undelivered: accepted usage and its charge remain unchanged.
- Missing caller and cross-tenant replay: no SMS usage or invoice line; cross-tenant delivery is rejected.
- AI: correct tenant assistant is returned; no Text Link SMS or SMS charge.

Run the staging invoice worker for a fixed UTC half-open period with a test customer. Run two workers concurrently. Confirm one batch, one line per eligible usage event, one provider draft, and one provider invoice ID. For four events, confirm base `100`, GST `10`, and total `110` minor units. Confirm the Stripe draft has one tax-exclusive base item, one 10% tax application, no discount, and is neither finalized nor paid.

Repeat after a simulated provider error and after interruption between provider draft creation and local completion. Confirm the same batch and idempotency keys are reused. Insert an eligible fixture timestamped exactly at the period end and confirm exclusion; process the next period and confirm inclusion. Add an older unbilled fixture and confirm `carried_forward=true`.

Confirm no SMS usage has a pending/sent AI voice meter status or meter identifier, and no AI voice/lead event appears in `sms_invoice_lines`.

## 6. Browser and job-card cases

Using staging-only email identities:

1. Complete signup in the same tab with a valid business phone.
2. Repeat with email confirmation opening a new tab; confirm authenticated metadata restores the validated phone when session storage is unavailable.
3. Try malformed phone metadata and confirm it is ignored.
4. Resume an existing business and confirm server-owned phone/tenant data wins.
5. Complete the Text Link questionnaire and confirm the job card appears only in the expected tenant.
6. Simulate the supported job/enrichment persistence interruption and replay; confirm the missing job-card/enrichment record is repaired without a duplicate lead.

## 7. Stop conditions and completion

Stop on any target ambiguity, production-like identifier, unexpected provider mapping, second SMS/SID/usage/invoice, cross-tenant row, GST mismatch, AI meter contamination, finalized/paid invoice, or credential exposure.

After certification, disable hosted execution, remove disposable fixture data according to the staging retention policy, and preserve non-secret evidence keyed by release SHA and case/call IDs. Hosted staging success still does not certify production.
