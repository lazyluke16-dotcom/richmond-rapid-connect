import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  requiredSecretNames,
  validateStagingDeploymentConfig,
  verifyHostedRelease,
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
  it("automatically deploys only a verified push that remains the open PR 7 head", () => {
    const releaseWorkflow = readFileSync(
      ".github/workflows/commercial-release-candidate.yml",
      "utf8",
    );
    const authorization = releaseWorkflow.slice(
      releaseWorkflow.indexOf("authorize-pr-7-staging:"),
      releaseWorkflow.indexOf("deploy-pr-7-to-isolated-staging:"),
    );
    const automaticDeployment = releaseWorkflow.slice(
      releaseWorkflow.indexOf("deploy-pr-7-to-isolated-staging:"),
    );

    expect(releaseWorkflow).toContain("- feat/acquisition-funnel");
    expect(authorization).toContain("needs: verify-and-package");
    expect(authorization).toContain("github.event_name == 'push'");
    expect(authorization).toContain("github.ref == 'refs/heads/feat/acquisition-funnel'");
    expect(authorization).toContain('gh api "repos/$GITHUB_REPOSITORY/pulls/7"');
    expect(authorization).toContain('.state == "open"');
    expect(authorization).toContain(".head.ref == env.EXPECTED_HEAD_REF");
    expect(authorization).toContain(".head.repo.full_name == env.GITHUB_REPOSITORY");
    expect(authorization).toContain(".head.sha == env.EXPECTED_HEAD_SHA");
    expect(automaticDeployment).toContain("- verify-and-package");
    expect(automaticDeployment).toContain("- authorize-pr-7-staging");
    expect(automaticDeployment).toContain("release_sha: ${{ github.sha }}");
    expect(automaticDeployment).toContain("environment_id: staging-commercial-rc");
    expect(automaticDeployment).toContain("apply_migrations: true");
    expect(automaticDeployment).toContain("confirmation: DEPLOY_STAGING_ONLY");
    expect(automaticDeployment).toContain("secrets: inherit");
  });

  it("keeps manual staging dispatch and the shared staging/rollback exclusion lock", () => {
    const workflow = readFileSync(".github/workflows/staging-deployment.yml", "utf8");

    expect(workflow).toContain("workflow_call:");
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("group: isolated-staging-deployment");
    expect(workflow).toContain("cancel-in-progress: false");
  });

  it("targets the configured staging Worker during bulk secret upload", () => {
    const workflow = readFileSync(".github/workflows/staging-deployment.yml", "utf8");

    expect(workflow).toContain("npx wrangler secret bulk");
    expect(workflow).toContain("--config .output/server/wrangler.json");
    expect(workflow).toContain('--name "$CLOUDFLARE_STAGING_WORKER_NAME"');
    expect(workflow).not.toMatch(/wranglerVersion: "4\.114\.0"\n\s+secrets:/);
  });

  it("keeps public Supabase bindings out of encrypted secret upload", () => {
    const workflow = readFileSync(".github/workflows/staging-deployment.yml", "utf8");
    const uploadStep = workflow.slice(
      workflow.indexOf("- name: Upload secrets only"),
      workflow.indexOf("- name: Deploy only"),
    );
    const deployStep = workflow.slice(
      workflow.indexOf("- name: Deploy only"),
      workflow.indexOf("- name: Verify exact hosted"),
    );

    expect(uploadStep).not.toContain('"SUPABASE_URL"');
    expect(uploadStep).not.toContain('"SUPABASE_PUBLISHABLE_KEY"');
    expect(uploadStep).toContain('"SUPABASE_SERVICE_ROLE_KEY"');
    expect(deployStep).toContain("--var SUPABASE_URL:${{ vars.STAGING_SUPABASE_URL }}");
    expect(deployStep).toContain(
      "--var SUPABASE_PUBLISHABLE_KEY:${{ secrets.STAGING_SUPABASE_PUBLISHABLE_KEY }}",
    );
  });

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

  it("requires the complete encrypted GitHub staging secret contract", () => {
    expect(requiredSecretNames).toHaveLength(20);
    expect(new Set(requiredSecretNames).size).toBe(requiredSecretNames.length);
    expect(requiredSecretNames).toContain("STAGING_SUPABASE_DB_PASSWORD");
    expect(requiredSecretNames).toContain("SMS_INVOICE_PROCESSOR_KEY");
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
