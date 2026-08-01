# Rapid Connect Acquisition Funnel

Status: implementation candidate on `feat/acquisition-funnel`

## Visual asset provenance

The responsive plumber hero photography was generated specifically for Richmond Rapid Connect on
29 July 2026 using OpenAI image generation. It was not sourced from a third-party stock library and
contains no external logo or watermark. The repository stores separately composed desktop and
mobile masters as optimized AVIF and WebP files with JPEG fallbacks.

`npm run verify:assets` parses every critical file, verifies its real encoded dimensions and format,
enforces a non-empty size range, and rejects any empty raster file under `src/assets`. The
commercial release workflow runs this check before the behavioural suite.

## Customer journey

1. A permissioned outreach message links to `/plumbers` with campaign attribution.
2. Desktop shows a 50/50 demo and signup choice; mobile stacks the experience and keeps a
   signup action visible.
3. The 58-second product commercial expands to the viewport (and requests browser fullscreen
   after the customer clicks). It returns to the split page when it finishes.
4. The signup panel expands to a five-step full-page wizard:
   - package;
   - business and contact;
   - current phone handling;
   - setup-fee waiver;
   - account and secure payment handoff.
5. Stripe collects the payment method. Rapid Connect never collects card details.
6. The customer continues into the existing activation/onboarding flow.

## Campaign links

Use one canonical campaign name and explicit channel values:

```text
https://<host>/plumbers?code=FOUNDINGPLUMBER&source=sms&medium=direct&campaign=founding-plumbers
https://<host>/plumbers?code=FOUNDINGPLUMBER&source=email&medium=direct&campaign=founding-plumbers
https://<host>/plumbers?code=FOUNDINGPLUMBER&source=instagram&medium=social&campaign=founding-plumbers
```

Optional `content` values distinguish message variants, for example `content=missed-jobs-a`.
Optional `ref` values can identify a partner or referral programme. Do not put a plumber's name,
phone number, email address or other personal information in the URL.

## Offer contract

Public code: `FOUNDINGPLUMBER`

| Package                | Setup list price | With valid code | Ongoing platform price | Usage                                     |
| ---------------------- | ---------------: | --------------: | ---------------------: | ----------------------------------------- |
| Text Receptionist      |            A$499 |             A$0 |              A$9/month | A$0.25 ex GST per accepted recovery SMS   |
| Text + AI Receptionist |          A$1,199 |             A$0 |             A$15/month | A$0.59 per AI voice minute plus SMS usage |

The seeded campaign:

- applies to both packages;
- is capped at 100 redemptions;
- expires at the end of 31 December 2026 Melbourne time;
- is revalidated transactionally at redemption;
- can be disabled, limited or extended in the database without a code release;
- records the exact waived amount against the authenticated business;
- carries the promotion and waived amount into Stripe session/subscription metadata.

The setup waiver never discounts platform or usage charges.

## Commercial script (58 seconds)

Demo version storage and selection are documented in `DEMO_VARIANTS.md`. The original animated
commercial is preserved as `demo-original`; `demo-real-world-v2` is the configurable staging
candidate. No performance winner is claimed until sufficient variant data exists.

| Time   | Picture                                                | On-screen message                                    |
| ------ | ------------------------------------------------------ | ---------------------------------------------------- |
| 0–7s   | Plumber working under a sink; phone rings out of reach | You’re under a sink. Your next customer is calling.  |
| 7–15s  | Missed caller receives a branded message and job link  | The missed call becomes a conversation—in seconds.   |
| 15–24s | Customer selects job, suburb and urgency               | Your customer tells you what matters.                |
| 24–32s | Completed lead summary arrives                         | Get the useful details before you call back.         |
| 32–42s | AI answers a second caller naturally                   | Or let a natural voice answer, 24/7.                 |
| 42–50s | Text and AI leads sit together in the job centre       | Every lead, clear and ready to action.               |
| 50–58s | Rapid Connect end card and signup action               | Keep working. Keep answering. Stop losing good jobs. |

The commercial is implemented as a responsive, caption-first animated product film so it works
without audio and can be revised without re-encoding a video. A final narrated MP4 can replace it
later without changing the landing page, analytics or signup flow.

## Outreach templates

These are templates, not authority to send. Every recipient needs a recorded consent basis. The
sender record must include the business/legal identity and working contact details.

### SMS — direct problem/solution

```text
Hi {{first_name}} — Rapid Connect helps plumbers turn missed calls into complete job leads by text,
or answer them with an AI receptionist. Watch the 58-sec demo: {{campaign_link}}
Founding plumber setup is $0 with code FOUNDINGPLUMBER. Reply STOP to opt out.
```

### SMS — short version

```text
On the tools and missing calls? See Rapid Connect turn one into a complete plumbing lead:
{{campaign_link}}. Setup is $0 with FOUNDINGPLUMBER. Reply STOP. {{sender_contact}}
```

### Email

Subject variants:

- `The plumbing job you miss while you’re on the tools`
- `A 58-second demo for {{business_name}}`
- `Turn missed calls into complete job leads`

```text
Hi {{first_name}},

When a customer calls while you’re under a sink, Rapid Connect can immediately text them a
branded job questionnaire—or answer with a natural AI receptionist.

The demo takes 58 seconds:
{{campaign_link}}

Founding plumbers can use FOUNDINGPLUMBER to waive the A$499 Text setup fee or the A$1,199
Text + AI setup fee. Recurring and usage prices are shown before payment setup.

{{sender_legal_name}}
{{sender_contact_details}}

To stop receiving these emails, click {{unsubscribe_link}} or reply “unsubscribe”.
```

### Social direct message

```text
Hi {{first_name}} — quick one for {{business_name}}. We built a receptionist specifically for
plumbers who can’t answer while they’re on the tools. This 58-sec demo shows the text and AI
versions: {{campaign_link}}. Happy to leave it there if it’s not relevant.
```

## Outreach compliance gate

Do not upload or send a bulk list until the outbound system can prove:

- the consent basis for each address/number;
- the exact source and date of that basis;
- accurate sender identification and contact details;
- a working unsubscribe mechanism for every commercial message;
- immediate suppression on `STOP`/unsubscribe, and no later than five working days;
- no address-harvested list or software;
- a durable suppression list shared across SMS and email providers.

ACMA states that commercial electronic messages require consent, accurate sender identification
and a functional unsubscribe facility. Its current guidance also says unsubscribe requests must
be honoured within five working days:

- https://www.acma.gov.au/avoid-sending-spam
- https://www.acma.gov.au/telemarketing-and-e-marketing-common-issues-and-mistakes

## Analytics events

The server records privacy-minimal, idempotent events. It does not store IP addresses, message
contents, names, phone numbers or email addresses in the event table.

```text
landing_viewed
demo_started
demo_25 / demo_50 / demo_75 / demo_completed / demo_closed
signup_opened
package_selected
promo_validated
wizard_step_viewed
signup_submitted
account_created
email_confirmation_required
checkout_opened / checkout_failed
```

Use a funnel from `landing_viewed` to `account_created`, split by `source`, `campaign`, `content`
and `plan`. Treat `checkout_opened` as intent, not revenue; Stripe/webhook state remains the
billing source of truth.

## Launch boundaries

Before public outreach:

1. Deploy the acquisition migration and application to isolated hosted staging.
2. Validate both promo amounts and the 100-redemption cap against a clean database.
3. Complete same-tab and email/new-tab signup with Stripe sandbox.
4. Confirm no setup item is charged and the waiver metadata is present.
5. Run desktop and mobile visual/accessibility checks in a hosted browser.
6. Replace draft sender identity/contact placeholders in the outreach system.
7. Approve the final recipient-consent and suppression process.
8. Publish deliberately; do not auto-merge this branch or send outreach from CI.
