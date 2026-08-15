import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Fake service-role client: only auth.getUser is needed for the auth-boundary tests.
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

describe("operator API auth boundary", () => {
  it("build: 401 without a token, 403 for a non-operator", async () => {
    const { handleProspectBuild } = await import("../../../routes/api/public/prospect/build");
    const noAuth = await handleProspectBuild(
      req("https://app/api/public/prospect/build", { method: "POST" }),
    );
    expect(noAuth.status).toBe(401);
    const forbidden = await handleProspectBuild(
      req("https://app/api/public/prospect/build", { method: "POST", ...withAuth("user-token") }),
    );
    expect(forbidden.status).toBe(403);
    expect(fromCalls).toHaveLength(0);
  });

  it("build: operator with invalid JSON body → 400 (never provisions)", async () => {
    const { handleProspectBuild } = await import("../../../routes/api/public/prospect/build");
    const res = await handleProspectBuild(
      req("https://app/api/public/prospect/build", {
        method: "POST",
        headers: { Authorization: "Bearer operator-token", "Content-Type": "application/json" },
        body: "not json",
      }),
    );
    expect(res.status).toBe(400);
  });

  it("build: operator with missing website → 400", async () => {
    const { handleProspectBuild } = await import("../../../routes/api/public/prospect/build");
    const res = await handleProspectBuild(
      req("https://app/api/public/prospect/build", {
        method: "POST",
        headers: { Authorization: "Bearer operator-token", "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(400);
  });

  it("list: 401 without token, 403 for non-operator", async () => {
    const { handleProspectList } = await import("../../../routes/api/public/prospect/list");
    expect((await handleProspectList(req("https://app/api/public/prospect/list"))).status).toBe(
      401,
    );
    expect(
      (
        await handleProspectList(
          req("https://app/api/public/prospect/list", withAuth("user-token")),
        )
      ).status,
    ).toBe(403);
  });

  it("detail: 401/403 enforced before any lookup", async () => {
    const { handleProspectDetail } = await import("../../../routes/api/public/prospect/detail");
    expect(
      (await handleProspectDetail(req("https://app/api/public/prospect/detail?id=x"))).status,
    ).toBe(401);
    expect(
      (
        await handleProspectDetail(
          req("https://app/api/public/prospect/detail?id=x", withAuth("user-token")),
        )
      ).status,
    ).toBe(403);
  });

  it("revoke: 401/403 enforced before any mutation", async () => {
    const { handleProspectRevoke } = await import("../../../routes/api/public/prospect/revoke");
    expect(
      (
        await handleProspectRevoke(
          req("https://app/api/public/prospect/revoke", { method: "POST" }),
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await handleProspectRevoke(
          req("https://app/api/public/prospect/revoke", {
            method: "POST",
            ...withAuth("user-token"),
          }),
        )
      ).status,
    ).toBe(403);
  });
});

describe("public demo-reply fails closed without valid slug+token", () => {
  it("returns 404 for a missing slug/token before any DB access", async () => {
    const { handleDemoReply } = await import("../../../routes/api/public/prospect/demo-reply");
    const res = await handleDemoReply(
      req("https://app/api/public/prospect/demo-reply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "hi" }),
      }),
    );
    expect(res.status).toBe(404);
    expect(fromCalls).toHaveLength(0);
  });
});
