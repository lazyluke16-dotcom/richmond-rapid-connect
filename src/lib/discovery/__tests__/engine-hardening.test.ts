/**
 * Adversarial regression tests for defects found in independent review of Slice 2:
 *  - a misbehaving provider (empty pages + non-null cursor forever) must still terminate;
 *  - a concurrent cancel during an advance must NOT be overridden to completed;
 *  - a candidate stuck 'accepted' by a crashed build is recovered on the next advance;
 *  - malformed provider usage (NaN/negative cost) is sanitised, not propagated;
 *  - geography must not match against the business name (out-of-area false positive).
 */
import { describe, expect, it } from "vitest";
import { InMemoryProspectStore } from "../../prospect/store";
import { FixtureDiscoveryProvider } from "../fixture-provider";
import { InMemoryMissionStore } from "../mission-store";
import { ProviderRegistry, type DiscoveryPage, type DiscoveryProvider } from "../provider";
import {
  advanceMission,
  cancelMission,
  runMissionToCompletion,
  startMission,
  type EngineDeps,
} from "../mission-engine";
import { qualifyCandidate } from "../qualify";
import { normalizeCandidate } from "../normalize";
import { fakeFetchForCandidates } from "./fixtures";
import type { RawDiscoveryCandidate } from "../types";

const CLOCK = () => "2026-08-15T00:00:00.000Z";

function baseDeps(
  registry: ProviderRegistry,
  candidates: RawDiscoveryCandidate[],
  pageSize = 10,
): {
  deps: EngineDeps;
  missionStore: InMemoryMissionStore;
  prospectStore: InMemoryProspectStore;
} {
  const missionStore = new InMemoryMissionStore(CLOCK);
  const prospectStore = new InMemoryProspectStore(CLOCK);
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
  return { deps, missionStore, prospectStore };
}

async function newMission(
  missionStore: InMemoryMissionStore,
  seed: RawDiscoveryCandidate[],
  overrides: Partial<{
    targetCount: number;
    maxCandidates: number;
    costCeilingCents: number | null;
  }> = {},
) {
  return missionStore.createMission({
    vertical: "plumbing",
    geography: "Richmond, VIC",
    geoTerms: ["richmond"],
    targetCount: overrides.targetCount ?? 500,
    maxCandidates: overrides.maxCandidates ?? 100,
    sources: ["import"],
    costCeilingCents: overrides.costCeilingCents ?? null,
    maxRetries: 3,
    createdBy: null,
    importSeed: seed,
  });
}

describe("provider robustness — infinite pages", () => {
  it("terminates against a provider that returns empty pages with a non-null cursor forever", async () => {
    let calls = 0;
    const evilProvider: DiscoveryProvider = {
      name: "import",
      async search(): Promise<DiscoveryPage> {
        calls += 1;
        return { candidates: [], nextCursor: String(calls), usage: { costCents: 0, requests: 1 } };
      },
    };
    const registry = new ProviderRegistry();
    registry.register(evilProvider);
    const { deps, missionStore } = baseDeps(registry, [], 10);
    const mission = await newMission(missionStore, [], { maxCandidates: 30 });
    await startMission(deps, mission.id);
    const final = await runMissionToCompletion(deps, mission.id, { maxSteps: 10000 });
    // Hard page cap = ceil(30/10)+5 = 8 pages, so it must stop rather than loop forever.
    expect(final.status).toBe("completed");
    expect(calls).toBeLessThanOrEqual(8);
  });
});

describe("concurrent cancel is not overridden", () => {
  it("a cancel during the page fetch is not flipped to completed", async () => {
    const seed = [
      {
        source: "import",
        businessName: "Ace Plumbing",
        website: "https://ace-plumbing.com.au",
        locality: "Richmond",
        vertical: "plumbing",
      },
    ];
    const missionStore = new InMemoryMissionStore(CLOCK);
    const prospectStore = new InMemoryProspectStore(CLOCK);
    const mission = await newMission(missionStore, seed, { targetCount: 1 });
    // A provider that cancels the mission mid-advance (simulating a racing operator cancel)
    // then returns a page that would otherwise complete the mission.
    const cancelDuringSearch: DiscoveryProvider = {
      name: "import",
      async search(): Promise<DiscoveryPage> {
        await cancelMission(
          { missionStore, prospectStore, registry: new ProviderRegistry() },
          mission.id,
        );
        return {
          candidates: seed,
          nextCursor: null,
          usage: { costCents: 0, requests: 1 },
        };
      },
    };
    const registry = new ProviderRegistry();
    registry.register(cancelDuringSearch);
    const deps: EngineDeps = {
      missionStore,
      prospectStore,
      registry,
      fetchImpl: fakeFetchForCandidates(seed),
      dnsLookup: async () => [],
      clock: CLOCK,
      baseUrl: "https://rapidconnect.example",
      pageSize: 10,
    };
    await startMission(deps, mission.id);
    const result = await advanceMission(deps, mission.id);
    // The mission must remain cancelled, not be flipped to completed.
    expect(result.status).toBe("cancelled");
    const finalMission = await missionStore.getMission(mission.id);
    expect(finalMission!.status).toBe("cancelled");
    // A subsequent advance does no further work.
    const again = await advanceMission(deps, mission.id);
    expect(again.status).toBe("cancelled");
    expect(again.processed).toBe(0);
  });
});

describe("crash recovery", () => {
  it("recovers a candidate left 'accepted' by an interrupted build", async () => {
    const seed: RawDiscoveryCandidate[] = [];
    const registry = new ProviderRegistry();
    registry.register(new FixtureDiscoveryProvider({ name: "import", candidates: [] })); // provider exhausted
    const { deps, missionStore, prospectStore } = baseDeps(registry, [
      {
        source: "import",
        businessName: "Recover Plumbing",
        website: "https://recover-plumbing.com.au",
        locality: "Richmond",
        publicPhone: "03 9000 0000",
        vertical: "plumbing",
      },
    ]);
    const mission = await newMission(missionStore, seed);
    // Simulate a crash: the candidate was claimed and marked 'accepted' but its build never
    // finished (no prospect, no demo_ready).
    const claim = await missionStore.claimCandidate({
      missionId: mission.id,
      normalized: normalizeCandidate(
        {
          source: "import",
          businessName: "Recover Plumbing",
          website: "https://recover-plumbing.com.au",
          locality: "Richmond",
          vertical: "plumbing",
        },
        0,
      ),
      discoveryQuery: "Richmond, VIC",
      rawHash: null,
    });
    await missionStore.updateCandidate(claim.record.id, {
      disposition: "accepted",
      reason: "accepted",
    });
    expect((await prospectStore.list()).length).toBe(0);

    await startMission(deps, mission.id);
    await advanceMission(deps, mission.id);

    // Recovery rebuilt it: prospect exists and the candidate is demo_ready.
    const prospects = await prospectStore.list();
    expect(prospects.length).toBe(1);
    expect(prospects[0].status).toBe("demo_ready");
    const [candidate] = await missionStore.listCandidates(mission.id);
    expect(candidate.disposition).toBe("demo_ready");
  });
});

describe("cost sanitisation", () => {
  it("ignores NaN/negative provider usage without breaking or overcharging", async () => {
    const badUsageProvider: DiscoveryProvider = {
      name: "import",
      async search(): Promise<DiscoveryPage> {
        return {
          candidates: [
            {
              source: "import",
              businessName: "Ace Plumbing",
              website: "https://ace-plumbing.com.au",
              locality: "Richmond",
              vertical: "plumbing",
            },
          ],
          nextCursor: null,
          usage: { costCents: Number.NaN, requests: -5 },
        };
      },
    };
    const registry = new ProviderRegistry();
    registry.register(badUsageProvider);
    const seed = [
      {
        source: "import",
        businessName: "Ace Plumbing",
        website: "https://ace-plumbing.com.au",
        locality: "Richmond",
        vertical: "plumbing",
      },
    ];
    const { deps, missionStore } = baseDeps(registry, seed);
    const mission = await newMission(missionStore, seed, { costCeilingCents: 100 });
    await startMission(deps, mission.id);
    const final = await runMissionToCompletion(deps, mission.id, { maxSteps: 20 });
    expect(final.costCents).toBe(0); // NaN sanitised to 0
    expect(final.status).toBe("completed");
  });
});

describe("geography does not match the business name", () => {
  it("rejects an out-of-area business whose NAME contains the target suburb", () => {
    // "Richmond Plumbing" operating in Sydney must not pass a Richmond mission.
    const candidate = normalizeCandidate(
      {
        source: "import",
        businessName: "Richmond Plumbing",
        website: "https://richmond-plumbing-sydney.com.au",
        locality: "Sydney",
        vertical: "plumbing",
      },
      0,
    );
    expect(
      qualifyCandidate(candidate, { vertical: "plumbing", geoTerms: ["richmond"] }),
    ).toMatchObject({
      ok: false,
      reason: "outside_geography",
    });
  });
});
