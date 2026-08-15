import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const users: Record<string, { id: string } | null> = {
  "operator-token": { id: "op-1" },
  "user-token": { id: "rando" },
};
const fromCalls: string[] = [];
const fakeSupabaseAdmin = {
  auth: {
    getUser: async (token: string) =>
      token in users && users[token]
        ? { data: { user: users[token] }, error: null }
        : { data: { user: null }, error: new Error("invalid") },
  },
  from: (table: string) => {
    fromCalls.push(table);
    throw new Error("unauthorized requests must not query the database");
  },
};

vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: fakeSupabaseAdmin }));

function req(url: string, init?: RequestInit): Request {
  return new Request(url, init);
}
function withAuth(token: string): RequestInit {
  return { headers: { Authorization: `Bearer ${token}` } };
}

beforeEach(() => {
  fromCalls.length = 0;
  process.env.ACQUISITION_OPERATOR_USER_IDS = "op-1";
  delete process.env.OUTREACH_OPERATOR_USER_IDS;
});
afterEach(() => {
  delete process.env.ACQUISITION_OPERATOR_USER_IDS;
});

describe("discovery API auth boundary", () => {
  it("missions list: 401 without token, 403 for non-operator", async () => {
    const { handleMissionList } = await import("../../../routes/api/public/discovery/missions");
    expect((await handleMissionList(req("https://app/api/public/discovery/missions"))).status).toBe(
      401,
    );
    expect(
      (
        await handleMissionList(
          req("https://app/api/public/discovery/missions", withAuth("user-token")),
        )
      ).status,
    ).toBe(403);
    expect(fromCalls).toHaveLength(0);
  });

  it("missions create: 401/403 before any write", async () => {
    const { handleMissionCreate } = await import("../../../routes/api/public/discovery/missions");
    expect((await handleMissionCreate(req("https://app/x", { method: "POST" }))).status).toBe(401);
    expect(
      (
        await handleMissionCreate(
          req("https://app/x", { method: "POST", ...withAuth("user-token") }),
        )
      ).status,
    ).toBe(403);
  });

  it("control: 401/403 before any state change", async () => {
    const { handleMissionControl } = await import("../../../routes/api/public/discovery/control");
    expect((await handleMissionControl(req("https://app/x", { method: "POST" }))).status).toBe(401);
    expect(
      (
        await handleMissionControl(
          req("https://app/x", { method: "POST", ...withAuth("user-token") }),
        )
      ).status,
    ).toBe(403);
  });

  it("advance: 401/403 before any work", async () => {
    const { handleMissionAdvance } = await import("../../../routes/api/public/discovery/advance");
    expect((await handleMissionAdvance(req("https://app/x", { method: "POST" }))).status).toBe(401);
    expect(
      (
        await handleMissionAdvance(
          req("https://app/x", { method: "POST", ...withAuth("user-token") }),
        )
      ).status,
    ).toBe(403);
  });

  it("detail: 401/403 before any lookup", async () => {
    const { handleMissionDetail } = await import("../../../routes/api/public/discovery/detail");
    expect(
      (await handleMissionDetail(req("https://app/api/public/discovery/detail?id=x"))).status,
    ).toBe(401);
    expect(
      (
        await handleMissionDetail(
          req("https://app/api/public/discovery/detail?id=x", withAuth("user-token")),
        )
      ).status,
    ).toBe(403);
  });

  it("operator with a bad JSON body gets 400, not a crash", async () => {
    const { handleMissionCreate } = await import("../../../routes/api/public/discovery/missions");
    const res = await handleMissionCreate(
      req("https://app/x", {
        method: "POST",
        headers: { Authorization: "Bearer operator-token", "Content-Type": "application/json" },
        body: "not json",
      }),
    );
    expect(res.status).toBe(400);
  });
});
