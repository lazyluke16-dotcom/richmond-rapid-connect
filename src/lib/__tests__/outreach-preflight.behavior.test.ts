import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function preflight(input: unknown) {
  const result = spawnSync(process.execPath, ["scripts/outreach-preflight.mjs"], {
    cwd: resolve("."),
    input: JSON.stringify(input),
    encoding: "utf8",
  });
  return {
    status: result.status,
    report: JSON.parse(result.stdout) as {
      ok: boolean;
      eligibleRecipients: number;
      errors: string[];
      containsContactValues: boolean;
      sendsPerformed: number;
    },
    output: result.stdout,
  };
}

function validManifest() {
  return {
    campaign: {
      code: "founding-plumbers-pilot",
      senderLegalName: "Rapid Connect Pty Ltd",
      senderContact: "support@example.test",
      baseUrl: "https://staging.example.test",
      templates: {
        sms: {
          body: "Rapid Connect Pty Ltd: Watch here {{campaign_link}}. Reply STOP",
          unsubscribeInstruction: "Reply STOP",
        },
      },
    },
    recipients: [
      {
        channel: "sms",
        businessName: "Example Plumbing",
        contactValue: "0412 345 678",
        permissionBasis: "express",
        permissionSource: "Phone consent recorded in CRM",
        permissionRecordedAt: "2026-07-01T00:00:00Z",
        permissionReviewedAt: "2026-07-02T00:00:00Z",
        permissionReviewedBy: "campaign-reviewer",
      },
    ],
  };
}

describe("outreach campaign preflight", () => {
  it("returns only aggregate evidence and performs no send", () => {
    const input = validManifest();
    const result = preflight(input);
    expect(result.status).toBe(0);
    expect(result.report).toMatchObject({
      ok: true,
      eligibleRecipients: 1,
      containsContactValues: false,
      sendsPerformed: 0,
    });
    expect(result.output).not.toContain("0412 345 678");
    expect(result.output).not.toContain("Example Plumbing");
  });

  it("rejects public-list-only inferred consent and harvested sources", () => {
    const publicOnly = validManifest();
    publicOnly.recipients[0].permissionBasis = "inferred";
    publicOnly.recipients[0].permissionSource = "Public online directory listing";
    const first = preflight(publicOnly);
    expect(first.status).toBe(1);
    expect(first.report.errors.join(" ")).toContain(
      "public listing alone is not an inferred-consent basis",
    );

    const harvested = validManifest();
    harvested.recipients[0].permissionSource = "Scraped website data";
    const second = preflight(harvested);
    expect(second.status).toBe(1);
    expect(second.report.errors.join(" ")).toContain("sources are prohibited");
  });

  it("rejects missing sender identity, unsubscribe text and duplicate destinations", () => {
    const input = validManifest();
    input.campaign.templates.sms.body = "Watch here {{campaign_link}}";
    input.recipients.push({ ...input.recipients[0] });
    const result = preflight(input);
    expect(result.status).toBe(1);
    expect(result.report.errors.join(" ")).toContain("identify campaign.senderLegalName");
    expect(result.report.errors.join(" ")).toContain("exact unsubscribeInstruction");
    expect(result.report.errors.join(" ")).toContain("duplicate destination");
  });
});

describe("preflight template", () => {
  it("contains obviously fictional placeholders rather than a sendable real campaign", () => {
    const template = readFileSync(resolve("docs/outreach-campaign.template.json"), "utf8");
    expect(template).toContain("REPLACE WITH LEGAL SENDER NAME");
    expect(template).toContain("NOT A REAL RECIPIENT");
    expect(template).toContain("example.invalid");
  });
});
