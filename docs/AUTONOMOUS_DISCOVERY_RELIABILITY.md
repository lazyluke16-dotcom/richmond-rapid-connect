# Autonomous Discovery (Slice 2) — Reliability Exercise

The Issue #23 (§Reliability) requirement: run a 100+ candidate discovery mission with the
full spread of messy cases and prove no duplicate prospect/demo creation and zero outreach.

## Honesty note

These are **synthetic, controlled fixtures**, not real businesses. No live business was
contacted, no external discovery source was queried, and no network request was made (a fake
fetch serves each candidate's site). Live discovery is an external dependency and is not
represented here as real. The exercise is reproduced by
`src/lib/discovery/__tests__/reliability.test.ts`, which regenerates the numbers on every run
and writes a machine report to `<os-tmp>/discovery-reliability-report.json`.

## What was exercised

A single bounded mission over 101 candidates (paged in 12s, with a transient provider failure
injected on page 2 to exercise retry), including deliberately: exact duplicates,
differently-formatted domain duplicates, a phone-only duplicate, same-name/different-locality
independents, a missing website, a malformed URL, an unsafe private URL (`10.0.0.5`), a 6to4
IPv6 metadata URL (`[2002:a9fe:a9fe::]`), an irrelevant (bakery) business, and an
out-of-geography plumber. Accepted candidates were researched and demo-built through the real
Slice-1 pipeline.

## Results (latest run)

| Metric                                         | Value                                                                      |
| ---------------------------------------------- | -------------------------------------------------------------------------- |
| Candidates discovered (input)                  | 101                                                                        |
| Candidate rows created                         | 99                                                                         |
| Collapsed exact/format duplicates (unique-key) | 2                                                                          |
| Accepted → demo-ready                          | 91                                                                         |
| Duplicate rows (cross-dimension)               | 1 (`duplicate_phone`)                                                      |
| Rejected                                       | 7 (`no_website`, `unsafe_url`, `not_target_vertical`, `outside_geography`) |
| Failed                                         | 0                                                                          |
| Prospects created                              | 91                                                                         |
| Demos built                                    | 91                                                                         |
| **Duplicate prospects created**                | **0**                                                                      |
| **Duplicate demos created**                    | **0**                                                                      |
| **Outreach performed**                         | **0**                                                                      |

## Invariants asserted by the test

- Exactly one prospect per accepted canonical domain (no duplicates) — proven directly and
  under two concurrent workers (`concurrency.test.ts`).
- Every accepted prospect reached `demo_ready` and no further (lifecycle cap holds).
- One active demo per prospect (no duplicate demos).
- Every rejection/duplicate carries an explainable reason code.
- Same-name/different-locality businesses are not merged.
- Transient provider failures retry then complete; exceeding the retry cap fails terminally.
- The mission resumes after interruption without duplicating prospects.
- **Zero outreach**: no prospect event is an outreach/send of any kind, and the discovery
  slice imports no provider/outreach subsystem (`no-provider.test.ts`).

## Not claimed

This is not evidence of behaviour against a live discovery source. A lawful, separately
approved live sample may be run later; until then all discovery evidence is explicitly
simulated.
