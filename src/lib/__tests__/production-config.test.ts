import { describe, expect, it } from "vitest";
import { buildVapiAssistantBody } from "../vapi.server";
import { resolveBillingReturnOrigin } from "../../routes/api/public/billing.checkout";

describe("Vapi production assistant configuration", () => {
  it("uses a reusable credential reference and never embeds a webhook secret", () => {
    const body = buildVapiAssistantBody({
      name: "Example Plumbing Receptionist",
      firstMessage: "Thanks for calling Example Plumbing.",
      systemPrompt: "Collect the caller's plumbing enquiry.",
      serverUrl: "https://app.example/api/public/webhooks/vapi-inbound",
      serverCredentialId: "credential-id",
    });

    expect(body.server).toEqual({
      url: "https://app.example/api/public/webhooks/vapi-inbound",
      credentialId: "credential-id",
    });
    expect(body).not.toHaveProperty("serverUrlSecret");
    expect(body.serverMessages).toEqual(["end-of-call-report"]);
    expect(body.analysisPlan).toMatchObject({
      structuredDataPlan: {
        enabled: true,
        schema: {
          required: expect.arrayContaining(["callback_number", "job_type"]),
          properties: {
            callback_number: { type: "string" },
          },
        },
      },
      summaryPlan: { enabled: true },
    });
    expect(
      (
        body.analysisPlan as {
          structuredDataPlan: { schema: { properties: Record<string, unknown> } };
        }
      ).structuredDataPlan.schema.properties,
    ).not.toHaveProperty("customer_phone");
  });
});

describe("Stripe billing return URLs", () => {
  it("uses the configured production origin instead of an untrusted Origin header", () => {
    const request = new Request("https://internal.example/api/public/billing/checkout", {
      headers: { origin: "https://attacker.example" },
    });

    expect(
      resolveBillingReturnOrigin(request, {
        PUBLIC_JOB_REQUEST_URL: "https://app.example/some/path",
      } as NodeJS.ProcessEnv),
    ).toBe("https://app.example");
  });

  it("uses the request URL only when no production origin is configured", () => {
    const request = new Request("https://app.example/api/public/billing/portal", {
      headers: { origin: "https://attacker.example" },
    });

    expect(resolveBillingReturnOrigin(request, {} as NodeJS.ProcessEnv)).toBe(
      "https://app.example",
    );
  });

  it("allows localhost HTTP for development", () => {
    const request = new Request("http://localhost:3000/api/public/billing/checkout");
    expect(resolveBillingReturnOrigin(request, {} as NodeJS.ProcessEnv)).toBe(
      "http://localhost:3000",
    );
  });

  it("rejects non-local HTTP origins", () => {
    const request = new Request("http://app.example/api/public/billing/checkout");
    expect(() => resolveBillingReturnOrigin(request, {} as NodeJS.ProcessEnv)).toThrow(
      "must use HTTPS",
    );
  });
});
