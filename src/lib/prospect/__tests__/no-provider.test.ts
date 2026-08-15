/**
 * Guarantee: the prospect slice performs NO outreach and touches NO paid provider.
 *
 * Statically scans every prospect library and route file for imports/usages of the
 * outreach-send, Twilio, Vapi, Stripe or SMS subsystems. A match fails the build — this
 * is the machine-checked expression of the V1 safety boundary.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOTS = ["src/lib/prospect", "src/routes/api/public/prospect"];

// Match ACTUAL provider usage — imports, provider env vars, provider clients/endpoints —
// not incidental mentions of a provider name in comments or a competitor-detection regex.
const FORBIDDEN: { label: string; pattern: RegExp }[] = [
  {
    label: "provider/send module import",
    pattern:
      /\b(?:import\b[^;]*from|require\()\s*["'][^"']*(?:twilio|vapi|stripe|nodemailer|resend|@\/lib\/sms|sms-invoicing|@\/lib\/outreach|outreach-report)/i,
  },
  { label: "provider env var", pattern: /process\.env\.(?:TWILIO_|VAPI_|STRIPE_|SMS_)/ },
  {
    label: "provider endpoint/client",
    pattern: /api\.vapi\.ai|new\s+Stripe\b|twilio\(|client\.messages\.create/i,
  },
];

function walk(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.tsx?$/.test(entry) && !full.includes("__tests__")) out.push(full);
  }
  return out;
}

describe("no outreach / no provider provisioning in the prospect slice", () => {
  it("contains no forbidden provider or send references", () => {
    const offenders: string[] = [];
    for (const root of ROOTS) {
      for (const file of walk(root)) {
        const contents = readFileSync(file, "utf8");
        for (const rule of FORBIDDEN) {
          if (rule.pattern.test(contents)) offenders.push(`${file} :: ${rule.label}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("scans a non-empty set of files (guard is actually running)", () => {
    const count = ROOTS.reduce((n, root) => n + walk(root).length, 0);
    expect(count).toBeGreaterThan(10);
  });
});
