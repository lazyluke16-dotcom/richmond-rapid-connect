# Permissioned plumber outreach operations

Status: engineering controls implemented; real sending remains disabled.

## Non-negotiable launch rule

An address or number being published online is not, by itself, permission to send marketing. Every
recipient must have express consent or a documented, defensible inferred-consent basis that has
been reviewed before the campaign becomes `ready`.

Operational references:

- https://www.acma.gov.au/avoid-sending-spam
- https://www.acma.gov.au/telemarketing-and-e-marketing-common-issues-and-mistakes
- https://www.acma.gov.au/spam-compliance-alerts

## Evidence carried per recipient

- channel and normalized destination;
- campaign and business;
- express or inferred permission basis;
- where and when permission was obtained;
- reviewer and review time;
- optional notes supporting the decision;
- current eligibility/suppression state;
- a one-way unsubscribe-token hash.

Raw destinations and permission evidence are private service-role data. They are never placed in
campaign URLs, analytics events, client logs or GitHub evidence.

## Database enforcement

`outreach_messages_send_gate` rejects any transition into a sendable state unless:

1. The campaign is explicitly `ready`.
2. The recipient is `eligible`.
3. A reviewer and review timestamp are present.
4. Sender legal name and contact details exist.
5. The message body identifies the sender.
6. The exact unsubscribe instruction appears in the message.
7. No matching suppression exists.

This is a database constraint path, not only a user-interface warning.

## Unsubscribe paths

### SMS

Twilio posts replies to:

```text
POST /api/public/webhooks/twilio-outreach
```

The handler validates the exact Twilio signature and treats `STOP`, `STOP ALL`, `UNSUBSCRIBE`,
`CANCEL`, `END` and `QUIT` as suppression instructions. A suppression immediately marks matching
recipients suppressed and cancels draft/queued messages. The endpoint returns empty TwiML and does
not send marketing content.

### Email and tracked links

Messages link to:

```text
/unsubscribe?token=<single-purpose-random-token>
```

The person confirms once without logging in or providing more information. Only a SHA-256 token
hash is stored. Link scanners therefore cannot silently unsubscribe someone via a GET request.

### Manual, complaint and bounce suppression

The service-role function `record_outreach_suppression` also supports complaint, hard-bounce,
invalid, manual and legal-hold reasons. All channels share the same enforcement tables.

## Campaign readiness sequence

1. Create a draft campaign with the correct legal sender identity and working contact details.
2. Import only permissioned recipients.
3. Normalize/deduplicate endpoints and issue random unsubscribe tokens.
4. Review every permission record; do not bulk-approve unknown or scraped data.
5. Render messages from approved templates with source-specific campaign links.
6. Run the send gate in dry-run mode and resolve every rejection.
7. Confirm the Twilio inbound webhook and web unsubscribe route in isolated staging.
8. Mark the campaign `ready`.
9. Approve a 25–50 recipient pilot separately.
10. Monitor replies, failures, complaints, suppressions and funnel conversion before expanding.

Before any database import, run the non-sending preflight through standard input:

```text
npm run outreach:preflight < private-campaign-manifest.json
```

Start from `docs/outreach-campaign.template.json`, keep the completed manifest outside Git, and do
not paste it into chat. The preflight returns only aggregate counts and validation errors; it never
prints contact values, business names or permission notes, and it performs zero provider sends.

## Aggregate operations report

The authenticated page at `/outreach-operations` shows:

- unique landing, demo, signup, account, checkout and activation counts;
- campaign attribution;
- recipient review and message-status totals;
- readiness blockers;
- suppression counts and setup-fee waivers.

Access fails closed unless the authenticated Supabase user ID appears in the comma-separated
`OUTREACH_OPERATOR_USER_IDS` server environment variable. The API queries only the minimum fields
needed to aggregate the report. Its response never includes contact values, permission notes,
recipient/business names, unsubscribe tokens, endpoint hashes or provider message IDs.

The page is read-only. It cannot approve campaigns, import recipients or send messages.

## Still intentionally absent

- No list harvesting or enrichment.
- No production provider sender.
- No automatic campaign approval.
- No bulk-send worker or cron.
- No real recipient import.
- No real message has been sent.

Those omissions keep the system fail-closed until hosted staging and the controlled-pilot approval
are complete.
