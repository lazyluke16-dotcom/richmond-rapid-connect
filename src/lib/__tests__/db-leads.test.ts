import { describe, expect, it } from "vitest";
import { mapLeadRow } from "../db-leads";

describe("mapLeadRow", () => {
  it("maps the production snake_case row into the dashboard Lead contract", () => {
    const lead = mapLeadRow({
      id: "lead-1",
      created_at: 123,
      job_type: "blocked-drain",
      suburb: "Richmond",
      urgency: "today",
      property_type: "commercial",
      photos: ["https://example.test/photo.jpg"],
      name: "Sam",
      phone: "0400000000",
      best_time: "After 3pm",
      chat: [{ role: "customer", text: "Help", ts: 122 }],
      ai_summary: "Blocked drain",
      lead_score: 70,
      recommended_action: "Call today",
      status: "new",
      source: "ai_phone_agent",
      external_call_id: "call-1",
      call_recording_url: "https://example.test/call.mp3",
    });

    expect(lead).toMatchObject({
      id: "lead-1",
      createdAt: 123,
      jobType: "blocked-drain",
      propertyType: "commercial",
      bestTime: "After 3pm",
      aiSummary: "Blocked drain",
      leadScore: 70,
      recommendedAction: "Call today",
      external_call_id: "call-1",
    });
  });

  it("normalises nullable JSON and optional provider fields safely", () => {
    const lead = mapLeadRow({
      id: "lead-2",
      created_at: 456,
      job_type: "other",
      suburb: "Hawthorn",
      urgency: "flexible",
      property_type: "house",
      photos: null,
      name: "Alex",
      phone: "0411111111",
      best_time: null,
      chat: null,
      ai_summary: null,
      lead_score: null,
      recommended_action: null,
      status: "closed",
      source: "form",
      external_call_id: null,
      call_recording_url: null,
    });

    expect(lead.photos).toEqual([]);
    expect(lead.chat).toEqual([]);
    expect(lead.bestTime).toBe("");
    expect(lead.external_call_id).toBeUndefined();
  });
});
