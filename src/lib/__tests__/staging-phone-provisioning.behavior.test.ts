import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Behaviour tests for the staging phone provisioning core. Proves the safety guards (refuses
 * any Twilio account that is not the staging subaccount; no purchase attempted on refusal),
 * the regulatory-compliance association (only buys with an APPROVED AU/mobile/business bundle
 * + AU address, within the price cap, and passes BundleSid+AddressSid on the purchase), a
 * clean stop when Twilio still rejects, the happy purchase+allocate path (forwarding stays
 * 'reserved' — never 'verified'; answering_mode and Smart Answer are never written), and
 * idempotent reuse of an already-owned number.
 */

const CERT_ID = "7e08963d-2b6f-47c4-9e52-09fb4503c27d";
const EXPECTED_ACCOUNT = "Richmond Rapid Connect Hosted Staging";
const VOICE_WEBHOOK = "https://staging.example/api/public/webhooks/twilio-smart-answer";
const BUNDLE_SID = "BU1c43633a6ef6580e07204d4b73cf8cd7";

const state = vi.hoisted(() => ({
  accountName: "Richmond Rapid Connect Hosted Staging",
  owned: [] as Record<string, unknown>[],
  available: [{ phone_number: "+61485099999", capabilities: { voice: true, SMS: true } }] as Record<
    string,
    unknown
  >[],
  purchaseError: null as { status: number; code: number } | null,
  purchaseCalls: [] as string[],
  updates: [] as { table: string; row: Record<string, unknown> }[],
  inserts: [] as { table: string; row: Record<string, unknown> }[],
  telInitialInventoryPhoneId: null as string | null,
  telCallCount: 0,
  // Regulatory compliance state.
  bundleSidReturned: null as string | null, // null → echo the requested SID (matches)
  bundleStatus: "twilio-approved",
  regIso: "AU",
  regNumberType: "mobile",
  regEndUser: "business",
  addresses: [{ sid: "ADstaging", iso_country: "AU" }] as Record<string, unknown>[],
  priceUnit: "usd",
  mobilePrice: "8.25",
}));

vi.mock("@/lib/staging-tenant-bootstrap.core", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, assertStagingBootstrapAllowed: vi.fn() };
});

vi.mock("@/integrations/supabase/client.server", () => {
  function from(table: string) {
    const eqs: { c: string; v: string }[] = [];
    let op = "select";
    const chain: Record<string, unknown> = {};
    Object.assign(chain, {
      select: () => chain,
      eq: (c: string, v: string) => {
        eqs.push({ c, v });
        return chain;
      },
      update: (row: Record<string, unknown>) => {
        op = "update";
        state.updates.push({ table, row });
        return chain;
      },
      insert: (row: Record<string, unknown>) => {
        op = "insert";
        state.inserts.push({ table, row });
        return chain;
      },
      single: async () => resolve(table, eqs, op),
      maybeSingle: async () => resolve(table, eqs, op),
      then: (r: (v: unknown) => unknown) => Promise.resolve({ error: null }).then(r),
    });
    return chain;
  }
  function resolve(table: string, eqs: { c: string; v: string }[], op: string) {
    if (table === "platform_phone_inventory") {
      if (op === "insert") return { data: { id: "inv-1" }, error: null };
      if (eqs.some((e) => e.c === "provider_phone_id")) return { data: null, error: null };
      return {
        data: {
          id: "inv-1",
          status: "reserved",
          reserved_business_id: CERT_ID,
          assigned_business_id: null,
        },
        error: null,
      };
    }
    if (table === "business_telephony_settings") {
      state.telCallCount += 1;
      if (state.telCallCount === 1) {
        return { data: { inventory_phone_id: state.telInitialInventoryPhoneId }, error: null };
      }
      return {
        data: {
          inventory_phone_id: "inv-1",
          inbound_number: "+61485099999",
          forwarding_setup_status: "reserved",
          answering_mode: "off",
          smart_answer_enabled: false,
          smart_answer_sip_phone_id: null,
        },
        error: null,
      };
    }
    return { data: null, error: null };
  }
  return { supabaseAdmin: { from } };
});

function installFetch() {
  const ok = (j: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(j) });
  const err = (status: number, j: unknown) => ({
    ok: false,
    status,
    text: async () => JSON.stringify(j),
  });
  vi.stubGlobal("fetch", async (url: string, opts?: { method?: string; body?: string }) => {
    const u = String(url);
    const method = (opts?.method || "GET").toUpperCase();
    // Regulatory bundle + regulation (numbers.twilio.com/v2).
    if (u.includes("/v2/RegulatoryCompliance/Bundles/")) {
      const requested = decodeURIComponent(u.split("/Bundles/")[1] ?? "");
      return ok({
        sid: state.bundleSidReturned ?? requested,
        status: state.bundleStatus,
        regulation_sid: "RNstaging",
      });
    }
    if (u.includes("/v2/RegulatoryCompliance/Regulations/")) {
      return ok({
        iso_country: state.regIso,
        number_type: state.regNumberType,
        end_user_type: state.regEndUser,
      });
    }
    if (u.includes("pricing.twilio.com") && u.includes("/PhoneNumbers/Countries/AU")) {
      return ok({
        price_unit: state.priceUnit,
        phone_number_prices: [{ number_type: "mobile", current_price: state.mobilePrice }],
      });
    }
    if (u.includes("/Addresses.json")) return ok({ addresses: state.addresses });

    const isIncoming = u.includes("/IncomingPhoneNumbers");
    const isAvailable = u.includes("/AvailablePhoneNumbers");
    if (u.includes("/Accounts/") && u.endsWith(".json") && !isIncoming && !isAvailable) {
      return ok({ friendly_name: state.accountName, sid: "ACstaging" });
    }
    if (isAvailable) return ok({ available_phone_numbers: state.available });
    if (u.includes("/IncomingPhoneNumbers.json") && method === "GET") {
      return ok({ incoming_phone_numbers: state.owned });
    }
    if (u.includes("/IncomingPhoneNumbers.json") && method === "POST") {
      state.purchaseCalls.push(opts?.body || "");
      if (state.purchaseError)
        return err(state.purchaseError.status, { code: state.purchaseError.code, message: "boom" });
      return ok({
        sid: "PNnew",
        phone_number: "+61485099999",
        account_sid: "ACstaging",
        friendly_name: "Smart Answer Staging Certification",
        voice_url: VOICE_WEBHOOK,
        voice_method: "POST",
      });
    }
    if (isIncoming && method === "POST") {
      return ok({
        sid: "PNexisting",
        phone_number: "+61485011111",
        account_sid: "ACstaging",
        friendly_name: "Smart Answer Staging Certification",
        voice_url: VOICE_WEBHOOK,
        voice_method: "POST",
      });
    }
    return err(404, {});
  });
}

beforeEach(() => {
  state.accountName = EXPECTED_ACCOUNT;
  state.owned = [];
  state.available = [{ phone_number: "+61485099999", capabilities: { voice: true, SMS: true } }];
  state.purchaseError = null;
  state.purchaseCalls.length = 0;
  state.updates.length = 0;
  state.inserts.length = 0;
  state.telInitialInventoryPhoneId = null;
  state.telCallCount = 0;
  state.bundleSidReturned = null;
  state.bundleStatus = "twilio-approved";
  state.regIso = "AU";
  state.regNumberType = "mobile";
  state.regEndUser = "business";
  state.addresses = [{ sid: "ADstaging", iso_country: "AU" }];
  state.priceUnit = "usd";
  state.mobilePrice = "8.25";
  Object.assign(process.env, {
    DEPLOYMENT_TARGET: "staging",
    STAGING_CERTIFICATION_ENABLED: "true",
    CERTIFICATION_ENVIRONMENT_ID: "staging-commercial-rc",
    EXPECTED_STAGING_SUPABASE_PROJECT_REF: "csxfnqvnussdfobgpfdd",
    SUPABASE_URL: "https://csxfnqvnussdfobgpfdd.supabase.co",
    CERTIFICATION_BASE_URL: "https://staging.example",
    TWILIO_ACCOUNT_SID: "ACstaging",
    TWILIO_AUTH_TOKEN: "tok",
    TWILIO_STAGING_BUNDLE_SID: BUNDLE_SID,
  });
  installFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

async function load() {
  return import("../staging-phone-provisioning.core");
}

function purchaseForm(): URLSearchParams {
  return new URLSearchParams(state.purchaseCalls[0] ?? "");
}

describe("staging phone provisioning", () => {
  it("REFUSES any Twilio account that is not the staging subaccount and makes no purchase", async () => {
    state.accountName = "My first Twilio account";
    const { provisionStagingCertificationPhone } = await load();
    await expect(provisionStagingCertificationPhone()).rejects.toThrow(
      /not the staging subaccount/,
    );
    expect(state.purchaseCalls).toHaveLength(0);
    expect(state.inserts).toHaveLength(0);
  });

  it("associates the APPROVED bundle + AU address on the purchase and allocates it", async () => {
    const { provisionStagingCertificationPhone } = await load();
    const result = await provisionStagingCertificationPhone();

    expect(result.action).toBe("purchased");
    expect(state.purchaseCalls).toHaveLength(1);
    // The single purchase POST carries the approved compliance association.
    const form = purchaseForm();
    expect(form.get("BundleSid")).toBe(BUNDLE_SID);
    expect(form.get("AddressSid")).toBe("ADstaging");
    expect(form.get("VoiceUrl")).toBe(VOICE_WEBHOOK);
    expect(form.get("VoiceMethod")).toBe("POST");
    expect(result.regulatoryBundleSid).toBe(BUNDLE_SID);
    expect(result.addressSid).toBe("ADstaging");
    expect(result.monthlyPriceUsd).toBe(8.25);
    expect(result.phoneNumber).toBe("+61485099999");
    expect(result.tenantResolvesToCertBusiness).toBe(true);

    const invReserve = state.updates.find((u) => u.table === "platform_phone_inventory");
    expect(invReserve?.row).toMatchObject({ status: "reserved", reserved_business_id: CERT_ID });

    const tel = state.updates.find(
      (u) => u.table === "business_telephony_settings" && "inventory_phone_id" in u.row,
    );
    expect(tel?.row).toMatchObject({
      inventory_phone_id: "inv-1",
      inbound_number: "+61485099999",
      forwarding_setup_status: "reserved",
    });
    for (const u of state.updates) {
      expect(u.row.forwarding_setup_status).not.toBe("verified");
      expect(Object.keys(u.row)).not.toContain("answering_mode");
      expect(Object.keys(u.row)).not.toContain("smart_answer_enabled");
      expect(Object.keys(u.row)).not.toContain("smart_answer_sip_phone_id");
    }
    expect(result.forwardingSetupStatus).toBe("reserved");
    expect(result.smartAnswerEnabled).toBe(false);
    expect(result.smartAnswerSipPhoneId).toBeNull();
  });

  it("refuses to purchase when the bundle is not approved", async () => {
    state.bundleStatus = "pending-review";
    const { provisionStagingCertificationPhone } = await load();
    await expect(provisionStagingCertificationPhone()).rejects.toThrow(/not 'twilio-approved'/);
    expect(state.purchaseCalls).toHaveLength(0);
    expect(state.inserts).toHaveLength(0);
  });

  it("refuses a bundle whose SID does not match the expected one", async () => {
    state.bundleSidReturned = "BUsomethingelse";
    const { provisionStagingCertificationPhone } = await load();
    await expect(provisionStagingCertificationPhone()).rejects.toThrow(/SID mismatch/);
    expect(state.purchaseCalls).toHaveLength(0);
  });

  it("refuses a bundle for the wrong country / number type / end-user", async () => {
    state.regIso = "US";
    const { provisionStagingCertificationPhone } = await load();
    await expect(provisionStagingCertificationPhone()).rejects.toThrow(
      /expected AU\/mobile\/business/,
    );
    expect(state.purchaseCalls).toHaveLength(0);

    state.regIso = "AU";
    state.regNumberType = "local";
    const again = await load();
    await expect(again.provisionStagingCertificationPhone()).rejects.toThrow(
      /expected AU\/mobile\/business/,
    );

    state.regNumberType = "mobile";
    state.regEndUser = "individual";
    const third = await load();
    await expect(third.provisionStagingCertificationPhone()).rejects.toThrow(
      /expected AU\/mobile\/business/,
    );
    expect(state.purchaseCalls).toHaveLength(0);
  });

  it("stops rather than purchasing when no AU address resource exists", async () => {
    state.addresses = [];
    const { provisionStagingCertificationPhone } = await load();
    await expect(provisionStagingCertificationPhone()).rejects.toThrow(/no AU Address resource/);
    expect(state.purchaseCalls).toHaveLength(0);
    expect(state.inserts).toHaveLength(0);
  });

  it("refuses to purchase when the recurring price exceeds the US$10 cap", async () => {
    state.mobilePrice = "12.50";
    const { provisionStagingCertificationPhone } = await load();
    await expect(provisionStagingCertificationPhone()).rejects.toThrow(/exceeds the \$10/);
    expect(state.purchaseCalls).toHaveLength(0);
  });

  it("stops cleanly when Twilio still rejects with an address/regulatory code", async () => {
    state.purchaseError = { status: 400, code: 21631 };
    const { provisionStagingCertificationPhone } = await load();
    await expect(provisionStagingCertificationPhone()).rejects.toThrow(
      /ADDRESS_OR_REGULATORY_REQUIRED/,
    );
    // Purchase was attempted exactly once (no retry loop over alternatives).
    expect(state.purchaseCalls).toHaveLength(1);
    expect(state.inserts.filter((i) => i.table === "platform_phone_inventory")).toHaveLength(0);
  });

  it("reuses an already-owned staging number instead of buying again (idempotent)", async () => {
    state.owned = [
      {
        sid: "PNexisting",
        phone_number: "+61485011111",
        account_sid: "ACstaging",
        friendly_name: "Smart Answer Staging Certification",
        voice_url: VOICE_WEBHOOK,
        voice_method: "POST",
      },
    ];
    const { provisionStagingCertificationPhone } = await load();
    const result = await provisionStagingCertificationPhone();
    expect(result.action).toBe("reused-existing");
    expect(state.purchaseCalls).toHaveLength(0);
    expect(result.phoneNumber).toBe("+61485011111");
    // Reuse path does not re-verify the bundle (already-compliant number).
    expect(result.regulatoryBundleSid).toBeNull();
  });
});
