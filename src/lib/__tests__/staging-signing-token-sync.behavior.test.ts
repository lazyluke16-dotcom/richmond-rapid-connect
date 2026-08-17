import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const SYNC_SCRIPT_PATH = "scripts/sync-staging-twilio-signing-token.mjs";
const SYNC_STEP = "node scripts/sync-staging-twilio-signing-token.mjs";

const DEPLOY_WORKFLOWS = [
  ".github/workflows/smart-answer-staging-deployment.yml",
  ".github/workflows/staging-deployment.yml",
  ".github/workflows/staging-rollback.yml",
];

const BULK_UPLOAD_WORKFLOWS = [
  ".github/workflows/smart-answer-staging-deployment.yml",
  ".github/workflows/staging-deployment.yml",
];

function read(path: string): string {
  return readFileSync(path, "utf8").replace(/\r\n/g, "\n");
}

describe("staging Twilio signing-token sync is canonical and durable", () => {
  it("every staging Worker deployment/rollback path runs the canonical sync", () => {
    for (const path of DEPLOY_WORKFLOWS) {
      expect(read(path)).toContain(SYNC_STEP);
    }
  });

  it("no staging deploy uploads Worker TWILIO_AUTH_TOKEN from a GitHub secret via bulk", () => {
    for (const path of BULK_UPLOAD_WORKFLOWS) {
      const wf = read(path);
      const bulkStart = wf.indexOf("wrangler secret bulk");
      expect(bulkStart).toBeGreaterThan(0);
      // The bulk-upload `names` array precedes the wrangler invocation.
      const namesStart = wf.lastIndexOf("const names = [", bulkStart);
      const uploadRegion = wf.slice(namesStart, bulkStart);
      expect(uploadRegion).not.toContain('"TWILIO_AUTH_TOKEN"');
    }
  });

  it("no workflow depends on the manually-maintained webhook token at runtime", () => {
    for (const path of DEPLOY_WORKFLOWS) {
      expect(read(path)).not.toContain("secrets.TWILIO_WEBHOOK_AUTH_TOKEN");
    }
  });

  it("the rollback path re-syncs the current token so it cannot regress", () => {
    const rollback = read(".github/workflows/staging-rollback.yml");
    const rollbackIdx = rollback.indexOf("rollback ${{ inputs.version_id }}");
    const syncIdx = rollback.indexOf(SYNC_STEP);
    expect(rollbackIdx).toBeGreaterThan(0);
    expect(syncIdx).toBeGreaterThan(rollbackIdx);
  });

  it("the sync script targets only the staging Worker and guards account identity", () => {
    const script = read(SYNC_SCRIPT_PATH);
    expect(script).toContain('EXPECTED_WORKER_NAME = "richmond-rapid-connect-acquisition-staging"');
    expect(script).toContain('EXPECTED_ACCOUNT_FRIENDLY_NAME = "Richmond Rapid Connect Hosted Staging"');
    // Fail-closed guards.
    expect(script).toContain("WORKER !== EXPECTED_WORKER_NAME");
    expect(script).toContain("/prod/i.test(WORKER)");
    expect(script).toContain("SID !== EXPECTED_SID");
    expect(script).toContain("friendly_name !== EXPECTED_ACCOUNT_FRIENDLY_NAME");
    // Worker secret binding name is fixed.
    expect(script).toContain('name: "TWILIO_AUTH_TOKEN"');
  });

  it("the sync script never persists or logs the token", () => {
    const script = read(SYNC_SCRIPT_PATH);
    // No console output includes the token variable.
    expect(script).not.toMatch(/console\.(log|error)\([^)]*\btoken\b/);
    // Token never written to disk, GitHub output, or hashed (usage, not mentions).
    expect(script).not.toMatch(/writeFileSync[^)]*token/);
    expect(script).not.toMatch(/process\.env\.GITHUB_OUTPUT/);
    expect(script).not.toMatch(/>>\s*[^\n]*GITHUB_OUTPUT/);
    expect(script).not.toMatch(/createHash\([^)]*\).*token/);
    // The token is dropped after use.
    expect(script).toContain("token = null");
  });

  it("commits no literal Twilio credential or account SID", () => {
    const files = [SYNC_SCRIPT_PATH, ...DEPLOY_WORKFLOWS];
    for (const path of files) {
      const text = read(path);
      // No raw 32-hex auth token literal.
      expect(text).not.toMatch(/\b[0-9a-f]{32}\b/);
      // No literal Twilio Account SID (AC + 32 hex).
      expect(text).not.toMatch(/\bAC[0-9a-f]{32}\b/i);
    }
  });
});
