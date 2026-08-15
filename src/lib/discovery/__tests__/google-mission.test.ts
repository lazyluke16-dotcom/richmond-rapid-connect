/**
 * Engine-level tests for a Google-Places-sourced mission using a MOCKED provider (no live
 * Google request, no quota). Covers end-to-end discovery→DEMO_READY, place-type filtering,
 * Place-ID dedup, retention metadata, cost accounting, and the single-flight cost ceiling
 * under concurrent advance.
 */
import { describe, expect, it } from "vitest";
import { InMemoryProspectStore } from "../../prospect/store";
import { GooglePlacesProvider } from "../google-places-provider";
import { InMemoryMissionStore } from "../mission-store";
import { ProviderRegistry } from "../provider";
import {
  advanceMission,
  runMissionToCompletion,
  startMission,
  type EngineDeps,
} from "../mission-engine";

const CLOCK = () => "2026-08-15T00:00:00.000Z";

function place(
  id: string,
  name: string,
  domain: string | null,
  primaryType = "plumber",
  locality = "Richmond",
) {
  return {
    id,
    displayName: { text: name },
    websiteUri: domain ? `https://${domain}` : undefined,
    formattedAddress: `${locality} VIC`,
    addressComponents: [{ longText: locality, types: ["locality"] }],
    primaryType,
    types: [primaryType, "point_of_interest"],
  };
}

/** Mocked Google Text Search: two pages, plus a supplier, a dup Place ID and a no-website place. */
function googleFetch(): typeof fetch {
  const page1 = {
    places: [
      place("ChIJ_1", "GP Plumbing 1", "gp-plumber-1.com.au"),
      place("ChIJ_2", "GP Plumbing 2", "gp-plumber-2.com.au"),
      place("ChIJ_supply", "Plumbing Supplies Warehouse", "supplies.com.au", "hardware_store"),
      place("ChIJ_nosite", "No Website Plumbing", null),
    ],
    nextPageToken: "PAGE2",
  };
  const page2 = {
    places: [
      place("ChIJ_3", "GP Plumbing 3", "gp-plumber-3.com.au"),
      place("ChIJ_1", "GP Plumbing 1 (dup place id)", "gp-plumber-1.com.au"), // duplicate Place ID
    ],
  };
  const impl = async (_url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse((init?.body as string) ?? "{}");
    const payload = body.pageToken === "PAGE2" ? page2 : page1;
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return impl as unknown as typeof fetch;
}

/** Fake website fetch for the plumbers' own sites (Slice-1 research). */
function siteFetch(): typeof fetch {
  const html = (name: string) =>
    `<!doctype html><html><head><title>${name}</title></head><body><h1>${name}</h1>` +
    `<a href="tel:0390000000">call</a><ul><li>Blocked drains</li></ul><p>Servicing Richmond.</p></body></html>`;
  const impl = async (input: RequestInfo | URL): Promise<Response> => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const m = /gp-plumber-(\d)\.com\.au/.exec(url);
    if (m)
      return new Response(html(`GP Plumbing ${m[1]}`), {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    return new Response("not found", { status: 404 });
  };
  return impl as unknown as typeof fetch;
}

function harness(costCeilingCents: number | null, perRequestCostCents = 4) {
  const missionStore = new InMemoryMissionStore(CLOCK);
  const prospectStore = new InMemoryProspectStore(CLOCK);
  const registry = new ProviderRegistry();
  registry.register(
    new GooglePlacesProvider({
      apiKey: "test-key",
      fetchImpl: googleFetch(),
      perRequestCostCents,
      pageSize: 20,
    }),
  );
  const deps: EngineDeps = {
    missionStore,
    prospectStore,
    registry,
    fetchImpl: siteFetch(),
    dnsLookup: async () => [],
    clock: CLOCK,
    baseUrl: "https://rapidconnect.example",
    demoTtlDays: 30,
    pageSize: 20,
    leaseTtlMs: 60_000,
  };
  return { deps, missionStore, prospectStore, costCeilingCents };
}

async function createGoogleMission(
  missionStore: InMemoryMissionStore,
  costCeilingCents: number | null,
) {
  return missionStore.createMission({
    vertical: "plumbing",
    geography: "Richmond, VIC",
    geoTerms: ["richmond"],
    targetCount: 500,
    maxCandidates: 100,
    sources: ["google_places"],
    costCeilingCents,
    maxRetries: 3,
    createdBy: "op-1",
    importSeed: [],
  });
}

describe("Google-Places mission (mocked)", () => {
  it("discovers plumbers, filters suppliers, dedups Place IDs, and builds demos", async () => {
    const { deps, missionStore, prospectStore } = harness(null);
    const mission = await createGoogleMission(missionStore, null);
    await startMission(deps, mission.id);
    const final = await runMissionToCompletion(deps, mission.id, { maxSteps: 50 });

    expect(final.status).toBe("completed");
    // 3 real plumbers with websites → 3 demos. Supplier + no-website rejected; dup Place ID collapsed.
    const prospects = await prospectStore.list();
    expect(prospects.length).toBe(3);
    expect(prospects.every((p) => p.status === "demo_ready")).toBe(true);
    expect(new Set(prospects.map((p) => p.canonicalDomain)).size).toBe(3);

    const rejected = await missionStore.listCandidates(mission.id, { disposition: "rejected" });
    const reasons = new Set(rejected.map((c) => c.reason));
    expect(reasons.has("not_target_vertical")).toBe(true); // supplier
    expect(reasons.has("no_website")).toBe(true); // no-website plumber

    // Cost accounted from the provider estimate (2 pages × 4c).
    expect(final.costCents).toBe(8);

    // COMPLIANCE: no Google Maps Content (name/address/locality/sourceUrl) is ever persisted —
    // only the durable Place ID + website + derived domain. Qualification used transient values.
    const all = await missionStore.listCandidates(mission.id);
    expect(all.every((c) => c.businessName === null)).toBe(true);
    expect(all.every((c) => c.locality === null)).toBe(true);
    expect(all.every((c) => c.sourceUrl === null)).toBe(true);
    expect(all.every((c) => c.providerBusinessId?.startsWith("ChIJ"))).toBe(true);
    expect(all.filter((c) => c.disposition === "demo_ready").every((c) => c.website !== null)).toBe(
      true,
    );
    // Retention backstop still stamped on Google candidates.
    expect(all.every((c) => c.providerContentExpiresAt !== null)).toBe(true);

    // Zero outreach across all built prospects.
    let outreach = 0;
    for (const p of prospects) {
      for (const e of await prospectStore.listEvents(p.id)) {
        if (/outreach|sms|email|call|sent/i.test(e.type)) outreach += 1;
      }
    }
    expect(outreach).toBe(0);
  });

  it("never exceeds the spend ceiling and stops with cost_ceiling_reached", async () => {
    // Ceiling 4c allows exactly one 4c request; the pre-request gate blocks the 2nd page.
    const { deps, missionStore } = harness(4);
    const mission = await createGoogleMission(missionStore, 4);
    await startMission(deps, mission.id);
    const final = await runMissionToCompletion(deps, mission.id, { maxSteps: 50 });
    expect(final.status).toBe("completed");
    expect(final.costCents).toBeLessThanOrEqual(4);
  });

  it("cannot exceed the ceiling under two concurrent workers (single-flight lease)", async () => {
    const { deps, missionStore } = harness(12); // allows 3 requests
    const mission = await createGoogleMission(missionStore, 12);
    await startMission(deps, mission.id);
    await Promise.all([
      runMissionToCompletion(deps, mission.id, { maxSteps: 50 }),
      runMissionToCompletion(deps, mission.id, { maxSteps: 50 }),
    ]);
    const final = (await missionStore.getMission(mission.id))!;
    // Only one advance runs at a time, so cost is charged once per page and never exceeds 12c.
    expect(final.costCents).toBeLessThanOrEqual(12);
  });

  it("purges expired Google-derived content while keeping Place ID + website", async () => {
    const { deps, missionStore } = harness(null);
    const mission = await createGoogleMission(missionStore, null);
    await startMission(deps, mission.id);
    await runMissionToCompletion(deps, mission.id, { maxSteps: 50 });

    const purged = await missionStore.purgeExpiredProviderContent("2026-10-01T00:00:00.000Z"); // past +30d
    expect(purged).toBeGreaterThan(0);
    const all = await missionStore.listCandidates(mission.id);
    // Google display content nulled; durable Place ID + website retained.
    const demoReady = all.filter((c) => c.disposition === "demo_ready");
    expect(demoReady.every((c) => c.businessName === null && c.locality === null)).toBe(true);
    expect(demoReady.every((c) => c.providerBusinessId?.startsWith("ChIJ"))).toBe(true);
    expect(demoReady.every((c) => c.website !== null)).toBe(true);
  });

  it("acquiring a held lease blocks a second concurrent advance", async () => {
    const { deps, missionStore } = harness(null);
    const mission = await createGoogleMission(missionStore, null);
    await startMission(deps, mission.id);
    const token = "a".repeat(32);
    expect(await missionStore.acquireLease(mission.id, token, CLOCK(), 60_000)).toBe(true);
    // A second acquire while the first is held must fail.
    expect(await missionStore.acquireLease(mission.id, "b".repeat(32), CLOCK(), 60_000)).toBe(
      false,
    );
    // An advance cannot run while the lease is held elsewhere.
    const result = await advanceMission(deps, mission.id);
    expect(result.processed).toBe(0);
    await missionStore.releaseLease(mission.id, token);
  });

  it("renews the lease only for the holding token (heartbeat)", async () => {
    const { missionStore } = harness(null);
    const mission = await createGoogleMission(missionStore, null);
    expect(await missionStore.acquireLease(mission.id, "a".repeat(32), CLOCK(), 60_000)).toBe(true);
    // Wrong token cannot renew.
    expect(await missionStore.renewLease(mission.id, "b".repeat(32), CLOCK(), 60_000)).toBe(false);
    // Holder can renew (extends expiry); a fresh acquire still fails while held.
    expect(await missionStore.renewLease(mission.id, "a".repeat(32), CLOCK(), 60_000)).toBe(true);
    expect(await missionStore.acquireLease(mission.id, "c".repeat(32), CLOCK(), 60_000)).toBe(
      false,
    );
  });

  it("floors the per-request cost estimate at 1 so the spend gate can't be disabled", async () => {
    // Even with a 0 configured estimate, the gate must still stop after the first request.
    const missionStore = new InMemoryMissionStore(CLOCK);
    const prospectStore = new InMemoryProspectStore(CLOCK);
    const registry = new ProviderRegistry();
    const provider = new GooglePlacesProvider({
      apiKey: "k",
      fetchImpl: googleFetch(),
      perRequestCostCents: 0,
    });
    expect(provider.estimatedRequestCostCents).toBe(1);
    registry.register(provider);
    const deps: EngineDeps = {
      missionStore,
      prospectStore,
      registry,
      fetchImpl: siteFetch(),
      dnsLookup: async () => [],
      clock: CLOCK,
      baseUrl: "https://rapidconnect.example",
      pageSize: 20,
    };
    const mission = await createGoogleMission(missionStore, 1); // ceiling 1c
    await startMission(deps, mission.id);
    const final = await runMissionToCompletion(deps, mission.id, { maxSteps: 50 });
    expect(final.status).toBe("completed");
    expect(final.costCents).toBeLessThanOrEqual(1);
  });
});
