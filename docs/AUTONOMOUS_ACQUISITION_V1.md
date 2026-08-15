# Autonomous Acquisition V1 — Prospect Intelligence + Personalised Demo Factory

Tracking issue: [#21](https://github.com/lazyluke16-dotcom/richmond-rapid-connect/issues/21).
Branch: `feat/autonomous-acquisition-v1` (based on `feat/acquisition-funnel`).

This slice lets Rapid Connect take a plumbing business website and, with no further
operator input, produce a trustworthy prospect record, evidence-backed business
intelligence, verified branding, a deterministic score with reasons, a safe AI-receptionist
demo configuration, and a private, unlisted, branded demo — with **zero outreach and zero
paid provider provisioning**. The V1 authority is deliberately bounded: the lifecycle stops
at `demo_ready`.

## Design principle

This is **not** one giant autonomous LLM agent. It is deterministic application
infrastructure with a bounded, optional AI seam. Application/database state is the source
of truth. Deterministic HTML/structured-data extraction produces every material fact; the
AI adapter may only ever _propose additional candidates_, which are then subjected to the
same evidence, confidence, conflict and anti-hallucination rules — and are capped at low
confidence. The default adapter proposes nothing, so the whole system (and the entire test
suite) runs deterministically with no provider credentials.

## Prospect domain (migration `20260815120000_prospect_intelligence.sql`)

A prospect is a first-class entity, separate from a customer/tenant (`public.businesses`).

| Table                   | Purpose                                                                                                                                                                                     |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prospects`             | Identity, denormalised branding/score caches, lifecycle, demo pointer. Deduplicated by `canonical_domain` (unique).                                                                         |
| `prospect_facts`        | The provenance store: one row per material fact with `source_url`, `observed_context`, `retrieved_at`, `confidence`, `extractor`, and a `status` of `verified` / `unknown` / `conflicting`. |
| `prospect_scores`       | Auditable deterministic score breakdown (`factors` JSONB) — 1:1 with a prospect.                                                                                                            |
| `prospect_demo_configs` | Versioned safe demo config + the private access credential. Only the SHA-256 **hash** of the demo token is stored.                                                                          |
| `prospect_events`       | Append-only lifecycle/action audit.                                                                                                                                                         |

All tables are **service-role only** (`REVOKE ALL ... FROM anon, authenticated` + a
service-role policy), matching the acquisition/outreach privacy-minimal model. There is no
public prospect directory and no authenticated/anon RLS grant. Operator access is mediated
entirely by server-side code that checks an explicit operator allow-list.

### Lifecycle

```
DISCOVERED → RESEARCHING → ENRICHED → DEMO_BUILDING → DEMO_READY
             ── V1 stops here ──┘
(future slices: OUTREACH_APPROVED → CONTACTED → ENGAGED → TRIAL → PAID → CUSTOMER)
```

The V1 cap is enforced in **two** places: a database `CHECK` constraint that only permits
statuses up to `demo_ready`, and `assertV1Transition()` in `src/lib/prospect/lifecycle.ts`,
through which every repository status change flows. No code path in this slice can advance a
prospect to an outreach/customer state.

## Provenance & anti-hallucination

- Every material fact carries evidence (`source_url` + observed context + retrieval time +
  confidence). A DB `CHECK` requires verified/conflicting facts to cite a source and
  requires unknown facts **not** to.
- When two sources disagree on a single-valued fact (phone/address/hours), the fact is
  marked `conflicting` — never silently resolved.
- Missing material facts are stored as explicit `unknown` rows. Absence never becomes a
  value.
- `anti-hallucination.ts` is a single guard every generated demo config must pass before it
  is persisted or displayed. It rejects generated language that asserts an unsourced price,
  discount, guarantee, response time, licence, accreditation, booking policy or staff
  identity, and rejects any "verified" value not backed by a fact. `demo-config.ts` calls it
  via `assertDemoConfigSafe()` and fails closed.

## Research / enrichment layer

`researchProspect()` (in `research.ts`) orchestrates a deterministic pipeline:

1. **SSRF-safe fetch** (`url-safety.ts` + `safe-fetch.ts`): only http/https, no embedded
   credentials, only ports 80/443, no localhost/private-use hostnames, no private/loopback/
   link-local/reserved IPv4 or IPv6 literals — including octal/hex/decimal IPv4 forms
   (canonicalised by the WHATWG URL parser), IPv4-mapped IPv6, NAT64, and the IPv4-embedding
   transition ranges 6to4 (`2002::/16`) and Teredo (`2001:0000::/32`). Redirects are followed
   manually with per-hop re-validation. A timeout, a byte cap and a content-type allow-list
   bound every request. Where a DNS resolver is available (Node/Nitro), the hostname is
   resolved and every resolved address is re-validated (DNS-rebinding defence); on an edge
   runtime without `node:dns` this guard is a no-op, and the platform's own inability to reach
   RFC1918/link-local/metadata addresses is the backstop for domain→private rebinding.
2. **Deterministic extraction** (`html-extract.ts`): schema.org JSON-LD (preferred, high
   confidence) plus visible-text heuristics for services, service areas, phone, hours,
   emergency availability, positioning, brand colours, logo and favicon.
3. **Evidence assembly** (`evidence.ts`): dedup, confidence, conflict detection, explicit
   unknowns.
4. **Branding** (`brand.ts`): the strongest logo candidate is fetched and its bytes are
   validated by magic number + size before it is trusted; otherwise the favicon or a neutral
   default palette is used. A missing logo never blocks demo creation.
5. **Deterministic scoring** (`scoring.ts`): a transparent, configurable sum of factors.

The provider seam (`ai-extractor.ts`) is modular so future business-data sources can be
added without rewriting the prospect model.

## Deterministic scoring

`scoreProspect()` returns a total (0–100), a band (`low`/`medium`/`high`/`priority`) and a
full factor breakdown (label, points awarded/deducted, reason). Factors include: functioning
website, public phone, multiple/broad services, emergency service, defined service areas,
target geography, positioning, an after-hours coverage gap, and a penalty for an existing AI
receptionist. Weights live in `DEFAULT_WEIGHTS` and are easy to re-tune against real
conversion evidence. The LLM is never the source of truth for the score.

## Private personalised demo

- Route: `/demo/<slug>/<token>` (`src/routes/demo.$slug.$token.tsx`).
- The slug is a non-secret unlisted label; the token is 256 bits of CSPRNG entropy. Only the
  token's SHA-256 hash is stored.
- The page is `noindex, nofollow, noarchive`, is not linked from any public navigation, and
  there is no sitemap entry (the app publishes no sitemap). It renders verified branding,
  services, areas and safe example enquiries, and shows a clear disclosure that it is a
  private preview prepared from public information that does not imply the business uses or
  endorses Rapid Connect.
- `DemoAccessService` (`demo-access.ts`) fails closed: unknown slug, wrong token, revoked or
  expired demos are all denied with an opaque reason, and any thrown error denies access.

## Shared demo runtime

`SharedDemoRuntime` (`shared-runtime.ts`) is one deterministic runtime that serves every
prospect demo by loading its stored config by id. It creates **no** provider resources and
makes **no** outbound provider calls. The interactive text receptionist
(`POST /api/public/prospect/demo-reply`) emits only verified facts and defers every unknown
(and all pricing) to a callback rather than inventing an answer. A hosted **voice** demo is
explicitly deferred; `describeVoiceStub()` documents the safe abstraction and what a later
provider-enabled slice must add, without faking readiness.

## Operating the system

### Build a demo (controlled entry point)

Authenticated operators use the internal view at **`/acquisition/prospects`**, or call the
operator API directly:

```
POST /api/public/prospect/build
Authorization: Bearer <supabase access token for an allow-listed operator>
Content-Type: application/json

{ "website": "https://exampleplumbing.com.au", "ttlDays": 30 }
```

The response includes the prospect id, score/band, and the private demo URL **with its
one-time token** (only the hash is stored, so the link is shown exactly once). Building is
idempotent by canonical domain: a second build for the same domain updates the prospect in
place and mints a fresh demo version rather than forking a duplicate.

Operator authorisation is an explicit allow-list of Supabase user ids in
`ACQUISITION_OPERATOR_USER_IDS` (the existing `OUTREACH_OPERATOR_USER_IDS` list is also
honoured).

### Inspect prospects

- `GET /api/public/prospect/list` — privacy-minimal roster (no contact values).
- `GET /api/public/prospect/detail?id=...` — evidence/provenance, score reasons, branding and
  demo metadata (never the token/hash).

### Revoke a demo

```
POST /api/public/prospect/revoke
Authorization: Bearer <operator token>
{ "prospectId": "<id>" }
```

Revocation is idempotent and revokes **every** active demo version for the prospect, so all
outstanding private links fail closed immediately. A rebuild also supersedes prior versions:
minting a new demo revokes all earlier ones, so only the newest link is ever live.

## Safety boundary (V1)

No outreach of any kind, no bulk-send worker, no email/SMS/voice, no Twilio/Vapi number or
assistant purchasing, no Stripe customer or charge, no production deployment, no Smart Answer
change, and no mutation of production provider configuration. This is enforced by: the
lifecycle cap (DB + code), the absence of any provider import in the slice (machine-checked
by `__tests__/no-provider.test.ts`), and the operator-only, no-public-directory access model.

## Limitations & explicitly deferred work

- **Live enrichment providers**: only deterministic first-party crawling is implemented. The
  AI/third-party provider adapter is a disabled-by-default seam.
- **Hosted voice demo**: deferred (see `describeVoiceStub()`); the text runtime is fully
  implemented.
- **Autonomous discovery at scale** (Slice 2), **compliant outreach** (Slice 3), **AI sales
  conversations** (Slice 4) and **paid conversion / dedicated provisioning** (Slice 5) are
  out of scope and intentionally not implemented.
- Deterministic extraction is tuned for common AU plumbing site structures and schema.org
  markup; sites that are entirely image-based or JS-rendered will yield more `unknown` facts
  (by design — it fails closed rather than guessing).

See `AUTONOMOUS_ACQUISITION_RELIABILITY.md` for the fixture-based reliability exercise.
