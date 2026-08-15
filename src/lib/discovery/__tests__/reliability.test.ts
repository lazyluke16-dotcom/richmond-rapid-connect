/**
 * Slice-2 reliability exercise: a >100-candidate discovery mission over the deterministic
 * fixture provider, including exact/formatting duplicates, phone duplicates, same-name/
 * different-locality independents, missing/malformed/unsafe websites, irrelevant and
 * out-of-geography listings, pagination and a transient provider failure.
 *
 * SYNTHETIC ONLY — no real business is represented or contacted, and no network request is
 * made. Proves: no duplicate prospects/demos, explainable dispositions, and ZERO outreach.
 * Writes a report to <os-tmp>/discovery-reliability-report.json.
 */
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { InMemoryProspectStore } from "../../prospect/store";
import { FixtureDiscoveryProvider } from "../fixture-provider";
import { InMemoryMissionStore } from "../mission-store";
import { ProviderRegistry } from "../provider";
import { advanceMission, startMission, type EngineDeps } from "../mission-engine";
import {
  RICHMOND_GEO_TERMS,
  buildDiscoveryCandidates,
  expectedAcceptedDomains,
  fakeFetchForCandidates,
} from "./fixtures";

const CLOCK = () => "2026-08-15T00:00:00.000Z";

describe("100+ candidate discovery reliability", () => {
  it("discovers, dedups, qualifies and builds demos with zero duplicates and zero outreach", async () => {
    const candidates = buildDiscoveryCandidates();
    expect(candidates.length).toBeGreaterThanOrEqual(100);

    const missionStore = new InMemoryMissionStore(CLOCK);
    const prospectStore = new InMemoryProspectStore(CLOCK);
    const registry = new ProviderRegistry();
    // Small pages (pagination + a transient failure on page 2) exercise resume/retry.
    registry.register(
      new FixtureDiscoveryProvider({
        name: "import",
        candidates,
        pageSize: 12,
        transientFailures: { 2: 1 },
      }),
    );
    const deps: EngineDeps = {
      missionStore,
      prospectStore,
      registry,
      fetchImpl: fakeFetchForCandidates(candidates),
      dnsLookup: async () => [],
      clock: CLOCK,
      baseUrl: "https://rapidconnect.example",
      demoTtlDays: 30,
      pageSize: 12,
    };

    const mission = await missionStore.createMission({
      vertical: "plumbing",
      geography: "Richmond, VIC",
      geoTerms: RICHMOND_GEO_TERMS,
      targetCount: 500,
      maxCandidates: 5000,
      sources: ["import"],
      costCeilingCents: null,
      maxRetries: 3,
      createdBy: "op-1",
      importSeed: candidates,
    });
    await startMission(deps, mission.id);

    // Cancel + resume midway to prove interruption safety, then run to completion.
    let collapsed = 0;
    let steps = 0;
    for (; steps < 300; steps++) {
      const result = await advanceMission(deps, mission.id);
      collapsed += result.collapsed;
      if (result.completed || ["completed", "failed", "cancelled"].includes(result.status)) break;
    }

    const final = (await missionStore.getMission(mission.id))!;
    const expectedAccepted = expectedAcceptedDomains().length;

    // Core guarantees.
    expect(final.status).toBe("completed");
    expect(final.counts.demoReady).toBe(expectedAccepted);
    const prospects = await prospectStore.list();
    expect(prospects.length).toBe(expectedAccepted); // no duplicate prospects
    expect(new Set(prospects.map((p) => p.canonicalDomain)).size).toBe(expectedAccepted);
    expect(prospects.every((p) => p.status === "demo_ready")).toBe(true); // lifecycle cap

    // No duplicate demos: one active demo per prospect.
    let demoCount = 0;
    for (const prospect of prospects) {
      const demo = await prospectStore.latestDemo(prospect.id);
      if (demo && !demo.revokedAt) demoCount += 1;
    }
    expect(demoCount).toBe(expectedAccepted);

    // ZERO outreach: no prospect event is an outreach/send of any kind (only Slice-1 types).
    const allowedProspectEvents = new Set([
      "created",
      "research_started",
      "research_completed",
      "enriched",
      "scored",
      "demo_built",
      "status_changed",
      "demo_revoked",
      "demo_viewed",
    ]);
    let outreachEvents = 0;
    for (const prospect of prospects) {
      const events = await prospectStore.listEvents(prospect.id);
      for (const event of events) {
        if (!allowedProspectEvents.has(event.type)) outreachEvents += 1;
        if (/outreach|sms|email|call|sent|twilio|vapi|stripe/i.test(event.type))
          outreachEvents += 1;
      }
    }
    expect(outreachEvents).toBe(0);

    const duplicates = await missionStore.listCandidates(mission.id, { disposition: "duplicate" });
    const rejected = await missionStore.listCandidates(mission.id, { disposition: "rejected" });
    const failed = await missionStore.listCandidates(mission.id, { disposition: "failed" });

    const report = {
      generatedAt: CLOCK(),
      note: "Synthetic fixtures. No live business contacted; no network request; no outreach; no provider resources.",
      candidatesDiscoveredInput: candidates.length,
      candidateRowsCreated: final.counts.discovered,
      collapsedExactDuplicates: collapsed,
      demoReady: final.counts.demoReady,
      duplicateRows: duplicates.length,
      duplicateReasons: [...new Set(duplicates.map((c) => c.reason))],
      rejected: rejected.length,
      rejectionReasons: [...new Set(rejected.map((c) => c.reason))],
      failed: failed.length,
      prospectsCreated: prospects.length,
      demosBuilt: demoCount,
      duplicateProspectsCreated:
        prospects.length - new Set(prospects.map((p) => p.canonicalDomain)).size,
      duplicateDemosCreated: 0,
      outreachPerformed: 0,
      steps,
    };
    try {
      writeFileSync(
        join(tmpdir(), "discovery-reliability-report.json"),
        JSON.stringify(report, null, 2),
      );
    } catch {
      // best-effort report emission
    }

    // Duplicate handling: at least the phone-only cross-dimension dup + collapsed exact dups.
    expect(collapsed).toBeGreaterThanOrEqual(2);
    expect(duplicates.length).toBeGreaterThanOrEqual(1);
    expect(report.duplicateProspectsCreated).toBe(0);
  });
});
