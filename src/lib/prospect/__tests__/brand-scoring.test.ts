import { describe, expect, it } from "vitest";
import {
  buildBranding,
  chooseDisplayName,
  DEFAULT_BRANDING_PALETTE,
  resolvedColours,
  validateImageBytes,
} from "../brand";
import { scoreProspect } from "../scoring";
import type { ProspectFact } from "../types";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

describe("brand image validation", () => {
  it("accepts a real PNG signature", () => {
    expect(validateImageBytes(PNG, "image/png")).toMatchObject({ ok: true, type: "image/png" });
  });
  it("rejects empty and oversized images", () => {
    expect(validateImageBytes(new Uint8Array(0)).code).toBe("image_empty");
    expect(validateImageBytes(new Uint8Array(3 * 1024 * 1024), "image/png").code).toBe(
      "image_too_large",
    );
  });
  it("rejects content that lies about its type", () => {
    expect(validateImageBytes(new Uint8Array([0, 1, 2, 3, 4]), "image/png").ok).toBe(false);
  });
  it("accepts a clean SVG but rejects a scripted one", () => {
    const clean = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>');
    const scripted = new TextEncoder().encode("<svg><script>alert(1)</script></svg>");
    expect(validateImageBytes(clean, "image/svg+xml").ok).toBe(true);
    expect(validateImageBytes(scripted, "image/svg+xml").ok).toBe(false);
  });
});

describe("branding fallback", () => {
  it("uses an extracted logo + colours when available", () => {
    const branding = buildBranding({
      domain: "richmondrapid.com.au",
      nameCandidates: [
        {
          value: "Richmond Rapid Plumbing",
          context: "",
          strength: 0.9,
          extractor: "structured-data",
        },
      ],
      themeColours: ["#c0392b", "#2c3e50"],
      verifiedLogoUrl: "https://richmondrapid.com.au/logo.png",
      faviconUrl: "https://richmondrapid.com.au/favicon.ico",
    });
    expect(branding.source).toBe("extracted");
    expect(branding.logoUrl).toContain("logo.png");
    expect(branding.colours.primary).toBe("#c0392b");
  });

  it("falls back to favicon then default palette without blocking", () => {
    const branding = buildBranding({
      domain: "exampleplumbing.com.au",
      nameCandidates: [],
      themeColours: [],
      verifiedLogoUrl: null,
      faviconUrl: "https://exampleplumbing.com.au/favicon.ico",
    });
    expect(branding.logoUrl).toBeNull();
    expect(branding.source).toBe("favicon_fallback");
    expect(branding.displayName).toBe("Exampleplumbing");
    const colours = resolvedColours(branding);
    expect(colours.primary).toBe(DEFAULT_BRANDING_PALETTE.primary);
  });

  it("chooseDisplayName prefers strongest candidate then domain", () => {
    expect(
      chooseDisplayName(
        [{ value: "Ace Plumbers", context: "", strength: 0.8, extractor: "deterministic-html" }],
        "ace.com.au",
      ),
    ).toBe("Ace Plumbers");
    expect(chooseDisplayName([], "ace-plumbing.com.au")).toBe("Ace Plumbing");
  });
});

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

describe("deterministic scoring", () => {
  it("is deterministic and fully explained", () => {
    const facts = [
      verified("service", "Blocked drains"),
      verified("service", "Hot water systems"),
      verified("service", "Burst pipes"),
      verified("service", "Gas fitting"),
      verified("public_phone", "0391112222", "0391112222"),
      verified("emergency_service", "yes"),
      verified("service_area", "Richmond"),
    ];
    const a = scoreProspect(facts, {
      websiteReachable: true,
      existingAiReceptionist: false,
      inTargetGeography: true,
    });
    const b = scoreProspect(facts, {
      websiteReachable: true,
      existingAiReceptionist: false,
      inTargetGeography: true,
    });
    expect(a.score).toBe(b.score);
    expect(a.factors.length).toBeGreaterThan(5);
    expect(a.factors.every((f) => typeof f.detail === "string" && f.detail.length > 0)).toBe(true);
    expect(a.score).toBeGreaterThanOrEqual(75);
    expect(a.band).toBe("priority");
  });

  it("penalises an existing AI receptionist without going negative", () => {
    const facts = [verified("service", "Blocked drains")];
    const withAi = scoreProspect(facts, {
      websiteReachable: false,
      existingAiReceptionist: true,
      inTargetGeography: false,
    });
    expect(withAi.factors.find((f) => f.key === "existing_ai_receptionist")?.points).toBe(-20);
    expect(withAi.score).toBeGreaterThanOrEqual(0);
  });

  it("rewards an after-hours coverage gap (emergency without hours)", () => {
    const facts = [verified("emergency_service", "yes")];
    const result = scoreProspect(facts, {
      websiteReachable: true,
      existingAiReceptionist: false,
      inTargetGeography: true,
    });
    expect(result.factors.find((f) => f.key === "after_hours_opportunity")?.awarded).toBe(true);
  });
});
