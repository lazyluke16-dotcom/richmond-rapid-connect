import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { assertStagingBootstrapAllowed } from "../staging-tenant-bootstrap.core";

/**
 * Behaviour tests for the guarded staging tenant bootstrap. Proves the
 * fail-closed guards (production target / production-like id / wrong Supabase
 * project / non-certification slug are all refused) and that the bootstrap
 * never enables Smart Answer or provisions any SIP/phone resource — it only
 * establishes standard AI receptionist readiness via the shared core.
 */

const VALID = {
  DEPLOYMENT_TARGET: "staging",
  STAGING_CERTIFICATION_ENABLED: "true",
  CERTIFICATION_ENVIRONMENT_ID: "staging-commercial-rc",
  EXPECTED_STAGING_SUPABASE_PROJECT_REF: "csxfnqvnussdfobgpfdd",
  SUPABASE_URL: "https://csxfnqvnussdfobgpfdd.supabase.co",
} as const;

const CERT_SLUG = "smart-answer-certification-staging";

describe("staging bootstrap guards (fail closed)", () => {
  it("allows the certification slug when every staging guard passes", () => {
    expect(() => assertStagingBootstrapAllowed(CERT_SLUG, { ...VALID })).not.toThrow();
  });

  it("refuses a non-staging deployment target", () => {
    expect(() =>
      assertStagingBootstrapAllowed(CERT_SLUG, { ...VALID, DEPLOYMENT_TARGET: "production" }),
    ).toThrow(/DEPLOYMENT_TARGET/);
  });

  it("refuses when staging certification is not explicitly enabled", () => {
    expect(() =>
      assertStagingBootstrapAllowed(CERT_SLUG, {
        ...VALID,
        STAGING_CERTIFICATION_ENABLED: "false",
      }),
    ).toThrow(/STAGING_CERTIFICATION_ENABLED/);
  });

  it("refuses a production-like environment id", () => {
    expect(() =>
      assertStagingBootstrapAllowed(CERT_SLUG, {
        ...VALID,
        CERTIFICATION_ENVIRONMENT_ID: "production-rc",
      }),
    ).toThrow(/staging-only id/);
  });

  it("refuses a Supabase URL that is not the expected isolated staging project", () => {
    expect(() =>
      assertStagingBootstrapAllowed(CERT_SLUG, {
        ...VALID,
        SUPABASE_URL: "https://someprodref.supabase.co",
      }),
    ).toThrow(/does not match the expected isolated staging project/);
  });

  it("refuses a production-like or non-certification slug", () => {
    expect(() => assertStagingBootstrapAllowed("richmond-rapid-plumbing", { ...VALID })).toThrow(
      /certification\/test slug/,
    );
    // A production-like token anywhere in the slug is also refused.
    expect(() =>
      assertStagingBootstrapAllowed("smart-answer-certification-live", { ...VALID }),
    ).toThrow(/certification\/test slug/);
  });
});

// --- No-SIP / shared-core bootstrap behaviour ------------------------------
const state = vi.hoisted(() => ({
  provisionCalls: [] as string[],
  updates: [] as { table: string; row: Record<string, unknown> }[],
  assistantId: null as string | null,
}));

vi.mock("@/lib/ai-provisioning.core", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    assertAiAccess: vi.fn().mockResolvedValue(undefined),
    provisionAiAssistantForBusinessInternal: vi.fn(async (businessId: string) => {
      state.provisionCalls.push(businessId);
      state.assistantId = "vapi-assistant-1";
      return { provisioned: true, providerAssistantId: "vapi-assistant-1" };
    }),
  };
});

vi.mock("@/integrations/supabase/client.server", () => {
  function from(table: string) {
    const chain: Record<string, unknown> = {};
    Object.assign(chain, {
      select: () => chain,
      eq: () => chain,
      limit: () => chain,
      update: (row: Record<string, unknown>) => {
        state.updates.push({ table, row });
        return chain;
      },
      insert: async () => ({ error: null }),
      maybeSingle: async () => {
        if (table === "businesses") return { data: { id: "cert-biz" }, error: null };
        if (table === "business_ai_receptionist_settings")
          return {
            data: { provider_assistant_id: state.assistantId, status: "active", provider: "vapi" },
            error: null,
          };
        if (table === "business_telephony_settings")
          return {
            data: {
              answering_mode: "ai_receptionist",
              ai_receptionist_enabled: true,
              smart_answer_enabled: false,
              smart_answer_sip_phone_id: null,
              smart_answer_sip_uri: null,
              forwarding_setup_status: "unallocated",
            },
            error: null,
          };
        if (table === "ai_provider_mappings") return { data: { active: true }, error: null };
        return { data: null, error: null };
      },
      then: (resolve: (v: unknown) => unknown) => Promise.resolve({ error: null }).then(resolve),
    });
    return chain;
  }
  return { supabaseAdmin: { from, rpc: async () => ({ data: true, error: null }) } };
});

describe("bootstrap establishes standard readiness without Smart Answer", () => {
  beforeEach(() => {
    state.provisionCalls.length = 0;
    state.updates.length = 0;
    state.assistantId = null;
    Object.assign(process.env, VALID);
  });
  afterEach(() => vi.clearAllMocks());

  it("provisions via the shared core and sets only standard call-handling readiness", async () => {
    const { bootstrapSmartAnswerCertificationTenant } =
      await import("../staging-tenant-bootstrap.core");
    const result = await bootstrapSmartAnswerCertificationTenant();

    // Used the SHARED provisioning core.
    expect(state.provisionCalls).toEqual(["cert-biz"]);
    expect(result.provisioning).toBe("created");
    expect(result.providerAssistantId).toBe("vapi-assistant-1");

    // Standard readiness set; Smart Answer strictly untouched.
    const telephonyUpdate = state.updates.find((u) => u.table === "business_telephony_settings");
    expect(telephonyUpdate?.row).toEqual({
      answering_mode: "ai_receptionist",
      ai_receptionist_enabled: true,
    });
    // No update anywhere wrote a Smart Answer / SIP field.
    for (const u of state.updates) {
      expect(Object.keys(u.row)).not.toContain("smart_answer_enabled");
      expect(Object.keys(u.row)).not.toContain("smart_answer_assistant_id");
      expect(Object.keys(u.row)).not.toContain("smart_answer_sip_phone_id");
      expect(Object.keys(u.row)).not.toContain("smart_answer_sip_uri");
    }
    expect(result.smartAnswerEnabled).toBe(false);
    expect(result.smartAnswerSipPhoneId).toBeNull();
    expect(result.smartAnswerSipUri).toBeNull();
    expect(result.forwardingSetupStatus).toBe("unallocated");
  });

  it("reuses an already-provisioned standard receptionist instead of duplicating", async () => {
    state.assistantId = "vapi-existing";
    const { bootstrapSmartAnswerCertificationTenant } =
      await import("../staging-tenant-bootstrap.core");
    const result = await bootstrapSmartAnswerCertificationTenant();
    expect(state.provisionCalls).toHaveLength(0);
    expect(result.provisioning).toBe("reused");
  });
});
