import { createHash } from "node:crypto";
import { chmod, readFile, unlink, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const PRODUCTION_LIKE = /(^|[-_.])(prod|production|live)([-_.]|$)/i;
const STAGING_ID = /^staging[-_][a-z0-9][a-z0-9_-]{2,63}$/i;
const WORKER_NAME = /^[a-z0-9][a-z0-9-]{2,62}$/;
const SHA = /^[a-f0-9]{40}$/;
const DEPLOY_CONFIRMATION = "DEPLOY_STAGING_ONLY";
const EXECUTION_CONFIRMATION = "I_UNDERSTAND_STAGING_ONLY";

export const stagingDeploymentSteps = [
  "verify_exact_release_sha",
  "verify_frozen_migration_manifest",
  "run_local_release_gates",
  "supabase_migration_dry_run",
  "apply_frozen_migrations",
  "build_cloudflare_artifact",
  "deploy_staging_worker",
  "verify_staging_release_identity",
  "upload_non_secret_evidence",
];

export const requiredSecretNames = [
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_API_TOKEN",
  "SUPABASE_ACCESS_TOKEN",
  "STAGING_SUPABASE_DB_PASSWORD",
  "STAGING_SUPABASE_SERVICE_ROLE_KEY",
  "STAGING_SUPABASE_PUBLISHABLE_KEY",
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "TWILIO_FROM_NUMBER",
  "VAPI_API_KEY",
  "VAPI_SERVER_SECRET",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "STRIPE_SMS_GST_TAX_RATE_ID",
  "STRIPE_PRICE_MCR_BASE",
  "STRIPE_PRICE_AIR_BASE",
  "STRIPE_PRICE_AIR_USAGE",
  "SMS_INVOICE_PROCESSOR_KEY",
  "WEBHOOK_SECRET",
  "DASHBOARD_PIN",
];

export const cloudflareRuntimeSecretNames = [
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_PUBLISHABLE_KEY",
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "TWILIO_FROM_NUMBER",
  "VAPI_API_KEY",
  "VAPI_SERVER_SECRET",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "STRIPE_SMS_GST_TAX_RATE_ID",
  "STRIPE_PRICE_MCR_BASE",
  "STRIPE_PRICE_AIR_BASE",
  "STRIPE_PRICE_AIR_USAGE",
  "SMS_INVOICE_PROCESSOR_KEY",
  "WEBHOOK_SECRET",
  "DASHBOARD_PIN",
];

function required(env, name) {
  const value = env[name]?.trim();
  if (!value) throw new Error(`Missing required staging variable: ${name}`);
  return value;
}

function assertNoProductionLike(value, label) {
  if (PRODUCTION_LIKE.test(value)) {
    throw new Error(`${label} must not contain a production-like identifier`);
  }
}

function assertStagingUrl(value, expectedHostname) {
  const url = new URL(value);
  const hostname = url.hostname.toLowerCase();
  if (
    url.protocol !== "https:" ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    hostname !== expectedHostname.toLowerCase() ||
    !hostname.includes("staging")
  ) {
    throw new Error("The staging base URL must be an HTTPS origin on the exact staging hostname");
  }
  assertNoProductionLike(hostname, "Staging hostname");
  return url;
}

export function validateStagingDeploymentConfig(
  env = process.env,
  { suppliedEnvironmentId, requireSecrets = false } = {},
) {
  const target = required(env, "DEPLOYMENT_TARGET");
  const confirmation = required(env, "DEPLOYMENT_CONFIRMATION");
  const environmentId = required(env, "CERTIFICATION_ENVIRONMENT_ID");
  const hostname = required(env, "CERTIFICATION_STAGING_HOSTNAME");
  const workerName = required(env, "CLOUDFLARE_STAGING_WORKER_NAME");
  const projectRef = required(env, "STAGING_SUPABASE_PROJECT_REF");
  const releaseSha = required(env, "DEPLOYED_RELEASE_SHA").toLowerCase();

  if (target !== "staging" || confirmation !== DEPLOY_CONFIRMATION) {
    throw new Error("The exact staging deployment target and confirmation are required");
  }
  if (
    !STAGING_ID.test(environmentId) ||
    (suppliedEnvironmentId && suppliedEnvironmentId !== environmentId)
  ) {
    throw new Error("An exact non-production staging environment identifier is required");
  }
  assertNoProductionLike(environmentId, "Environment identifier");

  if (
    !WORKER_NAME.test(workerName) ||
    !workerName.includes("staging") ||
    PRODUCTION_LIKE.test(workerName)
  ) {
    throw new Error("Cloudflare worker name must be an explicit non-production staging name");
  }
  if (!SHA.test(releaseSha)) {
    throw new Error("DEPLOYED_RELEASE_SHA must be an exact 40-character Git commit SHA");
  }

  const baseUrl = assertStagingUrl(required(env, "CERTIFICATION_BASE_URL"), hostname);
  const publicUrl = new URL(required(env, "PUBLIC_JOB_REQUEST_URL"));
  if (publicUrl.origin !== baseUrl.origin || publicUrl.pathname !== "/") {
    throw new Error("PUBLIC_JOB_REQUEST_URL must equal the exact staging origin");
  }

  const supabaseUrl = new URL(required(env, "STAGING_SUPABASE_URL"));
  if (
    supabaseUrl.protocol !== "https:" ||
    supabaseUrl.hostname !== `${projectRef}.supabase.co` ||
    !/^[a-z0-9]{6,40}$/.test(projectRef)
  ) {
    throw new Error("Staging Supabase URL must match the exact staging project reference");
  }
  assertNoProductionLike(projectRef, "Supabase project reference");

  if (
    env.STAGING_CERTIFICATION_ENABLED !== "true" ||
    env.STAGING_CERTIFICATION_EXECUTE !== EXECUTION_CONFIRMATION ||
    env.SMS_MODE !== "twilio" ||
    env.STRIPE_MODE !== "test"
  ) {
    throw new Error("Staging-only runtime controls are incomplete or inconsistent");
  }

  if (requireSecrets) {
    for (const name of requiredSecretNames) required(env, name);
    if (!required(env, "STRIPE_SECRET_KEY").startsWith("sk_test_")) {
      throw new Error("The staging deployment requires a Stripe test-mode secret key");
    }
    if (required(env, "SMS_INVOICE_PROCESSOR_KEY").length < 32) {
      throw new Error("SMS_INVOICE_PROCESSOR_KEY must be at least 32 characters");
    }
  }

  return {
    environmentId,
    releaseSha,
    workerName,
    baseUrl: baseUrl.origin,
    projectRef,
    secretNamesPresent: requireSecrets ? requiredSecretNames.length : 0,
  };
}

function argumentValue(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

async function artifactDigest(path = ".output") {
  const metadata = JSON.parse(await readFile(resolve(path, "nitro.json"), "utf8"));
  const wrangler = JSON.parse(await readFile(resolve(path, "server", "wrangler.json"), "utf8"));
  return {
    preset: metadata.preset,
    compatibilityDate: wrangler.compatibility_date,
    workerMain: wrangler.main,
    digest: createHash("sha256").update(JSON.stringify({ metadata, wrangler })).digest("hex"),
  };
}

export async function verifyHostedRelease(env = process.env, fetchImpl = fetch) {
  const target = validateStagingDeploymentConfig(env, {
    suppliedEnvironmentId: env.CERTIFICATION_ENVIRONMENT_ID,
    requireSecrets: false,
  });
  const response = await fetchImpl(`${target.baseUrl}/api/public/staging-release`, {
    headers: { accept: "application/json" },
  });
  if (!response.ok) throw new Error(`Staging release endpoint returned HTTP ${response.status}`);
  const body = await response.json();
  if (
    body?.target !== "staging" ||
    body?.environmentId !== target.environmentId ||
    body?.releaseSha !== target.releaseSha
  ) {
    throw new Error("Hosted staging release identity does not match the requested release");
  }
  return {
    target: body.target,
    environmentId: body.environmentId,
    releaseSha: body.releaseSha,
    verified: true,
  };
}

export async function writeCloudflareRuntimeSecrets(path, env = process.env) {
  const secrets = Object.fromEntries(
    cloudflareRuntimeSecretNames.map((name) => [name, required(env, name)]),
  );
  await writeFile(resolve(path), `${JSON.stringify(secrets)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await chmod(resolve(path), 0o600);
  return { secretCount: cloudflareRuntimeSecretNames.length, valuesPrinted: false };
}

async function main(args = process.argv.slice(2), env = process.env) {
  if (args.includes("--plan")) {
    console.log(
      JSON.stringify(
        {
          target: "staging-only",
          steps: stagingDeploymentSteps,
          requiredSecretNames,
          networkAccess: false,
        },
        null,
        2,
      ),
    );
    return;
  }

  const environmentId = argumentValue(args, "--environment-id");
  if (args.includes("--preflight")) {
    const result = validateStagingDeploymentConfig(env, {
      suppliedEnvironmentId: environmentId,
      requireSecrets: true,
    });
    console.log(
      JSON.stringify({
        ...result,
        secretNamesPresent: result.secretNamesPresent,
        secretsPrinted: false,
      }),
    );
    return;
  }

  if (args.includes("--preflight-public")) {
    const result = validateStagingDeploymentConfig(env, {
      suppliedEnvironmentId: environmentId,
      requireSecrets: false,
    });
    console.log(JSON.stringify({ ...result, secretsRequired: false }));
    return;
  }

  if (args.includes("--verify-hosted")) {
    if (env.STAGING_DEPLOYMENT_EXECUTE !== EXECUTION_CONFIRMATION) {
      throw new Error("Hosted verification requires the exact staging-only execution confirmation");
    }
    const result = await verifyHostedRelease(env);
    const output = argumentValue(args, "--evidence-out");
    const evidence = {
      ...result,
      checkedAt: new Date().toISOString(),
      artifact: await artifactDigest(),
    };
    if (output) await writeFile(resolve(output), `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    console.log(JSON.stringify(result));
    return;
  }

  const secretsFile = argumentValue(args, "--out");
  if (args.includes("--write-cloudflare-secrets")) {
    if (!secretsFile) throw new Error("--out is required for the ephemeral secrets file");
    console.log(JSON.stringify(await writeCloudflareRuntimeSecrets(secretsFile, env)));
    return;
  }

  if (args.includes("--remove-cloudflare-secrets")) {
    if (!secretsFile) throw new Error("--out is required for the ephemeral secrets file");
    try {
      await unlink(resolve(secretsFile));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    console.log(JSON.stringify({ removed: true }));
    return;
  }

  throw new Error(
    "Use --plan, --preflight, --preflight-public, --verify-hosted, --write-cloudflare-secrets, or --remove-cloudflare-secrets",
  );
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "Staging deployment command failed");
    process.exitCode = 1;
  });
}
