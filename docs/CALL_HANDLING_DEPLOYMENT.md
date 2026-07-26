# Customer Call Handling Deployment

Status: source release only. This document is an operator runbook, not evidence that production has been changed or certified.

## 1. Publish the source branch

Publish only `feat/customer-call-handling-reconstructed` to the connected GitHub repository. Do not merge it into `main`, rewrite published history, or deploy it until the controlled release is approved.

The application commit and this runbook must remain synchronized. Record the selected commit SHA in the deployment ticket before any database or provider action.

## 2. Apply the database migration first

Apply:

`supabase/migrations-pending/20260725160000_customer_call_handling.sql`

The migration must complete before the application is deployed. It adds:

- the authoritative `off`, `text_link`, and `ai_receptionist` mode;
- database enforcement preventing two customer workflows from being active;
- owner/admin-only routing functions;
- pre-provisioned number inventory and concurrency-safe reservation;
- forwarding verification state and a 15-minute verification window;
- trusted number-to-tenant resolution;
- provider-event replay protection.

The guarded backfill selects AI only when an existing enabled/live/active assistant has a matching active provider mapping. It selects Text Link only when the existing recovery configuration is enabled/live. Ambiguous rows become Off. It contains no production tenant, assistant, phone, call, lead, or billing-event ID.

After applying the migration, verify the proven tenant’s central mode and legacy mirror flags in one read-only transaction before deploying. Stop if the mode does not match the existing proven route.

## 3. Configure required production secrets

Store server secrets only in Lovable’s encrypted production Secrets system. Never place values in source, browser variables, logs, screenshots, tickets, or this document. Keep test and live Stripe values in separate environments.

Required application/runtime names:

- `SUPABASE_URL`
- `SUPABASE_PUBLISHABLE_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `PUBLIC_JOB_REQUEST_URL`
- `VAPI_API_KEY`
- `VAPI_SERVER_SECRET`
- `VAPI_SERVER_CREDENTIAL_ID`
- `SMS_MODE`
- `TWILIO_ACCOUNT_SID`
- `TWILIO_AUTH_TOKEN`
- `TWILIO_FROM_NUMBER`
- `STRIPE_MODE`
- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `STRIPE_PRICE_MCR_BASE`
- `STRIPE_PRICE_AIR_BASE`
- `STRIPE_PRICE_AIR_USAGE`

Conditionally required:

- `VAPI_WEBHOOK_URL` when the Vapi callback is not derived from `PUBLIC_JOB_REQUEST_URL`;
- `STRIPE_CONTEXT` when `STRIPE_SECRET_KEY` is an organization API key;
- `STRIPE_COUPON_UNION_FIRST_PLATFORM_FEE` only while the approved union offer is active;
- `WEBHOOK_SECRET` while the generic AI lead endpoint remains enabled;
- `OUTBOUND_WEBHOOK_URL` only when an approved downstream lead automation is used;
- `DEMO_PLUMBER_PHONE` only for the existing demo notification path.

Production values must use `SMS_MODE=twilio` and `STRIPE_MODE=live`. `LOCAL_BUILD_DISABLE_MCP_PLUGIN` is a local Windows build workaround, not a production secret or production setting.

## 4. Respect the Vapi/Twilio boundary

The application allocates only records already present in `platform_phone_inventory`. Carrier purchase/import, Australian regulatory approval, emergency-address obligations, and provider ownership remain platform-administrator work.

For each approved spare number:

1. Confirm it is dedicated to this Plumbing application and is both voice- and SMS-capable.
2. Import or connect it to Vapi using the approved Twilio account.
3. Remove any fixed Vapi assistant assignment from the spare number.
4. Set the Vapi phone-number server URL to the production `/api/public/webhooks/vapi-inbound` endpoint.
5. Ensure Vapi sends the encrypted `X-Vapi-Secret` credential represented by `VAPI_SERVER_CREDENTIAL_ID`.
6. Insert the provider, provider phone ID, normalized phone number, capabilities, and approved monthly cost into `platform_phone_inventory`.

Vapi sends `assistant-request`; the server resolves the allocated number and returns the existing tenant assistant only for AI mode. Text Link sends one deduplicated recovery SMS and returns a spoken completion message. Off returns no customer workflow.

Do not expose provider IDs in customer UI. Do not let the browser select a tenant, assistant, price, or provider mapping.

## 5. Maintain spare Australian-number inventory

Keep at least one approved, unassigned Australian voice-and-SMS number in `platform_phone_inventory` with `status='available'`. Customer reservation uses `FOR UPDATE SKIP LOCKED`, chooses the lowest stored monthly cost, and never purchases a number.

Review reserved and assigned rows operationally. Do not recycle a reserved or assigned number until an administrator has confirmed that carrier forwarding is removed and the tenant relationship is closed.

## 6. Preserve the proven platform number

Preserve `+61 485 020 780` and its current Twilio/Vapi route. Do not disconnect it, reassign it, change its provider mapping, or use it as spare inventory during this release.

The migration’s backfill is based on stable database relationships rather than this number. A missing or unexpected proven record is a stop condition, not permission to manufacture a replacement mapping.

## 7. Deploy the application explicitly

After the migration, secret verification, provider inventory, and read-only backfill checks:

1. Deploy the exact approved GitHub commit.
2. Confirm the application health check and authenticated Job Centre load.
3. Confirm the public customer website and questionnaire load for the certification tenant.
4. Confirm webhook endpoints reject missing/invalid signatures or secrets.
5. Record the deployment version and timestamp.

A Git push or Lovable synchronization is not an application deployment.

## 8. Live certification order

Use a dedicated certification tenant and a new caller number. Run in this order:

### Off

1. Set Call Handling to Off.
2. Call the customer’s existing number and allow carrier forwarding.
3. Confirm neither a recovery SMS nor an AI lead/voice usage record is created.

### Text Link

1. Save the customer’s normalized Australian business number.
2. Reserve a spare platform number.
3. Configure no-answer forwarding with the customer’s carrier.
4. Start the 15-minute verification window.
5. Make a real call to the customer’s existing number and allow it to forward.
6. Confirm forwarding becomes verified.
7. Select Text Link.
8. Make a new missed/forwarded call.
9. Confirm exactly one SMS contains the tenant questionnaire link.
10. Complete the questionnaire and confirm the job card appears only in that tenant’s Job Centre.
11. Confirm one `outbound_sms` usage row has `billable=true`, `customer_rate_minor=25`, `estimated_customer_charge_minor=25`, `customer_rate_currency='AUD'`, the Twilio SID and tenant linkage, GST-exclusive metadata, and no Stripe meter event.

### AI Receptionist

1. Confirm the existing tenant assistant and trusted mapping are active.
2. Select AI Receptionist.
3. Make a real forwarded call and complete the existing conversation.
4. Confirm the lead, transcript/summary behavior, exact voice seconds, provider cost, customer charge state, and tenant Job Centre.
5. Confirm Text Link did not send an SMS for the AI call.

### Duplicate and replay handling

Replay the same Twilio/Vapi provider event under controlled conditions. Confirm there is no second recovery SMS, lead, or usage event. Confirm a questionnaire cannot link a missed call from another tenant.

### Billing

Confirm AI usage is billed only when the effective billing state and live mode permit it. Confirm billing-exempt AI tests skip Stripe. Confirm every Twilio-accepted Text Link SMS creates exactly one A$0.25 excluding GST invoice-aggregation event, while rejected or unresolved attempts create none. Confirm GST is added only by the invoicing/tax layer. Confirm the live Stripe webhook and customer portal remain healthy without submitting SMS events to the AI voice meter.

## 9. Rollback

1. Set the affected tenant’s authoritative mode to Off.
2. Confirm both legacy workflow flags are disabled.
3. Roll the application back to the last approved version.
4. Leave the new columns, inventory, provider-event records, and migration in place.
5. Do not drop tables or reuse assigned numbers during incident response.
6. If provider routing is the cause, an administrator may restore the previously recorded provider configuration only after preserving the existing number assignments.

Rollback must not rewrite Git history or alter unrelated provider resources.

## 10. Source checks are not live certification

Unit tests, type-checking, linting, static migration assertions, and a successful production build verify source behavior. They do not prove carrier forwarding, Vapi media, SMS delivery, regulatory approval, Stripe live webhooks, a deployed database migration, or production tenant isolation. Only the ordered live certification above can establish those outcomes.
