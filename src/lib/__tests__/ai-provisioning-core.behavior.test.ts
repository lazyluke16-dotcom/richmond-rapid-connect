import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Behaviour tests for the shared provisioning CORE
 * (provisionAiAssistantForBusinessInternal) used by BOTH the authenticated
 * server function and the staging bootstrap. Proves: it creates the Vapi
 * assistant with a resolved server credential, persists the trusted provider
 * mapping, and — if the trusted mapping cannot be stored — rolls back the
 * remote assistant and records an error state rather than leaving an untrusted
 * usable resource.
 */

// --- Recorded side effects -------------------------------------------------
const state = vi.hoisted(() => ({
  createdAssistants: [] as unknown[],
  deletedAssistants: [] as string[],
  updates: [] as { table: string; row: Record<string, unknown> }[],
  upserts: [] as { table: string; row: Record<string, unknown> }[],
  mappingError: null as string | null,
}));

vi.mock("@/lib/vapi.server", () => ({
  vapiCredentialsAvailable: () => true,
  resolveVapiServerCredentialId: vi.fn().mockResolvedValue("cred-123"),
  createVapiAssistant: vi.fn(async (cfg: unknown) => {
    state.createdAssistants.push(cfg);
    return { id: "vapi-assistant-1" };
  }),
  deleteVapiAssistant: vi.fn(async (id: string) => {
    state.deletedAssistants.push(id);
  }),
}));

vi.mock("@/integrations/supabase/client.server", () => {
  const biz = {
    id: "cert-biz",
    name: "Smart Answer Certification",
    slug: "smart-answer-certification-staging",
    public_phone: null,
    selected_plan: "ai_receptionist",
    trial_ends_at: null,
    active: true,
  };
  const settings = {
    assistant_name: "Smart Answer Certification Receptionist",
    first_message: "Hi",
    tone: "friendly",
    language: "en-AU",
    callback_message: "cb",
    pricing_response: "pr",
    human_request_response: "hr",
    emergency_response: "er",
    recording_enabled: false,
    max_call_duration_seconds: 300,
  };
  const readTables = ["business_services", "business_service_areas", "business_hours"];
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
      upsert: async (row: Record<string, unknown>) => {
        state.upserts.push({ table, row });
        return { error: state.mappingError ? { message: state.mappingError } : null };
      },
      insert: async () => ({ error: null }),
      maybeSingle: async () => {
        if (table === "businesses") return { data: biz, error: null };
        if (table === "business_ai_receptionist_settings") return { data: settings, error: null };
        return { data: null, error: null };
      },
      single: async () => ({ data: biz, error: null }),
      then: (resolve: (v: unknown) => unknown) =>
        Promise.resolve(readTables.includes(table) ? { data: [] } : { error: null }).then(resolve),
    });
    return chain;
  }
  return {
    supabaseAdmin: { from, rpc: async () => ({ data: true, error: null }) },
  };
});

async function load() {
  return import("../ai-provisioning.core");
}

beforeEach(() => {
  state.createdAssistants.length = 0;
  state.deletedAssistants.length = 0;
  state.updates.length = 0;
  state.upserts.length = 0;
  state.mappingError = null;
  process.env.PUBLIC_JOB_REQUEST_URL = "https://staging.example";
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("provisionAiAssistantForBusinessInternal", () => {
  it("creates the assistant with a resolved server credential and persists the trusted mapping", async () => {
    const { provisionAiAssistantForBusinessInternal } = await load();
    const result = await provisionAiAssistantForBusinessInternal("cert-biz");

    expect(result).toEqual({ provisioned: true, providerAssistantId: "vapi-assistant-1" });
    // Created with the certification tenant name + resolved credential.
    expect(state.createdAssistants).toHaveLength(1);
    expect(state.createdAssistants[0]).toMatchObject({
      name: "Smart Answer Certification Receptionist",
      serverCredentialId: "cred-123",
      serverUrl: "https://staging.example/api/public/webhooks/vapi-inbound",
    });
    // Persisted the active assistant settings and the trusted provider mapping.
    const settingsUpdate = state.updates.find(
      (u) => u.table === "business_ai_receptionist_settings",
    );
    expect(settingsUpdate?.row).toMatchObject({
      provider_assistant_id: "vapi-assistant-1",
      status: "active",
      provider: "vapi",
    });
    const mapping = state.upserts.find((u) => u.table === "ai_provider_mappings");
    expect(mapping?.row).toMatchObject({
      provider: "vapi",
      provider_assistant_id: "vapi-assistant-1",
      active: true,
    });
    // No assistant was deleted on the happy path.
    expect(state.deletedAssistants).toHaveLength(0);
  });

  it("rolls back the remote assistant and records an error when the trusted mapping cannot be stored", async () => {
    state.mappingError = "mapping write failed";
    const { provisionAiAssistantForBusinessInternal } = await load();

    await expect(provisionAiAssistantForBusinessInternal("cert-biz")).rejects.toThrow(
      "Failed to persist assistant mapping",
    );
    // Remote assistant was deleted (no untrusted usable resource left behind).
    expect(state.deletedAssistants).toEqual(["vapi-assistant-1"]);
    // Local settings marked error, with provider_assistant_id cleared after
    // successful remote cleanup.
    const errorUpdate = state.updates.filter(
      (u) => u.table === "business_ai_receptionist_settings",
    );
    const last = errorUpdate[errorUpdate.length - 1];
    expect(last?.row).toMatchObject({ status: "error", provider_assistant_id: null });
  });
});
