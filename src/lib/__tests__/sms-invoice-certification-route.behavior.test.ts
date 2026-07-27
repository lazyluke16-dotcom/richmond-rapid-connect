import { describe, expect, it, vi } from "vitest";

import { handleSmsInvoiceCertificationRequest } from "../sms-invoice-certification.server";
import type {
  SmsInvoiceProcessResult,
  SmsInvoiceProvider,
  SmsInvoiceRepository,
} from "../sms-invoicing.server";

const processorKey = "staging-certification-key-1234567890";
const environmentId = "staging-commercial-rc";
const businessId = "11111111-1111-4111-8111-111111111111";
const periodStart = "2026-07-01T00:00:00.000Z";
const periodEnd = "2026-08-01T00:00:00.000Z";

function stagingEnv(): NodeJS.ProcessEnv {
  return {
    STAGING_CERTIFICATION_ENABLED: "true",
    STAGING_CERTIFICATION_EXECUTE: "I_UNDERSTAND_STAGING_ONLY",
    CERTIFICATION_TARGET: "staging",
    CERTIFICATION_ENVIRONMENT_ID: environmentId,
    SMS_INVOICE_PROCESSOR_KEY: processorKey,
  };
}

function request(
  key = processorKey,
  target = environmentId,
  body: Record<string, unknown> = { businessId, periodStart, periodEnd },
): Request {
  return new Request("https://commercial-rc.staging.example.com/api/public/process-sms-invoice", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-certification-environment-id": target,
      "x-sms-invoice-processor-key": key,
    },
    body: JSON.stringify(body),
  });
}

function dependencies(result: SmsInvoiceProcessResult) {
  const processPeriod = vi.fn().mockResolvedValue(result);
  const repository = {} as SmsInvoiceRepository;
  const provider = {} as SmsInvoiceProvider;
  const createRepository = vi.fn(() => repository);
  const createProvider = vi.fn(() => provider);
  return { processPeriod, createRepository, createProvider, repository, provider };
}

describe("guarded SMS invoice certification route", () => {
  it("rejects disabled and production-like targets before constructing provider dependencies", async () => {
    const deps = dependencies({ status: "no_work" });
    const response = await handleSmsInvoiceCertificationRequest(request(), deps, {
      ...stagingEnv(),
      CERTIFICATION_ENVIRONMENT_ID: "staging-production",
    });

    expect(response.status).toBe(503);
    expect(deps.createRepository).not.toHaveBeenCalled();
    expect(deps.createProvider).not.toHaveBeenCalled();
    expect(deps.processPeriod).not.toHaveBeenCalled();
  });

  it("requires both the exact environment identity and processor secret", async () => {
    const deps = dependencies({ status: "no_work" });
    const wrongTarget = await handleSmsInvoiceCertificationRequest(
      request(processorKey, "staging-other"),
      deps,
      stagingEnv(),
    );
    const wrongKey = await handleSmsInvoiceCertificationRequest(
      request("wrong-key-with-more-than-thirty-two-characters"),
      deps,
      stagingEnv(),
    );

    expect(wrongTarget.status).toBe(401);
    expect(wrongKey.status).toBe(401);
    expect(deps.processPeriod).not.toHaveBeenCalled();
  });

  it("invokes one tenant and period through the injected invoice boundaries", async () => {
    const deps = dependencies({
      status: "submitted",
      batchId: "batch-1",
      providerInvoiceId: "in_test_1",
    });
    const response = await handleSmsInvoiceCertificationRequest(request(), deps, stagingEnv());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      status: "submitted",
      batchId: "batch-1",
      providerInvoiceId: "in_test_1",
    });
    expect(deps.processPeriod).toHaveBeenCalledWith({
      businessId,
      periodStart,
      periodEnd,
      repository: deps.repository,
      provider: deps.provider,
    });
  });

  it("rejects malformed tenant and non-canonical period input", async () => {
    const deps = dependencies({ status: "no_work" });
    const response = await handleSmsInvoiceCertificationRequest(
      request(processorKey, environmentId, {
        businessId: "not-a-tenant",
        periodStart: "2026-07-01",
        periodEnd,
      }),
      deps,
      stagingEnv(),
    );

    expect(response.status).toBe(400);
    expect(deps.processPeriod).not.toHaveBeenCalled();
  });

  it("returns reconciliation evidence but never exposes a provider failure message", async () => {
    const reconciliation = dependencies({
      status: "reconciliation_required",
      batchId: "batch-2",
      providerInvoiceId: "in_test_2",
    });
    const reconciliationResponse = await handleSmsInvoiceCertificationRequest(
      request(),
      reconciliation,
      stagingEnv(),
    );

    const failed = dependencies({
      status: "failed",
      batchId: "batch-3",
      error: "upstream-secret-bearing-error",
    });
    const failedResponse = await handleSmsInvoiceCertificationRequest(
      request(),
      failed,
      stagingEnv(),
    );
    const failedText = await failedResponse.text();

    expect(reconciliationResponse.status).toBe(202);
    expect(await reconciliationResponse.json()).toEqual({
      status: "reconciliation_required",
      batchId: "batch-2",
      providerInvoiceId: "in_test_2",
    });
    expect(failedResponse.status).toBe(502);
    expect(failedText).not.toContain("upstream-secret-bearing-error");
  });

  it("contains unexpected database or provider exceptions", async () => {
    const deps = dependencies({ status: "no_work" });
    deps.processPeriod.mockRejectedValueOnce(new Error("secret-provider-response"));

    const response = await handleSmsInvoiceCertificationRequest(request(), deps, stagingEnv());
    const text = await response.text();

    expect(response.status).toBe(500);
    expect(text).toContain("SMS invoice certification failed");
    expect(text).not.toContain("secret-provider-response");
  });
});
