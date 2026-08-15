import { describe, expect, it } from "vitest";
import {
  isAcquisitionOperator,
  parseOperatorIds,
  toOperatorDetail,
  toOperatorSummary,
} from "../operator";
import type { DemoRecord, ProspectRecord } from "../store";
import type { ProspectFact } from "../types";

const prospect: ProspectRecord = {
  id: "prospect-1",
  status: "demo_ready",
  businessName: "Richmond Rapid Plumbing",
  website: "https://richmondrapid.com.au",
  canonicalDomain: "richmondrapid.com.au",
  industry: "plumbing",
  location: "Richmond, VIC",
  publicPhone: "03 9111 2222",
  logoUrl: null,
  faviconUrl: null,
  primaryColour: "#c0392b",
  secondaryColour: "#0f172a",
  accentColour: "#2563eb",
  brandSource: "extracted",
  score: 82,
  scoreBand: "priority",
  outreachAuthority: "none",
  createdAt: "2026-08-15T00:00:00Z",
  updatedAt: "2026-08-15T00:00:00Z",
};

describe("operator authorisation", () => {
  it("parses and merges allow-lists", () => {
    expect(parseOperatorIds("a, b ,", "b,c")).toEqual(["a", "b", "c"]);
    expect(parseOperatorIds(undefined, "")).toEqual([]);
  });

  it("authorises only listed users, across both lists", () => {
    expect(isAcquisitionOperator("op-1", { acquisition: "op-1", outreach: undefined })).toBe(true);
    expect(isAcquisitionOperator("op-2", { acquisition: undefined, outreach: "op-2" })).toBe(true);
    expect(isAcquisitionOperator("intruder", { acquisition: "op-1", outreach: "op-2" })).toBe(
      false,
    );
    expect(isAcquisitionOperator("", { acquisition: "op-1" })).toBe(false);
  });
});

describe("privacy-minimal projection", () => {
  it("summary omits all contact values", () => {
    const summary = toOperatorSummary(prospect, true);
    expect(summary).not.toHaveProperty("publicPhone");
    expect(summary).not.toHaveProperty("location");
    expect(summary.hasDemo).toBe(true);
    expect(summary.score).toBe(82);
  });

  it("detail never exposes the demo token or hash", () => {
    const facts: ProspectFact[] = [];
    const demo: DemoRecord = {
      id: "demo-1",
      prospectId: "prospect-1",
      version: 1,
      slug: "richmond-rapid-abcd",
      tokenHash: "a".repeat(64),
      config: {} as never,
      expiresAt: null,
      revokedAt: null,
      createdAt: "2026-08-15T00:00:00Z",
    };
    const detail = toOperatorDetail(prospect, facts, null, demo);
    const serialised = JSON.stringify(detail);
    expect(serialised).not.toContain("a".repeat(64));
    expect(detail.demo?.slug).toBe("richmond-rapid-abcd");
    expect(detail.demo).not.toHaveProperty("tokenHash");
    expect(detail.demo).not.toHaveProperty("config");
    // Detail may show the public business phone (public info).
    expect(detail.publicPhone).toBe("03 9111 2222");
  });
});
