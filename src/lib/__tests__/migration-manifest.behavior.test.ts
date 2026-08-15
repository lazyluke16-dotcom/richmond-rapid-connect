import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("frozen migration manifest", () => {
  it("matches every migration hash and has no pending SQL", () => {
    const output = execFileSync(
      process.execPath,
      [resolve("scripts/verify-migration-manifest.mjs")],
      { encoding: "utf8" },
    );
    const evidence = JSON.parse(output) as {
      migrationCount: number;
      first: string;
      last: string;
      pendingSqlCount: number;
      manifestSha256: string;
    };

    expect(evidence.migrationCount).toBe(36);
    expect(evidence.first).toBe("20260711045456_3cca7ee8-e722-4172-aaaf-15790bc18c91.sql");
    expect(evidence.last).toBe("20260815120000_prospect_intelligence.sql");
    expect(evidence.pendingSqlCount).toBe(0);
    expect(evidence.manifestSha256).toMatch(/^[a-f0-9]{64}$/);
  });
});
