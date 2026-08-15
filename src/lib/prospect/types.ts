/**
 * Autonomous Acquisition V1 — shared prospect domain types.
 *
 * These types are the application-level contract for the prospect intelligence and
 * demo-factory slice (Issue #21). Application/database state is the source of truth;
 * AI is a bounded assistant that may only ever produce candidate facts, never
 * authoritative business facts. See docs/AUTONOMOUS_ACQUISITION_V1.md.
 */

/**
 * Lifecycle states. The full customer journey is modelled for forward-compatibility,
 * but V1 may only ever reach `demo_ready` — enforced by the database CHECK constraint
 * and by {@link isV1ReachableStatus}.
 */
export type ProspectStatus =
  "discovered" | "researching" | "enriched" | "demo_building" | "demo_ready";

/** States reserved for later slices; unreachable in V1. */
export type FutureProspectStatus =
  "outreach_approved" | "contacted" | "engaged" | "trial" | "paid" | "customer";

export type FactType =
  | "business_name"
  | "service"
  | "service_area"
  | "opening_hours"
  | "emergency_service"
  | "address"
  | "public_phone"
  | "positioning"
  | "brand_colour"
  | "logo"
  | "example_enquiry";

/**
 * `verified` — sourced with evidence. `unknown` — deliberately could not be verified
 * (a first-class value; never fabricate). `conflicting` — sources disagreed.
 */
export type FactStatus = "verified" | "unknown" | "conflicting";

export type FactExtractor =
  "deterministic-html" | "structured-data" | "ai-assisted" | "operator" | "system";

export type ScoreBand = "low" | "medium" | "high" | "priority";

export interface Evidence {
  sourceUrl: string;
  observedContext: string;
  retrievedAt: string;
  confidence: number;
}

/** Minimal candidate shape produced by extractors and consumed by evidence assembly. */
export interface RawCandidateLike {
  value: string;
  context: string;
  strength: number;
  extractor: "deterministic-html" | "structured-data" | "ai-assisted";
}

export interface ProspectFact {
  factType: FactType;
  value: string;
  normalizedValue: string;
  status: FactStatus;
  confidence: number;
  extractor: FactExtractor;
  /** Present for verified/conflicting facts; null for unknown. */
  evidence: Evidence | null;
}

export interface ScoreFactor {
  key: string;
  label: string;
  points: number;
  awarded: boolean;
  detail: string;
}

export interface ProspectScore {
  score: number;
  band: ScoreBand;
  factors: ScoreFactor[];
  engineVersion: string;
}

export interface BrandColours {
  primary: string | null;
  secondary: string | null;
  accent: string | null;
}

export interface Branding {
  displayName: string;
  logoUrl: string | null;
  faviconUrl: string | null;
  colours: BrandColours;
  source: "extracted" | "favicon_fallback" | "default";
}

/**
 * The auditable demo receptionist configuration. Values are strictly partitioned into
 * `verified` (sourced business facts), `generic` (clearly-marked generic demo
 * behaviour) and `unknown` (deliberately withheld). Generated language must never
 * silently promote a generic assumption into a business fact.
 */
export interface DemoConfig {
  businessName: string;
  greeting: string;
  verifiedServices: string[];
  verifiedServiceAreas: string[];
  openingHours: string | "UNKNOWN";
  emergencyService: "yes" | "no" | "UNKNOWN";
  publicPhone: string | "UNKNOWN";
  exampleEnquiries: string[];
  /** Fields explicitly left unknown, so the demo can disclose rather than invent. */
  unknowns: FactType[];
  disclosure: string;
  /** Provenance for every verified value that appears in the demo. */
  provenance: DemoProvenanceEntry[];
  branding: Branding;
  generatedAt: string;
  configVersion: string;
}

export interface DemoProvenanceEntry {
  field: string;
  value: string;
  sourceUrl: string;
  confidence: number;
}

/** The full research product for a single business, before persistence. */
export interface ResearchResult {
  businessName: string | null;
  website: string;
  canonicalDomain: string;
  industry: string;
  facts: ProspectFact[];
  branding: Branding;
  score: ProspectScore;
  /** Non-fatal notes (e.g. a page skipped, an asset rejected). */
  notes: string[];
}
