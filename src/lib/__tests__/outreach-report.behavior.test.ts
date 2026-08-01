import { describe, expect, it } from "vitest";
import {
  buildOutreachOperationsReport,
  isOutreachOperator,
  parseOutreachReportDays,
} from "@/lib/outreach-report";

describe("outreach operations access", () => {
  it("fails closed unless the authenticated user is explicitly allowlisted", () => {
    expect(isOutreachOperator("user-a", undefined)).toBe(false);
    expect(isOutreachOperator("user-a", "")).toBe(false);
    expect(isOutreachOperator("user-a", "user-b,user-c")).toBe(false);
    expect(isOutreachOperator("user-a", " user-b, user-a ")).toBe(true);
  });

  it("bounds report windows to a small operational range", () => {
    expect(parseOutreachReportDays(null)).toBe(30);
    expect(parseOutreachReportDays("7")).toBe(7);
    expect(() => parseOutreachReportDays("0")).toThrow();
    expect(() => parseOutreachReportDays("91")).toThrow();
    expect(() => parseOutreachReportDays("all")).toThrow();
  });
});

describe("privacy-safe outreach report", () => {
  it("deduplicates funnel sessions and reports campaign blockers without raw contacts", () => {
    const report = buildOutreachOperationsReport({
      generatedAt: "2026-07-28T00:00:00Z",
      windowDays: 30,
      events: [
        {
          event_name: "landing_viewed",
          session_id: "session-1",
          campaign: "pilot",
          source: "sms",
          created_at: "2026-07-28T00:00:00Z",
        },
        {
          event_name: "landing_viewed",
          session_id: "session-1",
          campaign: "pilot",
          source: "sms",
          created_at: "2026-07-28T00:00:01Z",
        },
        {
          event_name: "demo_completed",
          session_id: "session-1",
          campaign: "pilot",
          source: "sms",
          created_at: "2026-07-28T00:01:00Z",
        },
      ],
      campaigns: [
        {
          id: "campaign-1",
          name: "Melbourne pilot",
          code: "melbourne-pilot",
          status: "draft",
          created_at: "2026-07-28T00:00:00Z",
        },
      ],
      recipients: [
        {
          campaign_id: "campaign-1",
          channel: "sms",
          eligibility_status: "pending_review",
        },
      ],
      messages: [],
      suppressions: [],
      redemptions: [],
      activatedBusinesses: [],
    });

    expect(report.funnel.find((step) => step.key === "landing_viewed")?.value).toBe(1);
    expect(report.funnel.find((step) => step.key === "demo_completed")?.fromLandingPct).toBe(100);
    expect(report.outreach.campaigns[0]).toMatchObject({
      readyForControlledSend: false,
      recipients: 1,
    });
    expect(report.outreach.campaigns[0].blockers.join(" ")).toContain("pending review");
    expect(report.privacy).toEqual({
      aggregateOnly: true,
      rawContactsReturned: false,
      endpointHashesReturned: false,
      minimumNecessaryFields: true,
    });
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("contactValue");
    expect(serialized).not.toContain("endpoint_hash");
    expect(serialized).not.toMatch(/[a-f0-9]{64}/);
  });

  it("marks a fully reviewed prepared campaign ready without performing a send", () => {
    const report = buildOutreachOperationsReport({
      generatedAt: "2026-07-28T00:00:00Z",
      windowDays: 7,
      events: [],
      campaigns: [
        {
          id: "campaign-1",
          name: "Melbourne pilot",
          code: "melbourne-pilot",
          status: "ready",
          created_at: "2026-07-28T00:00:00Z",
        },
      ],
      recipients: [{ campaign_id: "campaign-1", channel: "sms", eligibility_status: "eligible" }],
      messages: [{ campaign_id: "campaign-1", channel: "sms", status: "draft" }],
      suppressions: [],
      redemptions: [],
      activatedBusinesses: [],
    });
    expect(report.outreach.campaigns[0]).toMatchObject({
      readyForControlledSend: true,
      blockers: [],
    });
  });
});
