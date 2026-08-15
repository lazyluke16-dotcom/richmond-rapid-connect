# Autonomous Acquisition V1 — Slice 2: Autonomous Prospect Discovery

Tracking issue: [#23](https://github.com/lazyluke16-dotcom/richmond-rapid-connect/issues/23).
Branch: `feat/autonomous-discovery-v1` (stacked on `feat/autonomous-acquisition-v1`).

Slice 2 lets an authorised operator run a **bounded discovery mission** — "find a capped set
of plumbers in this geography" — that discovers, normalises, deduplicates, qualifies and feeds
eligible businesses into the approved Slice-1 research + Demo Factory, stopping at
`DEMO_READY`. It sends **zero outreach** and creates **no paid provider resources**.

## Design principle

Deterministic workflow + bounded provider adapters; no giant autonomous LLM agent. All
mission state lives in the database, so a mission is fully resumable and survives process
termination (no long-lived in-memory worker — Cloudflare/Nitro friendly). Application/database
state is authoritative; every decision is an explainable rule with a stored reason.

## Domain (migration `20260815140000_autonomous_discovery.sql`)

| Table                      | Purpose                                                                                                                                                                                                                                                                 |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `discovery_missions`       | Bounded mission: status, vertical, geography + geo terms, target + hard max-candidate cap, sources, per-source cursor, cost + ceiling, retry state, denormalised disposition counts, and a bounded `import_seed` (operator-curated businesses for the `import` source). |
| `discovery_candidates`     | One provenance-carrying row per discovered business: source, provider id, website/domain, phone/locality, discovery query, the layered `dedup_key`, disposition, duplicate-of, explainable reason, and the accepted prospect id.                                        |
| `discovery_mission_events` | Append-only mission/action audit.                                                                                                                                                                                                                                       |

All three tables are **service-role only** (no anon/authenticated grants). A `UNIQUE
(mission_id, dedup_key)` constraint makes candidate claiming concurrency-safe.

## Mission state machine

```
draft → approved → running → (paused ⇄ running) → completed
                     │
                     ├─ failed     (transient provider failures exceed the retry cap)
                     └─ cancelled  (operator)
```

There is **no** lifecycle beyond feeding Slice-1, which is itself DB-`CHECK`-capped at
`demo_ready`. Discovery introduces no outreach/customer states (machine-checked).

## Provider adapter contract

`DiscoveryProvider.search(input, cursor) → { candidates, nextCursor, usage }` (in
`provider.ts`). The engine is coupled only to this interface. `usage.costCents` drives the
metered-spend ceiling. Providers signal retryable vs terminal failures via
`DiscoveryProviderError.transient`.

### Current provider status

- **`import`** (shipped): the lawful V1 source — an operator supplies the bounded list of
  real businesses they are permitted to process (`import_seed`), which the engine pages via
  `FixtureDiscoveryProvider`. Accepted businesses are researched from their real public
  websites through the reviewed Slice-1 pipeline.
- **`fixture`** (tests only): the same deterministic provider used to certify orchestration.
- **Live discovery is an external dependency** (blocked): no third-party discovery source is
  wired, because scraping Google Maps/etc. in violation of terms is prohibited and no
  approved API/credential is currently available. The adapter architecture is complete; a
  lawful provider can be registered without changing the engine or schema.

## Deduplication (layered, deterministic)

In precedence order: **canonical domain → provider business id → normalised phone →
normalised name + locality**. The name+locality key requires BOTH parts, so same-name
independents in different localities ("Smith Plumbing — Richmond" vs "— Geelong") are never
merged. Exact/differently-formatted duplicates collapse on the primary `dedup_key` via the
DB unique constraint (idempotent, concurrency-safe). The hard "no duplicate prospect"
guarantee is the Slice-1 `prospects.canonical_domain` unique constraint.

## Pre-qualification (cheap, explainable)

Before the expensive crawl/demo build, each candidate is filtered with a stored reason:
`insufficient_identity`, `not_target_vertical`, `outside_geography`, `no_website`,
`unsafe_url` (reuses the hardened Slice-1 SSRF gate incl. 6to4/Teredo), plus
`existing_prospect` (already a prospect → linked, never re-researched).

## Orchestration & bounds

`advanceMission()` processes exactly one provider page per call and is idempotent + resumable.
Every bound is explicit: `target_count`, hard `max_candidates` cap, per-page size, retry cap
with the retry counter reset on success, and an optional `cost_ceiling_cents`. Terminal
conditions: target reached, max candidates reached, cost ceiling exceeded, or source
exhausted. `runMissionToCompletion()` loops advance with a hard `maxSteps` backstop.

## Operating a mission

Operator surface `/acquisition/discovery` (authenticated + operator allow-list), or the API:

- `POST /api/public/discovery/missions` — create (geography, targetCount, `importCandidates`).
- `POST /api/public/discovery/control` — `{ missionId, action: start|pause|resume|cancel }`.
- `POST /api/public/discovery/advance` — `{ missionId, maxSteps? }`; advances up to 20 pages
  per request (edge-friendly) and persists state; re-invoke to resume.
- `GET /api/public/discovery/missions` / `GET /api/public/discovery/detail?id=` — progress,
  disposition counts, and explainable per-candidate outcomes (no contact values in aggregate).

## Safety boundary

No email/SMS/voice, no outreach records, no campaigns, no Twilio/Vapi/Stripe provisioning or
charge, no production deploy, no Smart Answer change. Enforced by: the absence of any
provider/outreach import in the slice (machine-checked by `__tests__/no-provider.test.ts`),
the `demo_ready` lifecycle cap (Slice-1 DB + code), operator-only access, and the fact the
engine's only downstream call is the reviewed `buildProspectDemo`.

## Scalability notes

Missions are bounded (`max_candidates ≤ 5000`). Counts are recomputed from candidate rows
(race-free). The dedup identity index is loaded per mission (bounded). `import_seed` is kept
out of the hot `getMission` path via an explicit column list and fetched only when a mission
runs. Discovery at internet scale (continuous crawling, a durable queue/cron) is a later
concern; V1 is operator-triggered, bounded batches.

## Explicitly deferred to Slice 3+

Live discovery providers; continuous/autonomous discovery at scale; and all outreach
(compliant, consent-gated) — which remains gated behind the existing suppression/send
controls and is out of scope here.

See `AUTONOMOUS_DISCOVERY_RELIABILITY.md` for the 100+ candidate exercise.
