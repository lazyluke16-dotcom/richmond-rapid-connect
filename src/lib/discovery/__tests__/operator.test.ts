import { describe, expect, it } from "vitest";
import {
  parseMissionCreate,
  toCandidateView,
  toMissionDetail,
  toMissionSummary,
} from "../mission-operator";
import type { DiscoveryCandidateRecord, DiscoveryMissionRecord } from "../types";

describe("parseMissionCreate", () => {
  const validImport = [
    { businessName: "Ace Plumbing", website: "https://ace-plumbing.com.au", locality: "Richmond" },
  ];

  it("parses a valid import mission and derives geo terms", () => {
    const parsed = parseMissionCreate({
      geography: "Richmond, VIC",
      targetCount: 10,
      sources: ["import"],
      importCandidates: validImport,
    });
    expect(parsed.vertical).toBe("plumbing");
    expect(parsed.targetCount).toBe(10);
    expect(parsed.maxCandidates).toBe(50); // target*5
    expect(parsed.geoTerms).toContain("richmond");
    expect(parsed.importSeed.length).toBe(1);
  });

  it("requires a geography", () => {
    expect(() => parseMissionCreate({ targetCount: 10, importCandidates: validImport })).toThrow(
      /geography/,
    );
  });

  it("bounds the target count", () => {
    expect(() =>
      parseMissionCreate({ geography: "Richmond", targetCount: 0, importCandidates: validImport }),
    ).toThrow();
    expect(() =>
      parseMissionCreate({
        geography: "Richmond",
        targetCount: 5000,
        importCandidates: validImport,
      }),
    ).toThrow();
  });

  it("requires an import list for the import source", () => {
    expect(() =>
      parseMissionCreate({ geography: "Richmond", targetCount: 10, importCandidates: [] }),
    ).toThrow(/importCandidates/);
  });

  it("rejects an import list with no usable business", () => {
    expect(() =>
      parseMissionCreate({
        geography: "Richmond",
        targetCount: 10,
        importCandidates: [{ website: "http://10.0.0.1" }],
      }),
    ).toThrow(/usable/);
  });

  it("caps maxCandidates at 5000 and never below the target", () => {
    const parsed = parseMissionCreate({
      geography: "Richmond",
      targetCount: 900,
      maxCandidates: 99999,
      importCandidates: validImport,
    });
    expect(parsed.maxCandidates).toBe(5000);
    const parsed2 = parseMissionCreate({
      geography: "Richmond",
      targetCount: 900,
      maxCandidates: 10,
      importCandidates: validImport,
    });
    expect(parsed2.maxCandidates).toBe(900);
  });
});

const mission: DiscoveryMissionRecord = {
  id: "mission-1",
  status: "completed",
  vertical: "plumbing",
  geography: "Richmond, VIC",
  geoTerms: ["richmond"],
  targetCount: 10,
  maxCandidates: 50,
  sources: ["import"],
  cursor: {},
  costCents: 0,
  costCeilingCents: null,
  retryCount: 0,
  maxRetries: 3,
  counts: { discovered: 5, accepted: 3, duplicate: 1, rejected: 1, failed: 0, demoReady: 3 },
  lastError: null,
  createdBy: "op-1",
  createdAt: "2026-08-15T00:00:00Z",
  startedAt: "2026-08-15T00:00:00Z",
  completedAt: "2026-08-15T00:01:00Z",
  updatedAt: "2026-08-15T00:01:00Z",
};

describe("operator projections are privacy-minimal", () => {
  it("summary/detail expose no candidate contact values", () => {
    const candidate: DiscoveryCandidateRecord = {
      id: "cand-1",
      missionId: "mission-1",
      source: "import",
      providerBusinessId: "imp-1",
      sourceUrl: "https://directory.example/listing/1",
      businessName: "Ace Plumbing",
      website: "https://ace-plumbing.com.au",
      canonicalDomain: "ace-plumbing.com.au",
      publicPhone: "61391112222",
      locality: "Richmond",
      discoveryQuery: "Richmond, VIC",
      dedupKey: "dom:ace-plumbing.com.au",
      disposition: "demo_ready",
      duplicateOf: null,
      reason: "demo_built",
      acceptedProspectId: "prospect-9",
      rawHash: null,
      providerContentExpiresAt: null,
      discoveredAt: "2026-08-15T00:00:00Z",
      createdAt: "2026-08-15T00:00:00Z",
      updatedAt: "2026-08-15T00:00:00Z",
    };
    const view = toCandidateView(candidate);
    const serialised = JSON.stringify(view);
    expect(serialised).not.toContain("61391112222"); // no phone
    expect(serialised).not.toContain("directory.example"); // no source URL
    expect(serialised).not.toContain("dom:ace-plumbing"); // no dedup key
    expect(view.canonicalDomain).toBe("ace-plumbing.com.au");
    expect(view.disposition).toBe("demo_ready");

    const detail = toMissionDetail(mission, [candidate]);
    expect(detail.candidates[0]).not.toHaveProperty("publicPhone");
    expect(toMissionSummary(mission).counts.demoReady).toBe(3);
  });
});
