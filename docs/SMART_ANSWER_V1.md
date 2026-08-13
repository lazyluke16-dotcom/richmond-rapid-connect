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

## Staging activation order

Do not point a production customer number at Smart Answer until this sequence passes in staging.

1. Apply the Smart Answer migrations in manifest order.
2. Confirm the customer's normal AI Receptionist is provisioned and operational.
3. Configure the two SIP authentication secrets in the staging runtime.
4. Open **Smart Answer** in the plumber workspace and provision the isolated Smart Answer stack.
5. Configure one staging Twilio overflow number's inbound voice webhook to:
   - `POST {PUBLIC_JOB_REQUEST_URL}/api/public/webhooks/twilio-smart-answer`
6. Verify the customer's no-answer forwarding to that staging overflow number.
7. Set the carrier's no-answer delay to the desired ring-first interval (15 seconds is the V1 default). The application records the preferred interval but does not control the carrier timer.
8. Add at least one known test mobile to the protected-number list.
9. Switch Smart Answer on.

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
