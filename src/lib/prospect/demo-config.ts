/**
 * Safe demo configuration generator.
 *
 * Transforms the verified fact set + branding into a receptionist demo configuration.
 * The generator is deterministic and auditable: every value it emits is either (a) a
 * sourced business fact, (b) clearly-marked generic demo behaviour, or (c) the literal
 * "UNKNOWN". It never converts a generic assumption into a business fact, and the output
 * is validated by the anti-hallucination guard before use.
 */
import { assertDemoConfigSafe } from "./anti-hallucination";
import { factValues, topVerified } from "./evidence";
import type { Branding, DemoConfig, DemoProvenanceEntry, FactType, ProspectFact } from "./types";

export const DEMO_CONFIG_VERSION = "v1";

export const DEMO_DISCLOSURE =
  "This is a private Rapid Connect demonstration prepared using publicly available business information. " +
  "It does not indicate that this business currently uses or endorses Rapid Connect.";

/** Generic example enquiries, used ONLY when no verified service supports a specific one. */
const GENERIC_EXAMPLE_ENQUIRIES = [
  "Hi, I'd like to book a plumber — can you take my details?",
  "What's the best way to get a callback about a job?",
];

/** Map a verified service into a safe, service-specific example enquiry. */
function exampleEnquiryForService(service: string): string {
  const lower = service.toLowerCase();
  if (lower.includes("blocked drain"))
    return "My kitchen drain is blocked — can someone take a look?";
  if (lower.includes("hot water")) return "Our hot water system stopped working — can you help?";
  if (lower.includes("burst") || lower.includes("pipe"))
    return "I think we have a burst pipe — what should I do?";
  if (lower.includes("gas"))
    return "I can smell gas near the meter — can a gas fitter call me back?";
  if (lower.includes("toilet")) return "Our toilet won't stop running — can you book someone in?";
  if (lower.includes("tap") || lower.includes("mixer"))
    return "We have a dripping tap that needs fixing.";
  if (lower.includes("leak"))
    return "There's water pooling under the sink — can you check for a leak?";
  if (lower.includes("roof") || lower.includes("gutter"))
    return "Our gutter is leaking — can you send someone?";
  if (lower.includes("sewer") || lower.includes("stormwater"))
    return "There's a smell from the drain outside — is that something you handle?";
  if (lower.includes("hot")) return "Our hot water has gone cold — can you take a look?";
  return `I need help with ${service.toLowerCase()} — can you take my details?`;
}

export interface DemoConfigInput {
  businessName: string;
  facts: ProspectFact[];
  branding: Branding;
  generatedAt: string;
}

export function generateDemoConfig(input: DemoConfigInput): DemoConfig {
  const { facts, branding, generatedAt } = input;
  const businessName = input.businessName || branding.displayName;

  const verifiedServices = factValues(facts, "service", 0.4).slice(0, 8);
  const verifiedServiceAreas = factValues(facts, "service_area", 0.4).slice(0, 12);

  const hoursFact = topVerified(facts, "opening_hours");
  const openingHours: DemoConfig["openingHours"] = hoursFact ? hoursFact.value : "UNKNOWN";

  const emergencyFact = topVerified(facts, "emergency_service");
  const emergencyService: DemoConfig["emergencyService"] =
    emergencyFact?.normalizedValue === "yes"
      ? "yes"
      : emergencyFact?.normalizedValue === "no"
        ? "no"
        : "UNKNOWN";

  const phoneFact = topVerified(facts, "public_phone");
  const publicPhone: DemoConfig["publicPhone"] = phoneFact ? phoneFact.value : "UNKNOWN";

  // Greeting: business name only (sourced or domain-derived). No fabricated specifics.
  const greeting = `Thanks for calling ${businessName}. You've reached our AI receptionist — how can I help you today?`;

  // Example enquiries: prefer service-specific ones (each backed by a verified service),
  // fall back to clearly-generic enquiries when nothing specific is sourced.
  const specificEnquiries = verifiedServices.slice(0, 3).map(exampleEnquiryForService);
  const exampleEnquiries =
    specificEnquiries.length > 0 ? specificEnquiries : [...GENERIC_EXAMPLE_ENQUIRIES];

  // Record which material facts are deliberately unknown, so the demo can disclose them.
  const unknowns: FactType[] = [];
  if (openingHours === "UNKNOWN") unknowns.push("opening_hours");
  if (emergencyService === "UNKNOWN") unknowns.push("emergency_service");
  if (publicPhone === "UNKNOWN") unknowns.push("public_phone");
  if (verifiedServiceAreas.length === 0) unknowns.push("service_area");
  if (verifiedServices.length === 0) unknowns.push("service");

  const provenance = buildProvenance(facts, {
    services: verifiedServices,
    areas: verifiedServiceAreas,
    openingHours,
    emergencyService,
    publicPhone,
  });

  const config: DemoConfig = {
    businessName,
    greeting,
    verifiedServices,
    verifiedServiceAreas,
    openingHours,
    emergencyService,
    publicPhone,
    exampleEnquiries,
    unknowns,
    disclosure: DEMO_DISCLOSURE,
    provenance,
    branding,
    generatedAt,
    configVersion: DEMO_CONFIG_VERSION,
  };

  // Fail closed: never emit a config that fabricates or over-claims.
  assertDemoConfigSafe(config, facts);
  return config;
}

function buildProvenance(
  facts: ProspectFact[],
  selected: {
    services: string[];
    areas: string[];
    openingHours: string;
    emergencyService: string;
    publicPhone: string;
  },
): DemoProvenanceEntry[] {
  const entries: DemoProvenanceEntry[] = [];
  const add = (field: string, value: string, fact: ProspectFact | null) => {
    if (fact?.evidence) {
      entries.push({
        field,
        value,
        sourceUrl: fact.evidence.sourceUrl,
        confidence: fact.confidence,
      });
    }
  };
  const byValue = (type: FactType, value: string) =>
    facts.find((f) => f.factType === type && f.value === value) ?? null;

  for (const service of selected.services) add("service", service, byValue("service", service));
  for (const area of selected.areas) add("service_area", area, byValue("service_area", area));
  if (selected.openingHours !== "UNKNOWN")
    add("opening_hours", selected.openingHours, topVerified(facts, "opening_hours"));
  if (selected.emergencyService !== "UNKNOWN")
    add("emergency_service", selected.emergencyService, topVerified(facts, "emergency_service"));
  if (selected.publicPhone !== "UNKNOWN")
    add("public_phone", selected.publicPhone, topVerified(facts, "public_phone"));
  return entries;
}
