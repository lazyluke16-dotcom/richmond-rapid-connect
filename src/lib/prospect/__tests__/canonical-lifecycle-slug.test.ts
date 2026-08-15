import { describe, expect, it } from "vitest";
import {
  canonicalDomain,
  displayNameFromDomain,
  normalizeWebsiteInput,
  tryCanonicalDomain,
} from "../canonical";
import {
  assertV1Transition,
  canTransition,
  isFutureStatus,
  isV1ReachableStatus,
  V1_TERMINAL_STATUS,
} from "../lifecycle";
import {
  buildDemoSlug,
  generateDemoToken,
  hashDemoToken,
  slugifyBusinessName,
  timingSafeHexEqual,
} from "../slug";

describe("canonical domain (dedup key)", () => {
  it("normalises scheme, www, case and trailing dot to one key", () => {
    const variants = [
      "https://www.ExamplePlumbing.com.au/",
      "http://exampleplumbing.com.au",
      "exampleplumbing.com.au",
      "https://www.exampleplumbing.com.au./services",
    ];
    for (const variant of variants) expect(canonicalDomain(variant)).toBe("exampleplumbing.com.au");
  });

  it("normalizeWebsiteInput adds https and strips the hash", () => {
    expect(normalizeWebsiteInput("exampleplumbing.com.au")).toBe("https://exampleplumbing.com.au/");
    expect(normalizeWebsiteInput("https://x.com.au/a#frag")).toBe("https://x.com.au/a");
  });

  it("rejects domains without a dot", () => {
    expect(tryCanonicalDomain("localhost")).toBeNull();
    expect(() => canonicalDomain("")).toThrow();
  });

  it("derives a display name from a domain", () => {
    expect(displayNameFromDomain("rapid-richmond-plumbing.com.au")).toBe("Rapid Richmond Plumbing");
  });
});

describe("lifecycle V1 cap", () => {
  it("recognises V1 vs future statuses", () => {
    expect(isV1ReachableStatus("demo_ready")).toBe(true);
    expect(isV1ReachableStatus("customer")).toBe(false);
    expect(isFutureStatus("outreach_approved")).toBe(true);
    expect(V1_TERMINAL_STATUS).toBe("demo_ready");
  });

  it("permits the forward V1 path", () => {
    expect(canTransition("discovered", "researching")).toBe(true);
    expect(canTransition("researching", "enriched")).toBe(true);
    expect(canTransition("enriched", "demo_building")).toBe(true);
    expect(canTransition("demo_building", "demo_ready")).toBe(true);
  });

  it("refuses to advance beyond demo_ready", () => {
    expect(() => assertV1Transition("demo_ready", "outreach_approved")).toThrow(
      /stops at "demo_ready"/,
    );
    expect(() => assertV1Transition("demo_ready", "contacted")).toThrow();
    expect(canTransition("demo_ready", "demo_ready")).toBe(true);
  });

  it("rejects illegal skips", () => {
    expect(() => assertV1Transition("discovered", "demo_ready")).toThrow(/Illegal/);
  });
});

describe("demo slug + token", () => {
  it("slugifies to the DB-allowed shape", () => {
    expect(slugifyBusinessName("Richmond Rapid Plumbing!")).toMatch(/^[a-z0-9][a-z0-9-]+$/);
    expect(buildDemoSlug("A")).toMatch(/^[a-z0-9][a-z0-9-]{2,80}$/);
  });

  it("generates a high-entropy token and a 64-hex hash", async () => {
    const a = generateDemoToken();
    const b = generateDemoToken();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(40);
    const hash = await hashDemoToken(a);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(await hashDemoToken(a)).toBe(hash); // deterministic
    expect(await hashDemoToken(b)).not.toBe(hash);
  });

  it("compares hashes without early exit", () => {
    expect(timingSafeHexEqual("aa", "aa")).toBe(true);
    expect(timingSafeHexEqual("aa", "ab")).toBe(false);
    expect(timingSafeHexEqual("aa", "aaa")).toBe(false);
  });
});
