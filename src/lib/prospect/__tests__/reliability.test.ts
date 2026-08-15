/**
 * Reliability exercise: run the full pipeline against 25 representative AU plumbing
 * fixtures (+ a conflicting-evidence fixture). Asserts the system fails closed on
 * insufficient/conflicting evidence rather than fabricating, and writes a concise report
 * JSON to the OS temp dir which is transcribed into docs/AUTONOMOUS_ACQUISITION_RELIABILITY.md.
 *
 * These are SYNTHETIC fixtures. No live business was contacted and no provider resource
 * was created.
 */
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildProspectDemo } from "../build-demo";
import { InMemoryProspectStore } from "../store";
import { auditDemoConfig } from "../anti-hallucination";
import { buildFixtures, conflictingPhoneFixture, fakeFetchFor } from "./fixtures";

const CLOCK = () => "2026-08-15T00:00:00.000Z";

describe("25-prospect reliability", () => {
  it("builds a safe demo for every fixture and fabricates nothing", async () => {
    const fixtures = [...buildFixtures(), conflictingPhoneFixture()];
    const store = new InMemoryProspectStore(CLOCK);

    const rows: {
      name: string;
      domain: string;
      score: number;
      band: string;
      verifiedFacts: number;
      unknownFacts: number;
      conflictingFacts: number;
      hasDemo: boolean;
      guardViolations: number;
    }[] = [];

    for (const fixture of fixtures) {
      const result = await buildProspectDemo(store, fixture.origin, {
        fetchImpl: fakeFetchFor([fixture]),
        dnsLookup: async () => [],
        clock: CLOCK,
        baseUrl: "https://rapidconnect.example",
        demoTtlDays: 30,
      });
      const prospect = (await store.findByDomain(result.canonicalDomain))!;
      const facts = await store.listFacts(prospect.id);
      const demo = await store.latestDemo(prospect.id);
      const guardViolations = demo ? auditDemoConfig(demo.config, facts).length : 1;

      rows.push({
        name: fixture.name,
        domain: result.canonicalDomain,
        score: result.score,
        band: result.band,
        verifiedFacts: facts.filter((f) => f.status === "verified").length,
        unknownFacts: facts.filter((f) => f.status === "unknown").length,
        conflictingFacts: facts.filter((f) => f.status === "conflicting").length,
        hasDemo: Boolean(demo && !demo.revokedAt),
        guardViolations,
      });
    }

    // Invariants across the whole run.
    expect(rows).toHaveLength(26);
    expect(rows.every((r) => r.hasDemo)).toBe(true);
    expect(rows.every((r) => r.guardViolations === 0)).toBe(true); // nothing fabricated
    expect(rows.every((r) => r.verifiedFacts >= 1)).toBe(true);
    // Unknowns are represented explicitly whenever a material fact is missing. Fully-sourced
    // fixtures legitimately have zero unknowns (nothing to withhold); the run as a whole must
    // still exercise the explicit-unknown path.
    expect(rows.reduce((n, r) => n + r.unknownFacts, 0)).toBeGreaterThan(0);
    expect(rows.some((r) => r.conflictingFacts > 0)).toBe(true); // conflict detected, not resolved silently
    expect((await store.list()).length).toBe(26); // no duplicates

    const summary = {
      generatedAt: CLOCK(),
      note: "Synthetic fixtures. No live business contacted; no provider resource created.",
      total: rows.length,
      builtDemos: rows.filter((r) => r.hasDemo).length,
      guardFailures: rows.reduce((n, r) => n + r.guardViolations, 0),
      withConflicts: rows.filter((r) => r.conflictingFacts > 0).length,
      averageScore: Math.round(rows.reduce((n, r) => n + r.score, 0) / rows.length),
      bandCounts: rows.reduce<Record<string, number>>(
        (acc, r) => ({ ...acc, [r.band]: (acc[r.band] ?? 0) + 1 }),
        {},
      ),
      rows,
    };
    try {
      writeFileSync(
        join(tmpdir(), "prospect-reliability-report.json"),
        JSON.stringify(summary, null, 2),
      );
    } catch {
      // Non-fatal: report emission is best-effort.
    }
  });
});
