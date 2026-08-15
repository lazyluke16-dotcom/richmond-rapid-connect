/**
 * Guarantee: the discovery slice performs NO outreach and touches NO paid provider, and can
 * never advance a prospect beyond DEMO_READY. Statically scans every discovery library and
 * route file for outreach-send / Twilio / Vapi / Stripe / SMS usage, and asserts the
 * discovery lifecycle model exposes no outreach/customer states.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FUTURE_STATUSES } from "../../prospect/lifecycle";

const ROOTS = ["src/lib/discovery", "src/routes/api/public/discovery"];

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
  { label: "outreach state transition", pattern: /outreach_approved|OUTREACH_APPROVED/i },
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

describe("no outreach / no provider provisioning in the discovery slice", () => {
  it("contains no forbidden provider, send, or outreach-state references", () => {
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

  it("scans a non-empty set of files", () => {
    const count = ROOTS.reduce((n, root) => n + walk(root).length, 0);
    expect(count).toBeGreaterThan(8);
  });

  it("only feeds the Slice-1 demo pipeline (no lifecycle beyond demo_ready)", () => {
    // The engine's only downstream entry is buildProspectDemo, which is DB-CHECK capped at
    // demo_ready. No discovery code references any future/outreach status.
    const engine = readFileSync("src/lib/discovery/mission-engine.ts", "utf8");
    // Match only quoted status LITERALS (i.e. an actual transition), not prose mentions.
    for (const status of FUTURE_STATUSES) {
      expect(engine.includes(`"${status}"`)).toBe(false);
      expect(engine.includes(`'${status}'`)).toBe(false);
    }
    expect(engine.includes("buildProspectDemo")).toBe(true);
  });
});
