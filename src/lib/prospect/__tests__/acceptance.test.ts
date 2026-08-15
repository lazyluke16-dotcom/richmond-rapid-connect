import { describe, expect, it } from "vitest";
import { buildProspectDemo } from "../build-demo";
import { researchProspect } from "../research";
import { ProspectRepository } from "../repository";
import { InMemoryProspectStore } from "../store";
import { auditDemoConfig } from "../anti-hallucination";
import { generateDemoConfig } from "../demo-config";
import { DemoAccessService } from "../demo-access";
import { buildFixtures, conflictingPhoneFixture, fakeFetchFor, type SiteFixture } from "./fixtures";

const CLOCK = () => "2026-08-15T00:00:00.000Z";

function depsFor(fixtures: SiteFixture[]) {
  return {
    fetchImpl: fakeFetchFor(fixtures),
    dnsLookup: async () => [] as string[],
    clock: CLOCK,
    baseUrl: "https://rapidconnect.example",
    demoTtlDays: 30,
  };
}

describe("acceptance — build a demo from a website with no further input", () => {
  it("produces an evidence-backed prospect, score and a working private demo", async () => {
    const fixture = buildFixtures()[0]; // Example Plumbing 1
    const store = new InMemoryProspectStore(CLOCK);
    const result = await buildProspectDemo(store, fixture.origin, depsFor([fixture]));

    // 1. Identified business + score + band.
    expect(result.businessName).toBeTruthy();
    expect(result.canonicalDomain).toBe("exampleplumbing1.com.au");
    expect(result.score).toBeGreaterThan(0);
    expect(["low", "medium", "high", "priority"]).toContain(result.band);

    // 2. A private demo URL with a one-time token was minted.
    expect(result.demo.url).toMatch(
      /^https:\/\/rapidconnect\.example\/demo\/[a-z0-9-]+\/[A-Za-z0-9_-]+$/,
    );
    expect(result.demo.token.length).toBeGreaterThanOrEqual(40);

    // 3. Facts are evidence-backed; unknowns are explicit, not fabricated.
    const prospect = (await store.findByDomain("exampleplumbing1.com.au"))!;
    const facts = await store.listFacts(prospect.id);
    const verified = facts.filter((f) => f.status === "verified");
    expect(verified.length).toBeGreaterThan(0);
    expect(verified.every((f) => f.evidence?.sourceUrl?.startsWith("http"))).toBe(true);
    expect(facts.some((f) => f.status === "unknown")).toBe(true);

    // 4. Lifecycle reached demo_ready and no further.
    expect(prospect.status).toBe("demo_ready");

    // 5. The demo resolves with slug + token and fails closed otherwise.
    const access = new DemoAccessService(store, () => Date.parse(CLOCK()));
    expect((await access.resolve(result.demo.slug, result.demo.token)).ok).toBe(true);
    expect((await access.resolve(result.demo.slug, "wrong")).ok).toBe(false);

    // 6. No outreach/provider side effects: only lifecycle/research/demo events exist.
    const events = await store.listEvents(prospect.id);
    const allowed = new Set([
      "created",
      "research_started",
      "research_completed",
      "enriched",
      "scored",
      "demo_built",
      "status_changed",
    ]);
    expect(events.every((e) => allowed.has(e.type))).toBe(true);
    expect(events.some((e) => e.type.includes("outreach") || e.type.includes("sent"))).toBe(false);
  });

  it("is idempotent by canonical domain — a second run does not fork a prospect", async () => {
    const fixture = buildFixtures()[1];
    const store = new InMemoryProspectStore(CLOCK);
    const first = await buildProspectDemo(store, fixture.origin, depsFor([fixture]));
    const second = await buildProspectDemo(
      store,
      `https://www.${fixture.origin.replace("https://", "")}/`,
      depsFor([fixture]),
    );
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect((await store.list()).length).toBe(1);
    expect(second.demo.version).toBe(2); // versioned, not duplicated
  });

  it("rejects an SSRF / internal target before creating a prospect", async () => {
    const store = new InMemoryProspectStore(CLOCK);
    await expect(
      buildProspectDemo(store, "http://169.254.169.254/latest/meta-data", depsFor([])),
    ).rejects.toThrow();
    await expect(buildProspectDemo(store, "http://localhost:3000", depsFor([]))).rejects.toThrow();
    expect((await store.list()).length).toBe(0);
  });

  it("marks conflicting evidence rather than fabricating a single value", async () => {
    const fixture = conflictingPhoneFixture();
    const result = await researchProspect(fixture.origin, depsFor([fixture]));
    const phone = result.facts.find((f) => f.factType === "public_phone");
    expect(phone?.status).toBe("conflicting");
  });

  it("every generated demo config passes the anti-hallucination guard", async () => {
    const fixture = buildFixtures()[4];
    const result = await researchProspect(fixture.origin, depsFor([fixture]));
    const config = generateDemoConfig({
      businessName: result.businessName ?? result.branding.displayName,
      facts: result.facts,
      branding: result.branding,
      generatedAt: CLOCK(),
    });
    expect(auditDemoConfig(config, result.facts)).toHaveLength(0);
  });

  it("a rebuild supersedes the prior demo (old token fails closed) and revoke kills all", async () => {
    const fixture = buildFixtures()[1];
    const store = new InMemoryProspectStore(CLOCK);
    const access = new DemoAccessService(store, () => Date.parse(CLOCK()));

    const first = await buildProspectDemo(store, fixture.origin, depsFor([fixture]));
    expect((await access.resolve(first.demo.slug, first.demo.token)).ok).toBe(true);

    // Rebuild: the new link is live, the OLD link must now fail closed (revoked).
    const second = await buildProspectDemo(store, fixture.origin, depsFor([fixture]));
    expect(second.demo.version).toBe(2);
    expect((await access.resolve(second.demo.slug, second.demo.token)).ok).toBe(true);
    expect(await access.resolve(first.demo.slug, first.demo.token)).toMatchObject({
      ok: false,
      reason: "revoked",
    });

    // Revoking the prospect kills every remaining active version.
    const prospectId = (await store.findByDomain(second.canonicalDomain))!.id;
    const revoked = await access.revokeForProspect(prospectId);
    expect(revoked).toBe(1); // only v2 was still active
    expect((await access.resolve(second.demo.slug, second.demo.token)).ok).toBe(false);
    // Idempotent: nothing left to revoke.
    expect(await access.revokeForProspect(prospectId)).toBe(0);
  });
});

describe("ProspectRepository idempotency + lifecycle", () => {
  it("findOrCreate dedups and saveResearch advances discovered→enriched", async () => {
    const store = new InMemoryProspectStore(CLOCK);
    const repo = new ProspectRepository(store, CLOCK);
    const a = await repo.findOrCreate({
      canonicalDomain: "acme.com.au",
      website: "https://acme.com.au",
      businessName: null,
      industry: "plumbing",
    });
    const b = await repo.findOrCreate({
      canonicalDomain: "acme.com.au",
      website: "https://acme.com.au",
      businessName: null,
      industry: "plumbing",
    });
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(a.prospect.id).toBe(b.prospect.id);

    const result = await researchProspect("https://acme.com.au", {
      fetchImpl: fakeFetchFor([
        {
          name: "Acme",
          origin: "https://acme.com.au",
          pages: {
            "https://acme.com.au/": `<html><head><title>Acme Plumbing</title></head><body><a href="tel:0391110000">call</a><ul><li>Blocked drains</li></ul></body></html>`,
          },
          expect: { minServices: 1, hasPhone: true, emergency: "UNKNOWN", hoursKnown: false },
        },
      ]),
      dnsLookup: async () => [],
      clock: CLOCK,
    });
    const saved = await repo.saveResearch(a.prospect.id, result);
    expect(saved.status).toBe("enriched");
    expect(saved.score).not.toBeNull();
    expect((await store.getScore(a.prospect.id))?.factors.length).toBeGreaterThan(0);
  });

  it("refuses to advance a prospect beyond demo_ready", async () => {
    const store = new InMemoryProspectStore(CLOCK);
    const repo = new ProspectRepository(store, CLOCK);
    const { prospect } = await repo.findOrCreate({
      canonicalDomain: "x.com.au",
      website: null,
      businessName: null,
      industry: "plumbing",
    });
    await repo.transition(prospect.id, "researching");
    await repo.transition(prospect.id, "enriched");
    await repo.transition(prospect.id, "demo_building");
    await repo.transition(prospect.id, "demo_ready");
    await expect(repo.transition(prospect.id, "outreach_approved" as never)).rejects.toThrow(
      /demo_ready/,
    );
  });
});
