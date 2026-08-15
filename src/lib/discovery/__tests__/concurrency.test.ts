import { describe, expect, it } from "vitest";
import { InMemoryProspectStore } from "../../prospect/store";
import { FixtureDiscoveryProvider } from "../fixture-provider";
import { InMemoryMissionStore } from "../mission-store";
import { ProviderRegistry } from "../provider";
import {
  advanceMission,
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

const CLOCK = () => "2026-08-15T00:00:00.000Z";

function harness(pageSize: number) {
  const candidates = buildDiscoveryCandidates();
  const missionStore = new InMemoryMissionStore(CLOCK);
  const prospectStore = new InMemoryProspectStore(CLOCK);
  const registry = new ProviderRegistry();
  registry.register(new FixtureDiscoveryProvider({ name: "import", candidates, pageSize }));
  const deps: EngineDeps = {
    missionStore,
    prospectStore,
    registry,
    fetchImpl: fakeFetchForCandidates(candidates),
    dnsLookup: async () => [],
    clock: CLOCK,
    baseUrl: "https://rapidconnect.example",
    pageSize,
  };
  return { deps, missionStore, prospectStore, candidates };
}

describe("concurrent discovery is idempotent", () => {
  it("two workers running the same mission produce no duplicate prospects/demos", async () => {
    const { deps, missionStore, prospectStore, candidates } = harness(8);
    const mission = await missionStore.createMission({
      vertical: "plumbing",
      geography: "Richmond, VIC",
      geoTerms: RICHMOND_GEO_TERMS,
      targetCount: 500,
      maxCandidates: 5000,
      sources: ["import"],
      costCeilingCents: null,
      maxRetries: 3,
      createdBy: null,
      importSeed: candidates,
    });
    await startMission(deps, mission.id);

    // Two workers advance the same mission concurrently.
    await Promise.all([
      runMissionToCompletion(deps, mission.id, { maxSteps: 200 }),
      runMissionToCompletion(deps, mission.id, { maxSteps: 200 }),
    ]);

    const prospects = await prospectStore.list();
    const expected = expectedAcceptedDomains().length;
    // Exactly one prospect per accepted domain — no duplicates from the race.
    expect(prospects.length).toBe(expected);
    expect(new Set(prospects.map((p) => p.canonicalDomain)).size).toBe(expected);

    // No candidate identity was stored twice.
    const identities = await missionStore.listCandidateIdentities(mission.id);
    const domains = identities.map((i) => i.domain).filter(Boolean);
    expect(new Set(domains).size).toBe(domains.length);
  });

  it("two workers claiming the same page do not double-process a candidate", async () => {
    const { deps, missionStore, prospectStore, candidates } = harness(50);
    const mission = await missionStore.createMission({
      vertical: "plumbing",
      geography: "Richmond, VIC",
      geoTerms: RICHMOND_GEO_TERMS,
      targetCount: 500,
      maxCandidates: 5000,
      sources: ["import"],
      costCeilingCents: null,
      maxRetries: 3,
      createdBy: null,
      importSeed: candidates,
    });
    await startMission(deps, mission.id);
    // Both advance the first page simultaneously.
    await Promise.all([advanceMission(deps, mission.id), advanceMission(deps, mission.id)]);
    const prospects = await prospectStore.list();
    expect(new Set(prospects.map((p) => p.canonicalDomain)).size).toBe(prospects.length);
  });
});
