import type {
  SmsInvoiceProcessResult,
  SmsInvoiceProvider,
  SmsInvoiceRepository,
} from "./sms-invoicing.server";
import { processSmsInvoicePeriod } from "./sms-invoicing.server";

const STAGING_ID_PATTERN = /^staging[-_][a-z0-9][a-z0-9_-]{2,63}$/i;
const PRODUCTION_LIKE = /(^|[-_.])(prod|production|live)([-_.]|$)/i;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EXECUTION_CONFIRMATION = "I_UNDERSTAND_STAGING_ONLY";
const MAX_REQUEST_BYTES = 4096;
const MAX_PERIOD_MS = 32 * 24 * 60 * 60 * 1000;

export interface SmsInvoiceCertificationDependencies {
  createRepository: () => SmsInvoiceRepository;
  createProvider: () => SmsInvoiceProvider;
  processPeriod?: typeof processSmsInvoicePeriod;
}

interface InvoiceRequestBody {
  businessId: string;
  periodStart: string;
  periodEnd: string;
}

function jsonResponse(body: Record<string, unknown>, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });
}

function requiredEnvironment(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`Missing required staging variable: ${name}`);
  return value;
}

function assertExecutionEnvironment(env: NodeJS.ProcessEnv): {
  environmentId: string;
  processorKey: string;
} {
  const environmentId = requiredEnvironment(env, "CERTIFICATION_ENVIRONMENT_ID");
  if (
    env.STAGING_CERTIFICATION_ENABLED !== "true" ||
    env.STAGING_CERTIFICATION_EXECUTE !== EXECUTION_CONFIRMATION ||
    env.CERTIFICATION_TARGET !== "staging" ||
    !STAGING_ID_PATTERN.test(environmentId) ||
    PRODUCTION_LIKE.test(environmentId)
  ) {
    throw new Error("SMS invoice certification requires an explicit non-production staging target");
  }

  const processorKey = requiredEnvironment(env, "SMS_INVOICE_PROCESSOR_KEY");
  if (processorKey.length < 32) {
    throw new Error("SMS invoice processor key must contain at least 32 characters");
  }
  return { environmentId, processorKey };
}

async function hashSecret(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

async function secretsMatch(actual: string | null, expected: string): Promise<boolean> {
  if (!actual) return false;
  const [actualHash, expectedHash] = await Promise.all([hashSecret(actual), hashSecret(expected)]);
  let difference = actualHash.length ^ expectedHash.length;
  const length = Math.max(actualHash.length, expectedHash.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (actualHash[index] ?? 0) ^ (expectedHash[index] ?? 0);
  }
  return difference === 0;
}

function canonicalUtc(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) return null;
  return value;
}

function parseBody(raw: string): InvoiceRequestBody | null {
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;

  const record = body as Record<string, unknown>;
  const businessId = typeof record.businessId === "string" ? record.businessId : "";
  const periodStart = canonicalUtc(record.periodStart);
  const periodEnd = canonicalUtc(record.periodEnd);
  if (!UUID_PATTERN.test(businessId) || !periodStart || !periodEnd) return null;

  const duration = new Date(periodEnd).getTime() - new Date(periodStart).getTime();
  if (duration <= 0 || duration > MAX_PERIOD_MS) return null;
  return { businessId, periodStart, periodEnd };
}

function responseForResult(result: SmsInvoiceProcessResult): Response {
  const safeBody: Record<string, unknown> = { status: result.status };
  if ("batchId" in result) safeBody.batchId = result.batchId;
  if ("providerInvoiceId" in result && result.providerInvoiceId) {
    safeBody.providerInvoiceId = result.providerInvoiceId;
  }

  if (result.status === "busy" || result.status === "void") {
    return jsonResponse(safeBody, 409);
  }
  if (result.status === "reconciliation_required") {
    return jsonResponse(safeBody, 202);
  }
  if (result.status === "failed") {
    return jsonResponse(safeBody, 502);
  }
  return jsonResponse(safeBody, 200);
}

export async function handleSmsInvoiceCertificationRequest(
  request: Request,
  dependencies: SmsInvoiceCertificationDependencies,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Response> {
  if (request.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  let target: ReturnType<typeof assertExecutionEnvironment>;
  try {
    target = assertExecutionEnvironment(env);
  } catch {
    return jsonResponse({ error: "Staging certification is disabled" }, 503);
  }

  if (
    request.headers.get("x-certification-environment-id") !== target.environmentId ||
    !(await secretsMatch(request.headers.get("x-sms-invoice-processor-key"), target.processorKey))
  ) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return jsonResponse({ error: "JSON content type required" }, 415);
  }

  const rawBody = await request.text();
  if (new TextEncoder().encode(rawBody).byteLength > MAX_REQUEST_BYTES) {
    return jsonResponse({ error: "Request body too large" }, 413);
  }
  const body = parseBody(rawBody);
  if (!body) {
    return jsonResponse({ error: "Invalid invoice certification request" }, 400);
  }

  try {
    const processPeriod = dependencies.processPeriod ?? processSmsInvoicePeriod;
    const result = await processPeriod({
      ...body,
      repository: dependencies.createRepository(),
      provider: dependencies.createProvider(),
    });
    return responseForResult(result);
  } catch {
    return jsonResponse({ error: "SMS invoice certification failed" }, 500);
  }
}
