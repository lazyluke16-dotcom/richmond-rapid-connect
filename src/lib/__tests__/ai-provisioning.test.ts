import { describe, expect, it, vi } from "vitest";
import { assertCallerCanProvision, resolveVapiWebhookUrl } from "../ai-provisioning.functions";

function contextFor(
  membership: { business_id: string; role: string } | null,
  error: { message: string } | null = null,
) {
  const maybeSingle = vi.fn().mockResolvedValue({ data: membership, error });
  const secondEq = vi.fn().mockReturnValue({ maybeSingle });
  const firstEq = vi.fn().mockReturnValue({ eq: secondEq });
  const select = vi.fn().mockReturnValue({ eq: firstEq });
  const from = vi.fn().mockReturnValue({ select });
  return {
    context: { userId: "user-1", supabase: { from } },
    spies: { from, select, firstEq, secondEq },
  };
}

describe("AI provisioning authority", () => {
  it.each(["owner", "admin"])("allows a current %s", async (role) => {
    const { context } = contextFor({ business_id: "biz-1", role });
    await expect(assertCallerCanProvision(context, "biz-1")).resolves.toBeUndefined();
  });

  it.each(["staff", "viewer"])("rejects a %s member", async (role) => {
    const { context } = contextFor({ business_id: "biz-1", role });
    await expect(assertCallerCanProvision(context, "biz-1")).rejects.toThrow(
      "owner or admin access is required",
    );
  });

  it("rejects a user with no membership", async () => {
    const { context } = contextFor(null);
    await expect(assertCallerCanProvision(context, "biz-1")).rejects.toThrow(
      "owner or admin access is required",
    );
  });

  it("binds the lookup to both the requested tenant and authenticated user", async () => {
    const { context, spies } = contextFor({ business_id: "biz-1", role: "owner" });
    await assertCallerCanProvision(context, "biz-1");
    expect(spies.firstEq).toHaveBeenCalledWith("business_id", "biz-1");
    expect(spies.secondEq).toHaveBeenCalledWith("user_id", "user-1");
  });

  it("fails closed when the authority lookup fails", async () => {
    const { context } = contextFor(null, { message: "database unavailable" });
    await expect(assertCallerCanProvision(context, "biz-1")).rejects.toThrow(
      "Unable to verify provisioning authority",
    );
  });
});

describe("Vapi webhook URL", () => {
  it("uses the real public webhook route when deriving from the app URL", () => {
    expect(
      resolveVapiWebhookUrl({
        PUBLIC_JOB_REQUEST_URL: "https://rapid-connect.example/",
      } as NodeJS.ProcessEnv),
    ).toBe("https://rapid-connect.example/api/public/webhooks/vapi-inbound");
  });

  it("honours an explicit webhook URL", () => {
    expect(
      resolveVapiWebhookUrl({
        VAPI_WEBHOOK_URL: "https://hooks.example/vapi",
        PUBLIC_JOB_REQUEST_URL: "https://ignored.example",
      } as NodeJS.ProcessEnv),
    ).toBe("https://hooks.example/vapi");
  });
});
