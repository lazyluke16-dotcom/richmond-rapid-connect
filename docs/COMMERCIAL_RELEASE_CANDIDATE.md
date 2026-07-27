# Commercial release-candidate checkpoint

Status: local source certification only. Hosted staging and production are not certified or changed by this work.

## Frozen migration chain

`supabase/migration-manifest.json` is the machine-readable source of truth. `npm run verify:migrations` fails unless:

- every SQL file under `supabase/migrations` is listed once, in strict timestamp order;
- every SHA-256 digest matches;
- every declared dependency precedes its dependent migration; and
- no SQL file remains under `supabase/migrations-pending`.

Staging deployment order is exactly the manifest's `migrations` array, from
`20260711045456_3cca7ee8-e722-4172-aaaf-15790bc18c91.sql` through
`20260728120000_commercial_sms_invoicing.sql`. Do not select a subset for a fresh database.

The former pending artifacts were resolved as follows:

- `20260722100000_phase2g1_onboarding_step.sql` was required but absent from the committed chain. It is promoted as `20260728100000_onboarding_step.sql` so upgrades do not require an out-of-order version.
- `20260722200000_phase1_coverage_and_licence.sql` was fully superseded by committed migration `20260722201335_2f2ef531-beda-47b2-8745-979b1da71158.sql` and was removed. It must not be executed.
- The required call-handling, durable dispatch, and billable-SMS migrations retain their ordered timestamps `20260725160000`, `20260726120000`, and `20260727120000`.
- Commercial SMS invoicing follows them at `20260728120000`.

Git history remains the recovery source for removed pending artifacts.

## Exact commercial billing trigger

The charge originates only in `complete_text_link_dispatch`, after a Twilio message SID proves provider acceptance. That transaction creates the durable SMS audit record, marks the missed call, completes the provider event, and inserts one immutable `billing_usage_events` row:

- `usage_type=outbound_sms`
- `provider=twilio`
- provider SID and tenant/provider-event audit metadata
- `quantity=1`, `unit=message`
- `customer_rate_minor=25`
- `estimated_customer_charge_minor=25`
- `customer_rate_currency=AUD`
- `billable=true`
- `stripe_meter_event_status=skipped`
- `tax_behavior=exclusive`
- `billing_collection=invoice_aggregation`

The unique provider/workflow identity prevents a second usage row. Rejected, invalid, missing-caller, cross-tenant, pre-provider, and unresolved attempts never reach this trigger. A reconciliation-confirmed SID reaches the same trigger once. A later `undelivered` status does not reverse provider acceptance or its incurred charge.

## Invoice and GST architecture

`claim_sms_invoice_batch` selects only eligible, unbilled Text Link SMS events for one business and a deterministic half-open period `[period_start, period_end)`. It:

- serializes concurrent workers for the tenant and period;
- inserts one `sms_invoice_lines` row per usage event, protected by a unique `usage_event_id`;
- freezes the selected lines and a stable provider idempotency key;
- sums integer AUD cents;
- applies 10% GST once to the aggregate subtotal using deterministic half-up minor-unit rounding; and
- carries still-unbilled older events into the next open batch, marked `carried_forward=true`.

One SMS therefore has a 25-cent ex-GST subtotal and a 3-cent rounded batch GST amount. Four SMS messages have a 100-cent ex-GST subtotal and 10-cent GST. GST is never embedded into the 25-cent usage event.

The application validates every line, tenant, SID, currency, unit price, subtotal, GST, and total again before the provider boundary. Missing Stripe customer configuration fails before provider access. Stale or failed work reuses the frozen batch.

The Stripe adapter:

- is available only behind explicit non-production staging and Stripe test-mode guards;
- creates an unfinalized draft invoice with `auto_advance=false`;
- creates one 25-cent-times-quantity base invoice item;
- applies a preconfigured exclusive 10% GST tax rate once at the invoice boundary;
- disables discounts on the SMS item;
- uses stable idempotency keys for both draft and item creation; and
- never finalizes, pays, or charges the invoice.

The release candidate exposes that adapter only through the authenticated
staging certification route `/api/public/process-sms-invoice`. The route is
disabled unless the application has an explicit non-production staging
identity, the staging execution confirmation, Stripe test mode, and a
dedicated processor key. Each request repeats the exact environment identity
and selects one UUID tenant and one canonical UTC period of at most 32 days.
Production-like targets, malformed periods, wrong tenants, missing keys, and
raw provider errors fail closed.

If provider acceptance succeeds but local completion is interrupted, the batch remains reconcilable. A retry uses the same idempotency keys. Failed provider creation can also be retried without selecting new lines. Provider invoice, customer, batch, period, tenant, usage event, and Twilio SID remain linked.

SMS events never enter `ai_voice_seconds` or the `ai_voice_seconds` Stripe meter. AI voice and lead events do not satisfy SMS invoice eligibility. Existing subscription, grace, union-coupon, payment-webhook, and voice-meter paths are unchanged. The repository has no existing automatic SMS credit/reversal convention; this release candidate does not silently mutate or negate accepted usage. Any future adjustment must be an append-only, separately approved and auditable convention.

## Local deterministic certification

Run:

```text
npm run certify:local
```

This executes manifest integrity, durable webhook/Text Link behaviour, onboarding phone continuity, and commercial invoice behaviour. The full release gate additionally runs all tests, TypeScript, the production build, changed-file lint/format checks, migration replays, schema comparison, diff/credential scans, and dependency audit.

GitHub Actions repeats the source gates on every release-candidate branch push
and publishes the exact `.output` Cloudflare build as an immutable,
SHA-addressed artifact. The workflow has read-only repository permissions and
contains no deployment or hosted-provider step.

Local tests cover accepted, rejected, uncertain and reconciled provider outcomes; later undelivered status; Off/Text Link/AI routing; duplicate and cross-tenant webhooks; missing caller ID; questionnaire tenant selection; usage and audit linkage; one and four-message invoice aggregation; GST; concurrency; provider and persistence interruption; fixed cutoff; late arrival; AI exclusion; and same/new-tab onboarding continuity.

## Staging prerequisites

Before hosted execution, Lucas or the staging operator must provide:

- a dedicated staging deployment and Supabase project, neither shared with production;
- the exact release-candidate SHA and complete frozen migration chain;
- fixture tenants for Off, Text Link, AI, and cross-tenant tests;
- staging-only Vapi/Twilio routing and controlled rejection/timeout/reconciliation fixtures;
- a Stripe test customer for each billing fixture;
- a Stripe test-mode 10% exclusive Australian GST tax-rate ID;
- a staging hostname and project reference recorded out of band; and
- secrets injected through the staging secret store, never source or command arguments.

No production provider object, number, tenant, Stripe customer, price, invoice, or credential may be reused.

## Rollback and recovery

Before provider submission, a failed/stale claim is safely reclaimable. After an uncertain provider boundary, retry only with the same batch and idempotency key; do not create a new batch or invoice manually. Preserve batch, line, usage, provider-event, SMS, and SID records for audit.

For staging application rollback:

1. Stop the staging invoice worker.
2. Set the affected staging tenant's call-handling mode to Off.
3. Roll the staging application back to the prior approved SHA without rewriting Git history.
4. Leave migrations and audit rows in place.
5. Inspect any `submitting` batch and its stable provider idempotency key before retrying.
6. Void an unfinalized staging Stripe draft only after its local batch is identified and the action is recorded; do not delete ledger rows.

Production rollback requires a separately approved live runbook. Nothing here certifies it.

## Certification boundary

- Locally certified: source behaviour, migration-chain determinism, database migration behaviour, fake/provider-boundary idempotency, TypeScript/build/lint/format/security gates recorded in the release evidence.
- Staging still required: hosted migrations, real staging tenancy, Vapi/Twilio controlled outcomes, carrier/provider timing, Stripe test draft/tax rendering, hosted signup email-confirmation, and job-card recovery.
- Production not certified: no production deployment, hosted database change, live provider contact, Stripe live invoice, charge, or configuration change has occurred.
