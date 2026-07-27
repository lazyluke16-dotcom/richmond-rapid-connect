import { mkdtemp, readFile, rmdir, stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  cloudflareRuntimeSecretNames,
  requiredSecretNames,
  validateStagingDeploymentConfig,
  verifyHostedRelease,
  writeCloudflareRuntimeSecrets,
} from "../../../scripts/staging-deployment.mjs";
import { stagingReleaseIdentity } from "../staging-release.server";

const releaseSha = "a".repeat(40);

function stagingEnv(): NodeJS.ProcessEnv {
  const secrets = Object.fromEntries(requiredSecretNames.map((name) => [name, "configured"]));
  return {
    ...secrets,
    CLOUDFLARE_STAGING_WORKER_NAME: "rapid-connect-staging",
    CERTIFICATION_BASE_URL: "https://commercial.staging.example.com",
    CERTIFICATION_STAGING_HOSTNAME: "commercial.staging.example.com",
    CERTIFICATION_ENVIRONMENT_ID: "staging-commercial-rc",
    DEPLOYED_RELEASE_SHA: releaseSha,
    DEPLOYMENT_CONFIRMATION: "DEPLOY_STAGING_ONLY",
    DEPLOYMENT_TARGET: "staging",
    PUBLIC_JOB_REQUEST_URL: "https://commercial.staging.example.com/",
    SMS_INVOICE_PROCESSOR_KEY: "x".repeat(32),
    SMS_MODE: "twilio",
    STAGING_CERTIFICATION_ENABLED: "true",
    STAGING_CERTIFICATION_EXECUTE: "I_UNDERSTAND_STAGING_ONLY",
    STAGING_SUPABASE_PROJECT_REF: "abc123",
    STAGING_SUPABASE_URL: "https://abc123.supabase.co",
    STRIPE_MODE: "test",
    STRIPE_SECRET_KEY: "sk_test_configured",
  };
}

describe("staging deployment boundary", () => {
  it("accepts a complete staging-only configuration without printing secret values", () => {
    const result = validateStagingDeploymentConfig(stagingEnv(), {
      suppliedEnvironmentId: "staging-commercial-rc",
      requireSecrets: true,
    });
    expect(result).toEqual({
      environmentId: "staging-commercial-rc",
      releaseSha,
      workerName: "rapid-connect-staging",
      baseUrl: "https://commercial.staging.example.com",
      projectRef: "abc123",
      secretNamesPresent: requiredSecretNames.length,
    });
    expect(JSON.stringify(result)).not.toContain("sk_test_configured");
  });

  it.each([
    ["production environment", { CERTIFICATION_ENVIRONMENT_ID: "staging-production" }],
    ["live worker", { CLOUDFLARE_STAGING_WORKER_NAME: "rapid-connect-live-staging" }],
    ["production host", { CERTIFICATION_STAGING_HOSTNAME: "production.staging.example.com" }],
    ["wrong public URL", { PUBLIC_JOB_REQUEST_URL: "https://other.staging.example.com/" }],
    ["live Stripe mode", { STRIPE_MODE: "live" }],
    ["short processor key", { SMS_INVOICE_PROCESSOR_KEY: "short" }],
  ])("rejects %s", (_label, override) => {
    expect(() =>
      validateStagingDeploymentConfig({ ...stagingEnv(), ...override }, { requireSecrets: true }),
    ).toThrow();
  });

  it("verifies the hosted endpoint against both exact environment and exact SHA", async () => {
    const env = stagingEnv();
    const result = await verifyHostedRelease(env, async () =>
      Response.json(stagingReleaseIdentity(env)),
    );
    expect(result).toEqual({
      target: "staging",
      environmentId: "staging-commercial-rc",
      releaseSha,
      verified: true,
    });
  });

  it("rejects a hosted endpoint reporting a different SHA", async () => {
    await expect(
      verifyHostedRelease(stagingEnv(), async () =>
        Response.json({
          target: "staging",
          environmentId: "staging-commercial-rc",
          releaseSha: "b".repeat(40),
        }),
      ),
    ).rejects.toThrow("does not match");
  });

  it("writes only the allowlisted runtime secrets with owner-only permissions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rapid-connect-staging-"));
    const path = join(directory, "secrets.json");
    const env = Object.fromEntries(
      cloudflareRuntimeSecretNames.map((name) => [name, `value-for-${name}`]),
    );
    try {
      const result = await writeCloudflareRuntimeSecrets(path, env);
      const contents = JSON.parse(await readFile(path, "utf8"));
      expect(Object.keys(contents).sort()).toEqual([...cloudflareRuntimeSecretNames].sort());
      expect(result).toEqual({
        secretCount: cloudflareRuntimeSecretNames.length,
        valuesPrinted: false,
      });
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    } finally {
      await unlink(path);
      await rmdir(directory);
    }
  });
});

describe("staging release identity route", () => {
  it("returns only non-secret staging identity", () => {
    expect(stagingReleaseIdentity(stagingEnv())).toEqual({
      target: "staging",
      environmentId: "staging-commercial-rc",
      releaseSha,
    });
  });

  it("is disabled outside an explicit staging deployment", () => {
    expect(stagingReleaseIdentity({ ...stagingEnv(), DEPLOYMENT_TARGET: "production" })).toBeNull();
    expect(
      stagingReleaseIdentity({
        ...stagingEnv(),
        CERTIFICATION_ENVIRONMENT_ID: "staging-production",
      }),
    ).toBeNull();
  });
});
