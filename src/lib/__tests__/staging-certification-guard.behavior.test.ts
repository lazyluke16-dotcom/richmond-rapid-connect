import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const script = resolve("scripts/staging-certification.mjs");

describe("staging certification fail-closed guard", () => {
  it("prints a no-network plan without credentials", () => {
    const result = spawnSync(process.execPath, [script, "--plan"], {
      encoding: "utf8",
      env: {},
    });
    const plan = JSON.parse(result.stdout) as {
      networkAccess: boolean;
      certificationCases: { id: string }[];
    };

    expect(result.status).toBe(0);
    expect(plan.networkAccess).toBe(false);
    expect(plan.certificationCases.map((item) => item.id)).toEqual(
      expect.arrayContaining([
        "off",
        "text_link_accepted",
        "ai_receptionist",
        "duplicate_webhook",
        "provider_rejected",
        "provider_uncertain",
        "reconciliation_accepted",
        "later_undelivered",
        "invoice_exactly_once",
        "gst_once",
        "invoice_draft",
        "signup_same_tab",
        "signup_new_tab",
        "job_enrichment_recovery",
        "audit_linkage",
      ]),
    );
  });

  it("rejects a production-like target before network access", () => {
    const result = spawnSync(
      process.execPath,
      [script, "--preflight", "--environment-id", "staging-production"],
      {
        encoding: "utf8",
        env: {
          CERTIFICATION_TARGET: "staging",
          CERTIFICATION_ENVIRONMENT_ID: "staging-production",
          CERTIFICATION_BASE_URL: "https://staging-production.example.com",
          CERTIFICATION_STAGING_HOSTNAME: "staging-production.example.com",
          STAGING_SUPABASE_URL: "https://production.supabase.co",
          STAGING_SUPABASE_PROJECT_REF: "production",
          STAGING_SUPABASE_SERVICE_ROLE_KEY: "not-logged",
          VAPI_SERVER_SECRET: "not-logged",
        },
      },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("non-production staging environment");
    expect(result.stdout).toBe("");
  });

  it("preflight validates an explicit staging target without making a request", () => {
    const result = spawnSync(
      process.execPath,
      [script, "--preflight", "--environment-id", "staging-commercial-rc"],
      {
        encoding: "utf8",
        env: {
          CERTIFICATION_TARGET: "staging",
          CERTIFICATION_ENVIRONMENT_ID: "staging-commercial-rc",
          CERTIFICATION_BASE_URL: "https://commercial-rc.staging.example.com",
          CERTIFICATION_STAGING_HOSTNAME: "commercial-rc.staging.example.com",
          STAGING_SUPABASE_URL: "https://abc123.supabase.co",
          STAGING_SUPABASE_PROJECT_REF: "abc123",
          STAGING_SUPABASE_SERVICE_ROLE_KEY: "not-logged",
          VAPI_SERVER_SECRET: "not-logged",
        },
      },
    );
    const evidence = JSON.parse(result.stdout) as {
      status: string;
      credentialsLogged: boolean;
      networkAccess: boolean;
    };

    expect(result.status).toBe(0);
    expect(evidence.status).toBe("staging_preflight_passed");
    expect(evidence.credentialsLogged).toBe(false);
    expect(evidence.networkAccess).toBe(false);
    expect(result.stdout).not.toContain("not-logged");
  });

  it("invoice preflight validates test-only billing values without requiring Vapi", () => {
    const result = spawnSync(
      process.execPath,
      [script, "--preflight-invoice", "--environment-id", "staging-commercial-rc"],
      {
        encoding: "utf8",
        env: {
          CERTIFICATION_TARGET: "staging",
          CERTIFICATION_ENVIRONMENT_ID: "staging-commercial-rc",
          CERTIFICATION_BASE_URL: "https://commercial-rc.staging.example.com",
          CERTIFICATION_STAGING_HOSTNAME: "commercial-rc.staging.example.com",
          STAGING_SUPABASE_URL: "https://abc123.supabase.co",
          STAGING_SUPABASE_PROJECT_REF: "abc123",
          STAGING_SUPABASE_SERVICE_ROLE_KEY: "not-logged",
          SMS_INVOICE_PROCESSOR_KEY: "processor-key-with-at-least-32-characters",
          STRIPE_MODE: "test",
          STRIPE_SECRET_KEY: "sk_test_not-logged",
          STRIPE_SMS_GST_TAX_RATE_ID: "txr_staging123",
          CERTIFICATION_INVOICE_BUSINESS_ID: "11111111-1111-4111-8111-111111111111",
          CERTIFICATION_PERIOD_START: "2026-07-01T00:00:00.000Z",
          CERTIFICATION_PERIOD_END: "2026-08-01T00:00:00.000Z",
        },
      },
    );
    const evidence = JSON.parse(result.stdout) as {
      status: string;
      credentialsLogged: boolean;
      networkAccess: boolean;
    };

    expect(result.status).toBe(0);
    expect(evidence.status).toBe("staging_invoice_preflight_passed");
    expect(evidence.credentialsLogged).toBe(false);
    expect(evidence.networkAccess).toBe(false);
    expect(result.stdout).not.toContain("not-logged");
    expect(result.stdout).not.toContain("processor-key");
  });
});
