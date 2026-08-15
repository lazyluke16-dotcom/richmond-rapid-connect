import { beforeEach, describe, expect, it } from "vitest";
import { InMemoryProspectStore } from "../../prospect/store";
import { FixtureDiscoveryProvider } from "../fixture-provider";
import { InMemoryMissionStore } from "../mission-store";
import { ProviderRegistry } from "../provider";
import {
  advanceMission,
  cancelMission,
  pauseMission,
  runMissionToCompletion,
  startMission,
  type EngineDeps,
} from "../mission-engine";
import {
  RICHMOND_GEO_TERMS,
  buildDiscoveryCandidates,
  expectedAcceptedDomains,
  fakeFetchForCandidates,
} from "./fixtures";
import type { RawDiscoveryCandidate } from "../types";

const CLOCK = () => "2026-08-15T00:00:00.000Z";

interface Harness {
  deps: EngineDeps;
  missionStore: InMemoryMissionStore;
  prospectStore: InMemoryProspectStore;
}

function harness(
  candidates: RawDiscoveryCandidate[],
  opts: {
    pageSize?: number;
    transientFailures?: Record<number, number>;
    costCentsPerPage?: number;
  } = {},
): Harness {
  const missionStore = new InMemoryMissionStore(CLOCK);
  const prospectStore = new InMemoryProspectStore(CLOCK);
  const registry = new ProviderRegistry();
  registry.register(
    new FixtureDiscoveryProvider({
      name: "import",
      candidates,
      pageSize: opts.pageSize ?? 25,
      transientFailures: opts.transientFailures,
      costCentsPerPage: opts.costCentsPerPage ?? 0,
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
    pageSize: opts.pageSize ?? 25,
  };
  return { deps, missionStore, prospectStore };
}

async function createMission(
  h: Harness,
  candidates: RawDiscoveryCandidate[],
  overrides: Partial<{
    targetCount: number;
    maxCandidates: number;
    costCeilingCents: number | null;
  }> = {},
) {
  return h.missionStore.createMission({
    vertical: "plumbing",
    geography: "Richmond, VIC",
    geoTerms: RICHMOND_GEO_TERMS,
    targetCount: overrides.targetCount ?? 500,
    maxCandidates: overrides.maxCandidates ?? 5000,
    sources: ["import"],
    costCeilingCents: overrides.costCeilingCents ?? null,
    maxRetries: 3,
    createdBy: "op-1",
    importSeed: candidates,
  });
}

describe("mission lifecycle", () => {
  let h: Harness;
  let candidates: RawDiscoveryCandidate[];

  beforeEach(() => {
    candidates = [
      {
        source: "import",
        providerBusinessId: "a",
        businessName: "Ace Plumbing",
        website: "https://ace-plumbing.com.au",
        locality: "Richmond",
        vertical: "plumbing",
      },
    ];
    h = harness(candidates);
  });

  it("a paused mission does no work until resumed", async () => {
    const mission = await createMission(h, candidates);
    await startMission(h.deps, mission.id);
    await pauseMission(h.deps, mission.id);
    const result = await advanceMission(h.deps, mission.id);
    expect(result.status).toBe("paused");
    expect(result.processed).toBe(0);
    expect((await h.prospectStore.list()).length).toBe(0);
  });

  it("a cancelled mission cannot be advanced", async () => {
    const mission = await createMission(h, candidates);
    await startMission(h.deps, mission.id);
    await cancelMission(h.deps, mission.id);
    const result = await advanceMission(h.deps, mission.id);
    expect(result.status).toBe("cancelled");
    expect((await h.prospectStore.list()).length).toBe(0);
  });

  it("cannot pause a mission that is not running", async () => {
    const mission = await createMission(h, candidates);
    await expect(pauseMission(h.deps, mission.id)).rejects.toThrow();
  });
});

describe("mission engine end-to-end", () => {
  it("processes a full messy batch into demo-ready prospects with no duplicates", async () => {
    const candidates = buildDiscoveryCandidates();
    const h = harness(candidates, { pageSize: 20 });
    const mission = await createMission(h, candidates);
    await startMission(h.deps, mission.id);
    const final = await runMissionToCompletion(h.deps, mission.id, { maxSteps: 100 });

    expect(final.status).toBe("completed");
    const expectedAccepted = expectedAcceptedDomains().length; // 91
    expect(final.counts.demoReady).toBe(expectedAccepted);

    // No duplicate prospects: exactly one prospect per accepted domain.
    const prospects = await h.prospectStore.list();
    expect(prospects.length).toBe(expectedAccepted);
    expect(new Set(prospects.map((p) => p.canonicalDomain)).size).toBe(expectedAccepted);
    // Every accepted prospect reached demo_ready (lifecycle cap holds).
    expect(prospects.every((p) => p.status === "demo_ready")).toBe(true);

    // Rejections carry explainable reasons.
    const rejected = await h.missionStore.listCandidates(mission.id, { disposition: "rejected" });
    const reasons = new Set(rejected.map((c) => c.reason));
    expect(reasons.has("no_website")).toBe(true);
    expect(reasons.has("unsafe_url")).toBe(true);
    expect(reasons.has("not_target_vertical")).toBe(true);
    expect(reasons.has("outside_geography")).toBe(true);

    // A phone-only duplicate is marked duplicate (cross-dimension).
    const duplicates = await h.missionStore.listCandidates(mission.id, {
      disposition: "duplicate",
    });
    expect(duplicates.some((c) => c.reason === "duplicate_phone")).toBe(true);
  });

  it("stops at the target count", async () => {
    const candidates = buildDiscoveryCandidates();
    const h = harness(candidates, { pageSize: 10 });
    const mission = await createMission(h, candidates, { targetCount: 5 });
    await startMission(h.deps, mission.id);
    const final = await runMissionToCompletion(h.deps, mission.id, { maxSteps: 100 });
    expect(final.status).toBe("completed");
    expect(final.counts.demoReady).toBe(5);
    expect((await h.prospectStore.list()).length).toBe(5);
  });

  it("stops at the hard max-candidate cap", async () => {
    const candidates = buildDiscoveryCandidates();
    const h = harness(candidates, { pageSize: 10 });
    const mission = await createMission(h, candidates, { targetCount: 500, maxCandidates: 12 });
    await startMission(h.deps, mission.id);
    const final = await runMissionToCompletion(h.deps, mission.id, { maxSteps: 100 });
    expect(final.status).toBe("completed");
    expect(final.counts.discovered).toBeLessThanOrEqual(12);
  });

  it("stops at the metered cost ceiling", async () => {
    const candidates = buildDiscoveryCandidates();
    const h = harness(candidates, { pageSize: 5, costCentsPerPage: 100 });
    const mission = await createMission(h, candidates, { targetCount: 500, costCeilingCents: 250 });
    await startMission(h.deps, mission.id);
    const final = await runMissionToCompletion(h.deps, mission.id, { maxSteps: 100 });
    expect(final.status).toBe("completed");
    expect(final.costCents).toBeGreaterThan(250);
    // It stopped early on cost, not after processing everything.
    expect(final.counts.discovered).toBeLessThan(candidates.length);
  });

  it("retries transient provider failures then completes", async () => {
    const candidates = buildDiscoveryCandidates();
    const h = harness(candidates, { pageSize: 20, transientFailures: { 0: 2 } });
    const mission = await createMission(h, candidates);
    await startMission(h.deps, mission.id);
    const final = await runMissionToCompletion(h.deps, mission.id, { maxSteps: 200 });
    expect(final.status).toBe("completed");
    expect(final.retryCount).toBe(0); // reset after eventual success
    expect(final.counts.demoReady).toBe(expectedAcceptedDomains().length);
  });

  it("fails terminally when transient failures exceed the retry cap", async () => {
    const candidates = buildDiscoveryCandidates();
    const h = harness(candidates, { pageSize: 20, transientFailures: { 0: 99 } });
    const mission = await createMission(h, candidates, { targetCount: 500 });
    // maxRetries is 3.
    await startMission(h.deps, mission.id);
    const final = await runMissionToCompletion(h.deps, mission.id, { maxSteps: 20 });
    expect(final.status).toBe("failed");
    expect(final.lastError).toContain("Transient");
  });

  it("resumes after interruption without duplicating prospects", async () => {
    const candidates = buildDiscoveryCandidates();
    const h = harness(candidates, { pageSize: 7 });
    const mission = await createMission(h, candidates);
    await startMission(h.deps, mission.id);
    // Advance only a few steps (simulate interruption).
    for (let i = 0; i < 3; i++) await advanceMission(h.deps, mission.id);
    const midProspects = (await h.prospectStore.list()).length;
    expect(midProspects).toBeGreaterThan(0);
    // Resume to completion.
    const final = await runMissionToCompletion(h.deps, mission.id, { maxSteps: 100 });
    expect(final.status).toBe("completed");
    const prospects = await h.prospectStore.list();
    expect(prospects.length).toBe(expectedAcceptedDomains().length);
    expect(new Set(prospects.map((p) => p.canonicalDomain)).size).toBe(prospects.length);
  });

  it("does not re-research a business that is already a prospect", async () => {
    const candidates: RawDiscoveryCandidate[] = [
      {
        source: "import",
        providerBusinessId: "x",
        businessName: "Existing Plumbing",
        website: "https://existing-plumbing.com.au",
        locality: "Richmond",
        vertical: "plumbing",
      },
    ];
    const h = harness(candidates);
    // Pre-create the prospect.
    await h.prospectStore.create({
      canonicalDomain: "existing-plumbing.com.au",
      website: "https://existing-plumbing.com.au",
      businessName: "Existing Plumbing",
      industry: "plumbing",
    });
    const mission = await createMission(h, candidates);
    await startMission(h.deps, mission.id);
    await runMissionToCompletion(h.deps, mission.id, { maxSteps: 10 });
    const [candidate] = await h.missionStore.listCandidates(mission.id);
    expect(candidate.disposition).toBe("duplicate");
    expect(candidate.reason).toBe("existing_prospect");
    // No second prospect, and no demo was built for the existing one by discovery.
    expect((await h.prospectStore.list()).length).toBe(1);
  });
});
