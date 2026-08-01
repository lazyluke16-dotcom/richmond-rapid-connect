import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_TEXT_LINK_SMS_TEMPLATE,
  TEXT_LINK_SMS_CURRENCY,
  TEXT_LINK_SMS_UNIT_PRICE_MINOR,
  analyzeSmsEncoding,
  assertModeEntitled,
  assertTenantMatch,
  canCreateAiEndOfCallRecords,
  entitlementsForPlan,
  isLegacyModeConsistent,
  legacyFlagsForMode,
  normalizeAustralianPhone,
  selectInboundWorkflow,
} from "@/lib/call-handling";

const migration = readFileSync(
  resolve(process.cwd(), "supabase/migrations/20260725160000_customer_call_handling.sql"),
  "utf8",
);
const recoveredVapiMappingMigration = readFileSync(
  resolve(
    process.cwd(),
    "supabase/migrations/20260715222235_4714b86c-97e8-44aa-85fb-943ae7e2e722.sql",
  ),
  "utf8",
);
const seamlessMigration = readFileSync(
  resolve(process.cwd(), "supabase/migrations/20260801130000_seamless_acquisition_activation.sql"),
  "utf8",
);

describe("fresh migration replay safety", () => {
  it("guards the recovered Vapi mapping when its historical business is absent", () => {
    expect(recoveredVapiMappingMigration).toContain("AND EXISTS (");
    expect(recoveredVapiMappingMigration).toContain("FROM public.businesses");
    expect(recoveredVapiMappingMigration).toContain(
      `SELECT id, 'vapi', '28a85bd5-5ccb-4605-a330-b62560e90aff', true`,
    );
    expect(recoveredVapiMappingMigration).not.toContain(
      `VALUES ('45bf00ff-b5f2-43c8-aaaa-18298b85a2a9'`,
    );
  });
});

const twilioIdempotencyMigration = readFileSync(
  resolve(process.cwd(), "supabase/migrations/20260723120000_twilio_missed_call_idempotency.sql"),
  "utf8",
);

describe("Australian customer phone normalisation", () => {
  it.each([
    ["0412 345 678", "+61412345678"],
    ["(03) 9123 4567", "+61391234567"],
    ["+61 2 9123 4567", "+61291234567"],
    ["61 412 345 678", "+61412345678"],
    ["1300 123 456", "+611300123456"],
    ["13 12 34", "+61131234"],
    ["1800 123 456", "+611800123456"],
  ])("normalises %s", (input, expected) => {
    expect(normalizeAustralianPhone(input)).toBe(expected);
  });

  it.each(["", "+1 415 555 0100", "000", "phone me", "0412 34"])("rejects %s", (input) =>
    expect(() => normalizeAustralianPhone(input)).toThrow(),
  );
});

describe("entitlements and one authoritative mode", () => {
  it("keeps the two subscriptions distinct and supports choosing both", () => {
    expect(
      entitlementsForPlan("ai_receptionist", {
        missedCall: true,
        aiReceptionist: true,
      }),
    ).toEqual({ textLink: false, aiReceptionist: true });
    expect(
      entitlementsForPlan("both", {
        missedCall: true,
        aiReceptionist: true,
      }),
    ).toEqual({ textLink: true, aiReceptionist: true });
  });

  it.each(["off", "text_link", "ai_receptionist"] as const)(
    "activates exactly the legacy flags for %s",
    (mode) => {
      const flags = legacyFlagsForMode(mode);
      expect(Number(flags.textLinkEnabled) + Number(flags.aiEnabled)).toBe(mode === "off" ? 0 : 1);
    },
  );

  it("rejects an invalid both-active legacy state", () => {
    expect(
      isLegacyModeConsistent("text_link", {
        textLinkEnabled: true,
        textLinkMode: "live",
        recoverySmsEnabled: true,
        aiEnabled: true,
        aiMode: "live",
      }),
    ).toBe(false);
    expect(migration).toContain("CREATE CONSTRAINT TRIGGER trg_call_mode_consistency");
  });

  it("does not allow an unentitled service to be selected", () => {
    expect(() =>
      assertModeEntitled("ai_receptionist", {
        textLink: true,
        aiReceptionist: false,
      }),
    ).toThrow(/does not include AI Receptionist/);
  });
});

describe("inbound workflow gating", () => {
  it("Off invokes neither customer workflow", () => {
    expect(
      selectInboundWorkflow({
        mode: "off",
        textLinkEntitled: true,
        aiReceptionistEntitled: true,
        assistantId: "assistant-1",
      }),
    ).toEqual({ kind: "off" });
  });

  it("Text Link selects only the SMS recovery workflow", () => {
    expect(
      selectInboundWorkflow({
        mode: "text_link",
        textLinkEntitled: true,
        aiReceptionistEntitled: true,
        assistantId: "assistant-1",
      }),
    ).toEqual({ kind: "text_link" });
  });

  it("AI mode preserves routing to the existing receptionist assistant", () => {
    expect(
      selectInboundWorkflow({
        mode: "ai_receptionist",
        textLinkEntitled: true,
        aiReceptionistEntitled: true,
        assistantId: "assistant-proven",
      }),
    ).toEqual({ kind: "ai_receptionist", assistantId: "assistant-proven" });
  });

  it("Text Link calls cannot create AI leads or voice usage", () => {
    expect(
      canCreateAiEndOfCallRecords({
        mode: "text_link",
        aiReceptionistEntitled: true,
      }),
    ).toBe(false);
  });

  it("entitled AI calls can create the existing lead and usage records", () => {
    expect(
      canCreateAiEndOfCallRecords({
        mode: "ai_receptionist",
        aiReceptionistEntitled: true,
      }),
    ).toBe(true);
  });
});

describe("Text Link idempotency, tenant isolation and usage", () => {
  it("uses the settled integer minor-unit SMS price", () => {
    expect(TEXT_LINK_SMS_UNIT_PRICE_MINOR).toBe(25);
    expect(TEXT_LINK_SMS_CURRENCY).toBe("AUD");
  });

  it("keeps the fixed recovery template within one GSM-7 segment", () => {
    const body = DEFAULT_TEXT_LINK_SMS_TEMPLATE.replace("{{business_name}}", "Richmond Plumbing")
      .replace(
        "{{recovery_link}}",
        "https://app.example/b/richmond-plumbing/request?source=missed_call&mcid=12345678",
      )
      .replace("{{public_phone}}", "+61390000000");
    expect(analyzeSmsEncoding(body)).toMatchObject({
      encoding: "gsm-7",
      segments: 1,
    });
  });

  it("detects payloads that exceed a single encoded segment", () => {
    expect(analyzeSmsEncoding("x".repeat(161)).segments).toBe(2);
    expect(analyzeSmsEncoding("😀".repeat(36)).segments).toBe(2);
  });

  it("rejects cross-tenant questionnaire or number ownership", () => {
    expect(() => assertTenantMatch("business-1", "business-2")).toThrow(/does not belong/);
    expect(() => assertTenantMatch("business-1", "business-1")).not.toThrow();
  });

  it("deduplicates provider events and missed calls at the database boundary", () => {
    expect(migration).toMatch(/UNIQUE\s*\(provider,\s*event_type,\s*provider_event_id\)/);
    expect(twilioIdempotencyMigration).toContain("missed_calls_twilio_source_uk");
    expect(migration).toContain("telephony_provider_events_replay_uk");
  });

  it("reserves the lowest-cost suitable number under a row lock", () => {
    expect(migration).toContain("voice_capable AND i.sms_capable");
    expect(migration).toContain("ORDER BY i.monthly_cost_aud ASC NULLS LAST");
    expect(migration).toContain("FOR UPDATE SKIP LOCKED");
    expect(migration).toContain("platform_phone_inventory_reserved_business_uk");
  });

  it("requires a customer-initiated verification window before activation", () => {
    expect(migration).toContain("start_my_forwarding_verification");
    expect(migration).toContain("interval '15 minutes'");
    expect(migration).toContain("forwarding_verification_expires_at > now()");
    expect(migration).toContain("Verify no-answer forwarding before enabling call handling");
  });

  it("limits routing writes to owner/admin RPCs", () => {
    expect(migration).toContain("bu.role IN ('owner','admin')");
    expect(migration).toContain("trg_business_phone_authority");
    expect(migration).toContain("auth.uid() IS NOT NULL");
    expect(migration).toContain(
      "REVOKE INSERT, UPDATE, DELETE ON public.business_telephony_settings FROM authenticated",
    );
    expect(migration).toContain("GRANT EXECUTE ON FUNCTION public.set_my_call_handling_mode");
  });

  it("adds independent operational switches without cancelling subscriptions", () => {
    expect(seamlessMigration).toContain("missed_call_recovery_enabled boolean");
    expect(seamlessMigration).toContain("ai_receptionist_enabled boolean");
    expect(seamlessMigration).toContain("set_my_service_enabled");
    expect(seamlessMigration).toContain("Verify call forwarding before switching this service on");
    expect(seamlessMigration).not.toMatch(
      /set_my_service_enabled[\s\S]*stripe\.subscriptions\.del/,
    );
  });

  it("creates tenant-scoped, notification-safe, repeat-safe test jobs", () => {
    expect(seamlessMigration).toContain("create_my_test_job");
    expect(seamlessMigration).toContain("leads_business_test_run_unique");
    expect(seamlessMigration).toContain("'test:no-send'");
    expect(seamlessMigration).toContain("is_test");
    expect(seamlessMigration).toContain("IF NEW.is_test THEN RETURN NEW");
  });

  it("keeps the guarded backfill idempotent and free of production ids", () => {
    expect(migration).toContain("ADD COLUMN IF NOT EXISTS answering_mode");
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS public.platform_phone_inventory");
    expect(migration).toContain("pm.active = true");
    expect(migration).not.toContain("019f978e-32bb-7881-a314-988c82081f4d");
    expect(migration).not.toContain("+61 485 020 780");
  });
});
