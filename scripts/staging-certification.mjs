import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const PRODUCTION_LIKE = /(^|[-_.])(prod|production|live)([-_.]|$)/i;
const STAGING_ID = /^staging[-_][a-z0-9][a-z0-9_-]{2,63}$/i;
const EXECUTION_CONFIRMATION = "I_UNDERSTAND_STAGING_ONLY";

export const certificationCases = [
  { id: "off", group: "call_handling", execution: "webhook" },
  { id: "text_link_accepted", group: "call_handling", execution: "webhook" },
  { id: "ai_receptionist", group: "call_handling", execution: "webhook" },
  { id: "duplicate_webhook", group: "provider_state", execution: "webhook_twice" },
  { id: "provider_rejected", group: "provider_state", execution: "guarded_fixture" },
  { id: "provider_uncertain", group: "provider_state", execution: "guarded_fixture" },
  { id: "reconciliation_accepted", group: "provider_state", execution: "guarded_fixture" },
  { id: "later_undelivered", group: "provider_state", execution: "guarded_fixture" },
  { id: "missing_caller_id", group: "tenant_boundary", execution: "webhook" },
  { id: "cross_tenant_replay", group: "tenant_boundary", execution: "webhook_twice" },
  { id: "questionnaire_link", group: "tenant_boundary", execution: "operator_assertion" },
  { id: "invoice_exactly_once", group: "billing", execution: "operator_assertion" },
  { id: "gst_once", group: "billing", execution: "operator_assertion" },
  { id: "sms_excluded_from_ai_meter", group: "billing", execution: "operator_assertion" },
  { id: "signup_same_tab", group: "onboarding", execution: "browser" },
  { id: "signup_new_tab", group: "onboarding", execution: "browser" },
  { id: "job_enrichment_recovery", group: "job_card", execution: "operator_assertion" },
  { id: "audit_linkage", group: "audit", execution: "operator_assertion" },
];

function required(env, name) {
  const value = env[name]?.trim();
  if (!value) throw new Error(`Missing required staging variable: ${name}`);
  return value;
}

function stagingUrl(env) {
  const baseUrl = new URL(required(env, "CERTIFICATION_BASE_URL"));
  const expectedHostname = required(env, "CERTIFICATION_STAGING_HOSTNAME").toLowerCase();
  if (
    baseUrl.protocol !== "https:" ||
    baseUrl.hostname.toLowerCase() !== expectedHostname ||
    !baseUrl.hostname.toLowerCase().includes("staging") ||
    PRODUCTION_LIKE.test(baseUrl.hostname)
  ) {
    throw new Error("Certification base URL is not an explicit non-production staging host");
  }
  return baseUrl;
}

export function assertStagingTarget(env = process.env, suppliedEnvironmentId) {
  const environmentId = required(env, "CERTIFICATION_ENVIRONMENT_ID");
  if (
    env.CERTIFICATION_TARGET !== "staging" ||
    !STAGING_ID.test(environmentId) ||
    PRODUCTION_LIKE.test(environmentId) ||
    (suppliedEnvironmentId && suppliedEnvironmentId !== environmentId)
  ) {
    throw new Error("An exact, non-production staging environment identifier is required");
  }
  const baseUrl = stagingUrl(env);
  const supabaseUrl = new URL(required(env, "STAGING_SUPABASE_URL"));
  const projectRef = required(env, "STAGING_SUPABASE_PROJECT_REF");
  if (
    supabaseUrl.protocol !== "https:" ||
    supabaseUrl.hostname !== `${projectRef}.supabase.co` ||
    PRODUCTION_LIKE.test(projectRef)
  ) {
    throw new Error("Staging Supabase URL does not match the explicit staging project reference");
  }
  required(env, "STAGING_SUPABASE_SERVICE_ROLE_KEY");
  required(env, "VAPI_SERVER_SECRET");
  return { environmentId, baseUrl, projectRef };
}

function argumentValue(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function phoneIdForCase(env, caseId) {
  if (caseId === "off") return required(env, "CERTIFICATION_OFF_PHONE_ID");
  if (caseId === "ai_receptionist") return required(env, "CERTIFICATION_AI_PHONE_ID");
  return required(env, "CERTIFICATION_TEXT_LINK_PHONE_ID");
}

function webhookPayload(callId, phoneNumberId, callerNumber) {
  return {
    message: {
      type: "assistant-request",
      call: {
        id: callId,
        phoneNumberId,
        ...(callerNumber ? { customer: { number: callerNumber } } : {}),
      },
    },
  };
}

async function sendWebhook(baseUrl, secret, payload) {
  const response = await fetch(new URL("/api/public/webhooks/vapi-inbound", baseUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-vapi-secret": secret,
    },
    body: JSON.stringify(payload),
  });
  let body = {};
  try {
    body = await response.json();
  } catch {
    body = {};
  }
  return {
    status: response.status,
    bodyKeys: Object.keys(body).sort(),
    assistantReturned: typeof body.assistantId === "string",
    hasError: typeof body.error === "string",
  };
}

async function executeWebhookCase(caseId, env, target) {
  const supported = new Set([
    "off",
    "text_link_accepted",
    "ai_receptionist",
    "duplicate_webhook",
    "provider_rejected",
    "provider_uncertain",
    "reconciliation_accepted",
    "later_undelivered",
    "missing_caller_id",
    "cross_tenant_replay",
  ]);
  if (!supported.has(caseId)) {
    throw new Error(`${caseId} is an operator/browser evidence case, not a webhook command`);
  }
  if (
    [
      "provider_rejected",
      "provider_uncertain",
      "reconciliation_accepted",
      "later_undelivered",
    ].includes(caseId) &&
    env.CERTIFICATION_PROVIDER_SCENARIO !== caseId
  ) {
    throw new Error(
      `Set CERTIFICATION_PROVIDER_SCENARIO=${caseId} only after the matching staging provider fixture is active`,
    );
  }

  const secret = required(env, "VAPI_SERVER_SECRET");
  const caller =
    caseId === "missing_caller_id" ? undefined : required(env, "CERTIFICATION_CALLER_E164");
  const callId = `cert-${target.environmentId}-${caseId}-${Date.now()}`;
  const primaryPhoneId = phoneIdForCase(env, caseId);
  const first = await sendWebhook(
    target.baseUrl,
    secret,
    webhookPayload(callId, primaryPhoneId, caller),
  );
  const evidence = [{ delivery: 1, ...first }];

  if (caseId === "duplicate_webhook") {
    evidence.push({
      delivery: 2,
      ...(await sendWebhook(
        target.baseUrl,
        secret,
        webhookPayload(callId, primaryPhoneId, caller),
      )),
    });
  }
  if (caseId === "cross_tenant_replay") {
    const otherTenantPhoneId = required(env, "CERTIFICATION_OTHER_TENANT_PHONE_ID");
    evidence.push({
      delivery: 2,
      ...(await sendWebhook(
        target.baseUrl,
        secret,
        webhookPayload(callId, otherTenantPhoneId, caller),
      )),
    });
  }
  return { caseId, callId, evidence };
}

export async function main(args = process.argv.slice(2), env = process.env) {
  if (args.length === 0 || args.includes("--plan")) {
    process.stdout.write(
      `${JSON.stringify({
        networkAccess: false,
        certificationCases,
        note: "Local certification is separate; hosted execution remains disabled by default.",
      })}\n`,
    );
    return;
  }

  const suppliedEnvironmentId = argumentValue(args, "--environment-id");
  const target = assertStagingTarget(env, suppliedEnvironmentId);
  if (args.includes("--preflight")) {
    process.stdout.write(
      `${JSON.stringify({
        status: "staging_preflight_passed",
        environmentId: target.environmentId,
        projectRef: target.projectRef,
        credentialsLogged: false,
        networkAccess: false,
      })}\n`,
    );
    return;
  }

  const caseId = argumentValue(args, "--execute-webhook");
  if (!caseId) throw new Error("Use --plan, --preflight, or --execute-webhook <case>");
  if (
    env.STAGING_CERTIFICATION_EXECUTE !== EXECUTION_CONFIRMATION ||
    suppliedEnvironmentId !== target.environmentId
  ) {
    throw new Error(
      "Hosted execution is disabled until the exact environment ID and staging-only confirmation are supplied",
    );
  }
  const result = await executeWebhookCase(caseId, env, target);
  process.stdout.write(
    `${JSON.stringify({
      ...result,
      environmentId: target.environmentId,
      credentialsLogged: false,
    })}\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
