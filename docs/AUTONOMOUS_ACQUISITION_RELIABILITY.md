# Autonomous Acquisition V1 — Reliability Exercise

This report documents the Slice 1 reliability exercise required by Issue #21 (§17): run the
full pipeline against ≥25 representative Australian plumbing businesses and confirm the system
**fails closed on insufficient/conflicting evidence rather than fabricating data**.

## Important honesty note

These are **synthetic, representative fixtures**, not live businesses. No live business was
contacted, no external network request was made, and no provider resource was created. Live
external crawling of real businesses is deliberately avoided in automated tests (legal/robots/
provider/network constraints, and the no-contact safety boundary). The fixtures are generated
deterministically in `src/lib/prospect/__tests__/fixtures.ts` and vary in completeness to
exercise the fail-closed and anti-hallucination paths. The exercise is reproduced by the
`src/lib/prospect/__tests__/reliability.test.ts` behavioural test, which regenerates the
underlying numbers on every run and writes a machine report to
`<os-tmp>/prospect-reliability-report.json`.

## What was exercised

- **26 businesses**: 25 varied `Example Plumbing N` fixtures + 1 deliberate conflicting-
  evidence fixture.
- Variation across the set: 2–7 services each; ~⅘ publish a phone; ~⅔ advertise emergency
  service; ~¼ publish opening hours; ~½ expose schema.org JSON-LD; a few embed an existing AI
  receptionist/chatbot; the conflicting fixture publishes two different phone numbers on two
  pages.
- Each fixture is put through the real `buildProspectDemo()` entry point with an injected fake
  fetch serving only that fixture's pages, plus real evidence assembly, scoring, demo-config
  generation, the anti-hallucination guard, token minting and demo persistence.

## Results (latest run)

| Metric                                                | Value                                   |
| ----------------------------------------------------- | --------------------------------------- |
| Businesses processed                                  | 26                                      |
| Demos built successfully                              | 26 / 26                                 |
| Anti-hallucination guard failures                     | **0**                                   |
| Prospects with ≥1 verified, evidence-backed fact      | 26 / 26                                 |
| Conflicting-evidence detected (not silently resolved) | 1 (the conflicting fixture)             |
| Duplicate prospects created                           | 0 (deduplicated by canonical domain)    |
| Average deterministic score                           | 79 / 100                                |
| Score bands                                           | priority 17 · high 7 · medium 1 · low 1 |

Representative rows:

| Business            | Score    | Band     | Verified facts | Unknown facts | Conflicting |
| ------------------- | -------- | -------- | -------------- | ------------- | ----------- |
| Example Plumbing 1  | 35       | medium   | 8              | 2             | 0           |
| Example Plumbing 2  | 90       | priority | 9              | 2             | 0           |
| Example Plumbing 3  | 100      | priority | 13             | 1             | 0           |
| Conflicting Plumber | (varies) | —        | ≥1             | ≥1            | 1 (phone)   |

## Invariants asserted by the test

- Every generated demo config passes the anti-hallucination guard (0 fabrications across the
  whole run).
- Every prospect has at least one verified, evidence-backed fact.
- Unknown material facts are represented explicitly; fully-sourced fixtures legitimately have
  zero unknowns (nothing to withhold), and the run as a whole exercises the explicit-unknown
  path.
- Conflicting single-valued evidence is marked `conflicting`, never silently resolved.
- No duplicate prospects are created when the same domain is processed.

## Not claimed

- This is not evidence of behaviour against live third-party websites. A later, separately
  authorised exercise may run a small, robots-respecting sample of real sites; until then, all
  reliability evidence here is explicitly simulated.
