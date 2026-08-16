import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const WORKFLOW_PATH = ".github/workflows/smart-answer-staging-deployment.yml";

function readWorkflow(): string {
  // Normalise line endings so assertions are stable on both LF and CRLF checkouts.
  return readFileSync(WORKFLOW_PATH, "utf8").replace(/\r\n/g, "\n");
}

function sliceStep(workflow: string, startName: string, endName: string): string {
  const start = workflow.indexOf(`- name: ${startName}`);
  const end = workflow.indexOf(`- name: ${endName}`);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return workflow.slice(start, end);
}

describe("smart answer staging deployment — Twilio webhook token", () => {
  it("requires the PRIMARY webhook token as its own credential", () => {
    const validation = sliceStep(
      readWorkflow(),
      "Validate Smart Answer staging credentials without revealing values",
      "Link isolated Supabase staging project",
    );

    // Credential validation must demand the dedicated webhook token...
    expect(validation).toContain(
      "TWILIO_WEBHOOK_AUTH_TOKEN: ${{ secrets.TWILIO_WEBHOOK_AUTH_TOKEN }}",
    );
    expect(validation).toContain('"TWILIO_WEBHOOK_AUTH_TOKEN",');

    // ...while keeping the SECONDARY REST token logically separate.
    expect(validation).toContain("TWILIO_AUTH_TOKEN: ${{ secrets.TWILIO_AUTH_TOKEN }}");
  });

  it("uploads the PRIMARY token into the Worker's encrypted TWILIO_AUTH_TOKEN binding", () => {
    const upload = sliceStep(
      readWorkflow(),
      "Upload runtime secrets to staging Worker",
      "Deploy only the staging-named Cloudflare Worker",
    );

    // The Worker runtime binding named TWILIO_AUTH_TOKEN must be sourced from the
    // PRIMARY webhook token, never the secondary REST token.
    expect(upload).toContain("TWILIO_AUTH_TOKEN: ${{ secrets.TWILIO_WEBHOOK_AUTH_TOKEN }}");
    expect(upload).not.toContain("TWILIO_AUTH_TOKEN: ${{ secrets.TWILIO_AUTH_TOKEN }}");

    // It must ship as an encrypted Worker secret via the bulk uploader...
    expect(upload).toContain('"TWILIO_AUTH_TOKEN",');
    expect(upload).toContain("npx wrangler secret bulk");
    expect(upload).toContain('--name "$CLOUDFLARE_STAGING_WORKER_NAME"');

    // ...and must never be echoed/printed.
    expect(upload).not.toMatch(/echo[^\n]*TWILIO/);
    expect(upload).not.toMatch(/console\.log[^\n]*TWILIO_(AUTH|WEBHOOK)/);
  });

  it("never passes the webhook token as a plaintext --var", () => {
    const deploy = sliceStep(
      readWorkflow(),
      "Deploy only the staging-named Cloudflare Worker",
      "Verify hosted staging responds",
    );

    expect(deploy).not.toContain("--var TWILIO_AUTH_TOKEN");
    expect(deploy).not.toContain("--var TWILIO_WEBHOOK_AUTH_TOKEN");
    // PUBLIC_JOB_REQUEST_URL (used for X-Twilio-Signature) stays the staging origin.
    expect(deploy).toContain("--var PUBLIC_JOB_REQUEST_URL:${{ vars.CERTIFICATION_BASE_URL }}");
  });

  it("stays staging-only and never targets a production resource", () => {
    const workflow = readWorkflow();
    // Runs in the protected staging environment only.
    expect(workflow).toContain("environment:\n      name: staging");
    // Every wrangler target is the staging Worker var — both the upload and the
    // deploy steps reference it indirectly, never a hardcoded worker name.
    expect(workflow).toContain('--name "$CLOUDFLARE_STAGING_WORKER_NAME"');
    expect(workflow).toContain("--name ${{ vars.CLOUDFLARE_STAGING_WORKER_NAME }}");
    // No production Cloudflare Worker target leaks in.
    expect(workflow).not.toMatch(/--name\s+[a-z0-9-]*prod/i);
  });

  it("keeps every Twilio token as a GitHub secret reference — no literal token in source", () => {
    const workflow = readWorkflow();

    // Every line mentioning the webhook token is a safe reference: a
    // ${{ secrets.* }} binding, a quoted required-list entry, or a comment.
    const tokenLines = workflow
      .split("\n")
      .filter((line) => line.includes("TWILIO_WEBHOOK_AUTH_TOKEN"));
    expect(tokenLines.length).toBeGreaterThan(0);
    for (const line of tokenLines) {
      const trimmed = line.trim();
      const isSecretRef = line.includes("${{ secrets.TWILIO_WEBHOOK_AUTH_TOKEN }}");
      const isListEntry = trimmed === '"TWILIO_WEBHOOK_AUTH_TOKEN",';
      const isComment = trimmed.startsWith("#");
      expect(isSecretRef || isListEntry || isComment).toBe(true);
    }
    // No raw 32-hex Twilio auth-token literal committed anywhere in the workflow.
    expect(workflow).not.toMatch(/\b[0-9a-f]{32}\b/);
  });
});
