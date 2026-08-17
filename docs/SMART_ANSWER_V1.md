# Smart Answer V1 — deployment and certification

Smart Answer is a ring-first overflow layer for the AI Receptionist. It does **not** replace the customer's existing public phone number.

## Customer call path

1. The customer's existing business/mobile number rings normally.
2. The mobile carrier's **forward on no answer** setting diverts unanswered calls to the assigned Rapid Connect overflow number.
3. Twilio sends the forwarded call to `/api/public/webhooks/twilio-smart-answer`.
4. Smart Answer screens the original caller number before an AI session starts:
   - protected/bypass number -> ordinary recorded voicemail;
   - 13 / 1300 / 1800 caller -> reject before AI;
   - private, withheld, foreign or invalid caller -> ordinary recorded voicemail;
   - Australian mobile or geographic landline -> eligible for AI.
5. Eligible calls are bridged over authenticated SIP to the business's dedicated Smart Answer Vapi assistant.
6. The assistant classifies the caller as either:
   - `plumbing_enquiry` -> create a normal plumbing lead; or
   - `message` -> persist a receptionist message without creating a fake lead.
7. If the SIP leg cannot connect, Twilio falls back to ordinary voicemail.
8. Only successfully connected SIP seconds are inserted into the existing AI voice usage ledger and eligible for Stripe metering.

## Required server secrets

Existing secrets remain required:

- `TWILIO_AUTH_TOKEN`
- `VAPI_API_KEY` (or `VAPI_PRIVATE_KEY`)
- `VAPI_SERVER_SECRET`
- `VAPI_SERVER_CREDENTIAL_ID` where not recoverable from an existing assistant
- `PUBLIC_JOB_REQUEST_URL`

Smart Answer adds:

- `VAPI_SIP_AUTH_USERNAME`
- `VAPI_SIP_AUTH_PASSWORD`

Use a high-entropy username/password pair stored only in the deployment secret manager. Do not put either value in source, browser configuration or customer-visible settings.

## Protected staging environment prerequisite

The repository's GitHub `staging` environment is branch-protected. On 2026-08-13, a read-only credential-inventory attempt from `feat/smart-answer-v1` was rejected before any workflow step ran because that branch was not permitted to deploy to `staging`.

Do **not** remove the staging environment protection or move staging secrets to an unprotected repository scope to work around this. Before Smart Answer staging deployment, explicitly add `feat/smart-answer-v1` (or the final approved Smart Answer release branch) to the `staging` environment's allowed deployment branches.

The staging access inventory now checks these Smart Answer credentials by name without printing values:

- `VAPI_SERVER_CREDENTIAL_ID`
- `VAPI_SIP_AUTH_USERNAME`
- `VAPI_SIP_AUTH_PASSWORD`

After the branch allowlist is updated, run `.github/workflows/staging-access-preflight.yml` against the Smart Answer branch and confirm there are no missing staging variables/secrets.

## Smart Answer staging deployment workflow

Use `.github/workflows/smart-answer-staging-deployment.yml` for this feature rather than the older acquisition staging workflow. The older workflow intentionally verifies that the requested SHA is already contained in `feat/acquisition-funnel`, so it rejects an unmerged Smart Answer head.

The Smart Answer workflow:

- requires an exact 40-character Smart Answer SHA;
- verifies the SHA belongs to the Smart Answer line and is based on `feat/acquisition-funnel`;
- runs migration, asset, test, TypeScript and production dependency-audit gates before any hosted mutation;
- builds the Cloudflare/Nitro staging artifact;
- links only the isolated staging Supabase project;
- dry-runs all frozen migrations before applying them;
- uploads only the new Smart Answer Vapi/SIP credentials to the staging-named Worker;
- deploys only the staging-named Worker; and
- never alters production Twilio, Vapi, Supabase or Cloudflare resources.

The workflow confirmation text must be exactly `DEPLOY_SMART_ANSWER_STAGING_ONLY`.

### Current dependency-audit blocker

As of 2026-08-13, the repository production dependency audit reports inherited high-severity advisories in existing transitive dependencies. Smart Answer changes neither `package.json` nor `package-lock.json`, but the staging deployment workflow intentionally retains `npm audit --omit=dev --audit-level=high` as a hard gate. Therefore staging deployment remains blocked until the dependency-maintenance work clears that gate. Do not bypass or downgrade this audit simply to reach staging.

## Staging activation order

Do not point a production customer number at Smart Answer until this sequence passes in staging.

1. Allow the approved Smart Answer release branch in the protected GitHub `staging` environment.
2. Run the staging access inventory and confirm all required variables/secrets are present without exposing their values.
3. Clear the production dependency-audit gate.
4. Run `smart-answer-staging-deployment.yml` with the exact approved release SHA and `DEPLOY_SMART_ANSWER_STAGING_ONLY`.
5. Confirm the frozen Smart Answer migrations were dry-run and applied only to isolated staging.
6. Confirm the customer's normal AI Receptionist is provisioned and operational in staging.
7. Open **Smart Answer** in the staging plumber workspace and provision the isolated Smart Answer stack.
8. Configure one staging Twilio overflow number's inbound voice webhook to:
   - `POST {PUBLIC_JOB_REQUEST_URL}/api/public/webhooks/twilio-smart-answer`
9. Verify the customer's no-answer forwarding to that staging overflow number.
10. Set the carrier's no-answer delay to the desired ring-first interval (15 seconds is the V1 default). The application records the preferred interval but does not control the carrier timer.
11. Add at least one known test mobile to the protected-number list.
12. Switch Smart Answer on in staging only.

## Mandatory call matrix

All cases must pass before production use.

| Test | Expected result |
| --- | --- |
| Plumber answers before forwarding | Rapid Connect never receives the call |
| Protected Australian mobile | Ordinary voicemail; no Vapi/SIP leg; no AI voice billing |
| Protected Australian landline | Ordinary voicemail; no Vapi/SIP leg; no AI voice billing |
| 13 number | Rejected before AI |
| 1300 number | Rejected before AI |
| 1800 number | Rejected before AI |
| Private/withheld caller | Ordinary voicemail |
| Unknown Australian mobile seeking a new plumbing job | AI receptionist; lead created once |
| Unknown Australian landline seeking a new plumbing job | AI receptionist; lead created once |
| Unknown eligible caller who is a supplier/business contact | AI receptionist takes a message; no plumbing lead |
| Existing-job/admin caller needing the plumber | AI receptionist takes a message; no plumbing lead |
| Vapi SIP unavailable | Ordinary voicemail fallback |
| Replayed Twilio Dial callback | AI voice usage remains exactly once |
| Completed AI call | Metered seconds equal Twilio `DialCallDuration` |

## Carrier certification

Before claiming universal Australian support, repeat no-answer forwarding and caller-ID preservation tests with representative Telstra, Optus and Vodafone services. The key assertion is that the Twilio inbound `From` value still represents the original caller after carrier forwarding. Do not enable automatic contact matching until this is proven for the supported carrier path.

## V1 limitation: phone contacts

Automatic iOS/Android contact syncing is intentionally out of scope for V1. The protected-number table already supports `source = 'contact_sync'`, so a later native/contact-sync component can populate the same routing list without changing the Smart Answer decision engine.

## Production gate

Production activation is an explicit operator action. Source merge alone must not:

- apply database migrations to production;
- change a production Twilio phone-number webhook;
- create or replace live Vapi assistants/phone numbers;
- alter a customer's carrier forwarding;
- rotate secrets; or
- turn Smart Answer on for an existing customer.
