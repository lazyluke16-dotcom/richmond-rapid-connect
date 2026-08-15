/**
 * Anti-hallucination guard.
 *
 * A single choke point that every generated demo configuration must pass before it can
 * be persisted or displayed. It enforces the Issue #21 rule that the system must never
 * invent business-specific pricing, guarantees, licences, response times, offers,
 * policies, warranties, staff identities or availability that is not evidence-backed.
 *
 * The guard is deliberately conservative: it scans generated demo text for phrase
 * patterns that assert an unsourced business-specific claim and rejects the config. It
 * also verifies that every value the config presents as a verified business fact is
 * backed by a fact in the evidence set.
 */
import { factValues, topVerified } from "./evidence";
import type { DemoConfig, ProspectFact } from "./types";

export interface GuardViolation {
  code: string;
  message: string;
}

/** Phrases that would assert a fabricated business specific if not evidence-backed. */
const FORBIDDEN_CLAIM_PATTERNS: { code: string; pattern: RegExp }[] = [
  {
    code: "pricing",
    pattern:
      /\$\s?\d|\bfrom \$?\d|\bfree quote guaranteed\b|\bfixed price\b|\bno call[- ]out fee\b/i,
  },
  {
    code: "discount_offer",
    pattern: /\b(\d+%\s*off|discount|special offer|promo(?:tion)?|coupon|save \$?\d)\b/i,
  },
  {
    code: "guarantee",
    pattern: /\b(guarantee|guaranteed|warranty|money[- ]back|satisfaction guaranteed)\b/i,
  },
  {
    code: "response_time",
    pattern:
      /\b(within \d+\s*(?:min|hour)|\d+\s*(?:min|hour)s?\s*(?:response|arrival|guarantee)|same[- ]day guaranteed)\b/i,
  },
  {
    code: "licence_claim",
    pattern:
      /\b(licen[cs]e(?:d)?\s*(?:no|number|#)|fully licensed and insured|master plumber certified)\b/i,
  },
  {
    code: "accreditation",
    pattern: /\b(accredited|certified partner|award[- ]winning|rated #?1)\b/i,
  },
  {
    code: "booking_policy",
    pattern: /\b(cancellation policy|booking fee|deposit required|payment terms|no[- ]show fee)\b/i,
  },
  { code: "staff_identity", pattern: /\b(ask for|speak to|our owner|founded by)\s+[A-Z][a-z]+/i },
];

/** Values in the config that claim to be verified business facts. */
function verifiedClaims(config: DemoConfig): { field: string; value: string }[] {
  const claims: { field: string; value: string }[] = [];
  config.verifiedServices.forEach((v) => claims.push({ field: "service", value: v }));
  config.verifiedServiceAreas.forEach((v) => claims.push({ field: "service_area", value: v }));
  if (config.openingHours !== "UNKNOWN")
    claims.push({ field: "opening_hours", value: config.openingHours });
  if (config.emergencyService !== "UNKNOWN")
    claims.push({ field: "emergency_service", value: config.emergencyService });
  if (config.publicPhone !== "UNKNOWN")
    claims.push({ field: "public_phone", value: config.publicPhone });
  return claims;
}

/**
 * Assert the generated demo config is safe. Returns the violation list (empty = safe).
 */
export function auditDemoConfig(config: DemoConfig, facts: ProspectFact[]): GuardViolation[] {
  const violations: GuardViolation[] = [];

  // 1. Scan all generated free text for fabricated business specifics.
  const generatedText = [config.greeting, ...config.exampleEnquiries].join("\n");
  for (const rule of FORBIDDEN_CLAIM_PATTERNS) {
    if (rule.pattern.test(generatedText)) {
      violations.push({
        code: `fabricated_${rule.code}`,
        message: `Generated demo language asserts an unsourced ${rule.code.replace("_", " ")} claim.`,
      });
    }
  }

  // 2. Every "verified" value must be backed by a verified fact.
  const verifiedServices = new Set(factValues(facts, "service").map((v) => v.toLowerCase()));
  const verifiedAreas = new Set(factValues(facts, "service_area").map((v) => v.toLowerCase()));
  for (const claim of verifiedClaims(config)) {
    if (claim.field === "service" && !verifiedServices.has(claim.value.toLowerCase())) {
      violations.push({
        code: "unbacked_service",
        message: `Service "${claim.value}" is not evidence-backed.`,
      });
    }
    if (claim.field === "service_area" && !verifiedAreas.has(claim.value.toLowerCase())) {
      violations.push({
        code: "unbacked_area",
        message: `Service area "${claim.value}" is not evidence-backed.`,
      });
    }
    if (claim.field === "opening_hours" && !topVerified(facts, "opening_hours")) {
      violations.push({
        code: "unbacked_hours",
        message: "Opening hours presented without a verified fact.",
      });
    }
    if (claim.field === "emergency_service") {
      const fact = topVerified(facts, "emergency_service");
      if (!fact || fact.normalizedValue !== config.emergencyService) {
        violations.push({
          code: "unbacked_emergency",
          message: "Emergency status presented without matching evidence.",
        });
      }
    }
    if (claim.field === "public_phone" && !topVerified(facts, "public_phone")) {
      violations.push({
        code: "unbacked_phone",
        message: "Public phone presented without a verified fact.",
      });
    }
  }

  // 3. Disclosure must be present and must not claim customer/endorsement status.
  if (!config.disclosure || config.disclosure.length < 40) {
    violations.push({
      code: "missing_disclosure",
      message: "Demo disclosure is missing or too short.",
    });
  }
  if (
    /\b(customer of|uses rapid connect|endorses|partnered with rapid connect)\b/i.test(
      generatedText,
    )
  ) {
    violations.push({
      code: "false_relationship",
      message: "Generated language implies an existing/endorsed relationship.",
    });
  }

  return violations;
}

export function assertDemoConfigSafe(config: DemoConfig, facts: ProspectFact[]): void {
  const violations = auditDemoConfig(config, facts);
  if (violations.length > 0) {
    throw new Error(
      `Demo configuration failed the anti-hallucination guard: ${violations.map((v) => v.code).join(", ")}`,
    );
  }
}

export { FORBIDDEN_CLAIM_PATTERNS };
