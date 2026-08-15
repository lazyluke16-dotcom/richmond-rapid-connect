import { describe, expect, it } from "vitest";
import { assertDemoConfigSafe, auditDemoConfig } from "../anti-hallucination";
import { DEMO_DISCLOSURE, generateDemoConfig } from "../demo-config";
import { buildBranding } from "../brand";
import type { Branding, ProspectFact } from "../types";

function verified(
  factType: ProspectFact["factType"],
  value: string,
  normalized = value.toLowerCase(),
  confidence = 0.9,
): ProspectFact {
  return {
    factType,
    value,
    normalizedValue: normalized,
    status: "verified",
    confidence,
    extractor: "deterministic-html",
    evidence: {
      sourceUrl: "https://x.com.au/",
      observedContext: "ctx",
      retrievedAt: "2026-08-15T00:00:00Z",
      confidence,
    },
  };
}

function unknown(factType: ProspectFact["factType"]): ProspectFact {
  return {
    factType,
    value: "UNKNOWN",
    normalizedValue: "unknown",
    status: "unknown",
    confidence: 0,
    extractor: "system",
    evidence: null,
  };
}

const branding: Branding = buildBranding({
  domain: "richmondrapid.com.au",
  nameCandidates: [
    { value: "Richmond Rapid Plumbing", context: "", strength: 0.9, extractor: "structured-data" },
  ],
  themeColours: ["#c0392b"],
  verifiedLogoUrl: null,
  faviconUrl: null,
});

describe("generateDemoConfig", () => {
  const facts = [
    verified("service", "Blocked drains"),
    verified("service", "Hot water systems"),
    verified("service_area", "Richmond"),
    verified("emergency_service", "yes"),
    verified("public_phone", "0391112222", "0391112222"),
    unknown("opening_hours"),
  ];
  const config = generateDemoConfig({
    businessName: "Richmond Rapid Plumbing",
    facts,
    branding,
    generatedAt: "2026-08-15T00:00:00Z",
  });

  it("only surfaces verified facts and discloses unknowns", () => {
    expect(config.verifiedServices).toContain("Blocked drains");
    expect(config.emergencyService).toBe("yes");
    expect(config.openingHours).toBe("UNKNOWN");
    expect(config.unknowns).toContain("opening_hours");
    expect(config.disclosure).toBe(DEMO_DISCLOSURE);
  });

  it("attaches provenance for every verified value it shows", () => {
    const services = config.provenance.filter((p) => p.field === "service");
    expect(services.length).toBe(config.verifiedServices.length);
    expect(services.every((p) => p.sourceUrl.startsWith("http"))).toBe(true);
  });

  it("produces service-specific example enquiries backed by verified services", () => {
    expect(config.exampleEnquiries.length).toBeGreaterThan(0);
    expect(config.exampleEnquiries.join(" ").toLowerCase()).toContain("drain");
  });

  it("passes the anti-hallucination guard", () => {
    expect(auditDemoConfig(config, facts)).toHaveLength(0);
    expect(() => assertDemoConfigSafe(config, facts)).not.toThrow();
  });

  it("uses generic enquiries when no service is verified, still guard-safe", () => {
    const sparse = [
      unknown("service"),
      unknown("service_area"),
      unknown("opening_hours"),
      unknown("emergency_service"),
      unknown("public_phone"),
    ];
    const sparseConfig = generateDemoConfig({
      businessName: "Sparse Plumbing",
      facts: sparse,
      branding,
      generatedAt: "2026-08-15T00:00:00Z",
    });
    expect(sparseConfig.verifiedServices).toHaveLength(0);
    expect(sparseConfig.exampleEnquiries.length).toBeGreaterThan(0);
    expect(auditDemoConfig(sparseConfig, sparse)).toHaveLength(0);
  });
});

describe("anti-hallucination guard rejects fabrication", () => {
  const facts = [verified("service", "Blocked drains")];
  const base = generateDemoConfig({
    businessName: "Ace Plumbing",
    facts,
    branding,
    generatedAt: "2026-08-15T00:00:00Z",
  });

  it("rejects fabricated pricing in generated text", () => {
    const tampered = { ...base, greeting: `${base.greeting} Blocked drains from $99 fixed price!` };
    const violations = auditDemoConfig(tampered, facts);
    expect(violations.some((v) => v.code === "fabricated_pricing")).toBe(true);
  });

  it("rejects fabricated guarantees and discounts", () => {
    expect(
      auditDemoConfig({ ...base, greeting: "We guarantee 30 min response!" }, facts).length,
    ).toBeGreaterThan(0);
    expect(
      auditDemoConfig({ ...base, exampleEnquiries: ["Get 20% off today!"] }, facts).length,
    ).toBeGreaterThan(0);
  });

  it("rejects a service that has no verified evidence", () => {
    const tampered = {
      ...base,
      verifiedServices: [...base.verifiedServices, "Solar hot water installation"],
    };
    expect(auditDemoConfig(tampered, facts).some((v) => v.code === "unbacked_service")).toBe(true);
  });

  it("rejects claims of an existing/endorsed relationship", () => {
    expect(
      auditDemoConfig(
        { ...base, greeting: "Ace Plumbing uses Rapid Connect and endorses us." },
        facts,
      ).length,
    ).toBeGreaterThan(0);
  });

  it("rejects a missing disclosure", () => {
    expect(
      auditDemoConfig({ ...base, disclosure: "" }, facts).some(
        (v) => v.code === "missing_disclosure",
      ),
    ).toBe(true);
  });
});
