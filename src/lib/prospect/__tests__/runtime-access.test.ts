import { beforeEach, describe, expect, it } from "vitest";
import { classifyIntent, describeVoiceStub, respond, SharedDemoRuntime } from "../shared-runtime";
import { DemoAccessService } from "../demo-access";
import { InMemoryProspectStore } from "../store";
import { generateDemoConfig } from "../demo-config";
import { buildBranding } from "../brand";
import { hashDemoToken } from "../slug";
import type { DemoConfig, ProspectFact } from "../types";

function verified(
  factType: ProspectFact["factType"],
  value: string,
  normalized = value.toLowerCase(),
): ProspectFact {
  return {
    factType,
    value,
    normalizedValue: normalized,
    status: "verified",
    confidence: 0.9,
    extractor: "deterministic-html",
    evidence: {
      sourceUrl: "https://x.com.au/",
      observedContext: "",
      retrievedAt: "2026-08-15T00:00:00Z",
      confidence: 0.9,
    },
  };
}

const branding = buildBranding({
  domain: "richmondrapid.com.au",
  nameCandidates: [],
  themeColours: [],
  verifiedLogoUrl: null,
  faviconUrl: null,
});

function sampleConfig(): DemoConfig {
  return generateDemoConfig({
    businessName: "Richmond Rapid Plumbing",
    facts: [
      verified("service", "Blocked drains"),
      verified("service_area", "Richmond"),
      verified("emergency_service", "yes"),
    ],
    branding,
    generatedAt: "2026-08-15T00:00:00Z",
  });
}

describe("shared demo runtime", () => {
  const config = sampleConfig();

  it("classifies intents deterministically", () => {
    expect(classifyIntent("How much does it cost?")).toBe("price_query");
    expect(classifyIntent("Are you open on weekends?")).toBe("hours_query");
    expect(classifyIntent("Do you cover Kew?")).toBe("area_query");
    expect(classifyIntent("My drain is blocked")).toBe("service_query");
    expect(classifyIntent("I need someone urgently right now")).toBe("emergency_query");
  });

  it("never quotes a price and defers it to the business", () => {
    const turn = respond(config, "What do you charge for a blocked drain?");
    expect(turn.intent).toBe("price_query");
    expect(turn.deferredUnknown).toBe(true);
    expect(turn.reply).not.toMatch(/\$\d/);
  });

  it("uses only verified services and areas", () => {
    expect(respond(config, "do you fix blocked drains?").reply.toLowerCase()).toContain(
      "blocked drains",
    );
    expect(respond(config, "which suburbs do you cover?").reply).toContain("Richmond");
  });

  it("defers unknown opening hours instead of inventing them", () => {
    const turn = respond(config, "what time do you open?");
    expect(turn.deferredUnknown).toBe(true);
    expect(turn.reply.toLowerCase()).toContain("details");
  });

  it("documents the deferred voice stub without faking readiness", () => {
    const stub = describeVoiceStub();
    expect(stub.supported).toBe(false);
    expect(stub.requires.length).toBeGreaterThan(0);
  });
});

describe("DemoAccessService fail-closed", () => {
  let store: InMemoryProspectStore;
  let service: DemoAccessService;
  let now: number;
  const token = "the-real-unguessable-token-value-1234567890";

  beforeEach(async () => {
    now = Date.parse("2026-08-15T00:00:00Z");
    store = new InMemoryProspectStore(() => new Date(now).toISOString());
    service = new DemoAccessService(store, () => now);
    const prospect = await store.create({
      canonicalDomain: "richmondrapid.com.au",
      website: "https://richmondrapid.com.au",
      businessName: "Richmond Rapid Plumbing",
      industry: "plumbing",
    });
    await store.insertDemo({
      id: "demo-1",
      prospectId: prospect.id,
      version: 1,
      slug: "richmond-rapid-abcd",
      tokenHash: await hashDemoToken(token),
      config: sampleConfig(),
      expiresAt: new Date(now + 86_400_000).toISOString(),
      revokedAt: null,
    });
  });

  it("resolves with the correct slug + token", async () => {
    const result = await service.resolve("richmond-rapid-abcd", token);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.config.businessName).toBe("Richmond Rapid Plumbing");
  });

  it("denies an unknown slug", async () => {
    expect(await service.resolve("nope", token)).toMatchObject({ ok: false, reason: "not_found" });
  });

  it("denies a wrong token (isolation between prospects)", async () => {
    expect(await service.resolve("richmond-rapid-abcd", "wrong-token")).toMatchObject({
      ok: false,
      reason: "invalid_token",
    });
  });

  it("denies an expired demo", async () => {
    now = Date.parse("2026-09-01T00:00:00Z");
    expect(await service.resolve("richmond-rapid-abcd", token)).toMatchObject({
      ok: false,
      reason: "expired",
    });
  });

  it("denies a revoked demo", async () => {
    await service.revokeForProspect((await store.findByDomain("richmondrapid.com.au"))!.id);
    expect(await service.resolve("richmond-rapid-abcd", token)).toMatchObject({
      ok: false,
      reason: "revoked",
    });
  });

  it("SharedDemoRuntime loads a config and answers", async () => {
    const runtime = new SharedDemoRuntime(store);
    const config = await runtime.loadConfig((await store.findByDomain("richmondrapid.com.au"))!.id);
    expect(config?.businessName).toBe("Richmond Rapid Plumbing");
  });
});
