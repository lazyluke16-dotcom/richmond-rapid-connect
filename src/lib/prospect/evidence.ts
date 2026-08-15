/**
 * Evidence / provenance assembly.
 *
 * Converts raw per-page candidates into the authoritative {@link ProspectFact} set. This
 * is where the anti-hallucination contract is enforced at the data layer:
 *   - every verified fact carries a source URL, observed context and confidence
 *   - when two sources disagree on a single-valued fact (phone/address/hours) the fact is
 *     marked `conflicting`, never silently resolved
 *   - material facts with no evidence are emitted as explicit `unknown` rows, so nothing
 *     downstream can mistake absence for a value
 */
import type { FactType, ProspectFact, RawCandidateLike } from "./types";

export interface PageExtractionInput {
  sourceUrl: string;
  retrievedAt: string;
  candidatesByType: Partial<Record<FactType, RawCandidateLike[]>>;
}

/** Material facts that must always be represented — as verified/conflicting or unknown. */
export const MATERIAL_FACT_TYPES: FactType[] = [
  "business_name",
  "service",
  "service_area",
  "opening_hours",
  "emergency_service",
  "address",
  "public_phone",
];

/** Facts where multiple distinct values are legitimate (multi-valued). */
const MULTI_VALUED: Set<FactType> = new Set([
  "service",
  "service_area",
  "example_enquiry",
  "brand_colour",
  "positioning",
]);

interface Accumulated {
  value: string;
  normalized: string;
  confidence: number;
  sourceUrl: string;
  context: string;
  retrievedAt: string;
  extractor: ProspectFact["extractor"];
}

function normalize(factType: FactType, value: string): string {
  const base = value.trim().replace(/\s+/g, " ");
  switch (factType) {
    case "public_phone":
      return base.replace(/[^\d+]/g, "");
    case "service":
    case "service_area":
    case "business_name":
    case "emergency_service":
      return base.toLowerCase();
    default:
      return base.toLowerCase().slice(0, 200);
  }
}

/**
 * Build the fact set for a prospect from one or more page extractions.
 */
export function assembleFacts(pages: PageExtractionInput[]): ProspectFact[] {
  // Group candidates per (factType, normalizedValue), keeping the strongest evidence.
  const groups = new Map<string, Map<string, Accumulated>>();
  for (const page of pages) {
    for (const [type, candidates] of Object.entries(page.candidatesByType) as [
      FactType,
      RawCandidateLike[],
    ][]) {
      if (!candidates) continue;
      const byValue = groups.get(type) ?? new Map<string, Accumulated>();
      groups.set(type, byValue);
      for (const candidate of candidates) {
        const normalized = normalize(type, candidate.value);
        if (!normalized) continue;
        const existing = byValue.get(normalized);
        const confidence = clamp01(candidate.strength);
        if (!existing || confidence > existing.confidence) {
          byValue.set(normalized, {
            value: candidate.value.trim(),
            normalized,
            confidence,
            sourceUrl: page.sourceUrl,
            context: candidate.context,
            retrievedAt: page.retrievedAt,
            extractor: candidate.extractor,
          });
        }
      }
    }
  }

  const facts: ProspectFact[] = [];

  for (const [type, byValue] of groups) {
    const factType = type as FactType;
    const values = [...byValue.values()].sort((a, b) => b.confidence - a.confidence);
    if (values.length === 0) continue;

    if (MULTI_VALUED.has(factType)) {
      for (const acc of values) facts.push(verified(factType, acc));
      continue;
    }

    // Single-valued fact: detect genuine conflict among confidently-sourced values.
    const strong = values.filter((v) => v.confidence >= 0.6);
    const distinct = new Set(strong.map((v) => v.normalized));
    if (distinct.size > 1) {
      // Mark the top value conflicting and record the competing evidence in context.
      const [top, ...rest] = values;
      facts.push({
        factType,
        value: top.value,
        normalizedValue: top.normalized,
        status: "conflicting",
        confidence: Math.min(top.confidence, 0.5),
        extractor: top.extractor,
        evidence: {
          sourceUrl: top.sourceUrl,
          observedContext: `Conflicting sources. Top: "${top.context}". Others: ${rest
            .slice(0, 2)
            .map((r) => `"${r.value}" @ ${r.sourceUrl}`)
            .join("; ")}`,
          retrievedAt: top.retrievedAt,
          confidence: Math.min(top.confidence, 0.5),
        },
      });
    } else {
      facts.push(verified(factType, values[0]));
    }
  }

  // Emit explicit unknowns for any material fact with no verified/conflicting row.
  const present = new Set(facts.map((f) => f.factType));
  for (const type of MATERIAL_FACT_TYPES) {
    if (!present.has(type)) facts.push(unknown(type));
  }

  return facts;
}

function verified(factType: FactType, acc: Accumulated): ProspectFact {
  return {
    factType,
    value: acc.value,
    normalizedValue: acc.normalized,
    status: "verified",
    confidence: acc.confidence,
    extractor: acc.extractor,
    evidence: {
      sourceUrl: acc.sourceUrl,
      observedContext: acc.context,
      retrievedAt: acc.retrievedAt,
      confidence: acc.confidence,
    },
  };
}

function unknown(factType: FactType): ProspectFact {
  return {
    factType,
    value: "UNKNOWN",
    normalizedValue: "unknown",
    status: "unknown",
    confidence: 0,
    extractor: "system",
    evidence: null,
  };
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

/** Convenience: pull verified/conflicting values of a type, highest confidence first. */
export function factValues(facts: ProspectFact[], factType: FactType, minConfidence = 0): string[] {
  return facts
    .filter(
      (f) => f.factType === factType && f.status === "verified" && f.confidence >= minConfidence,
    )
    .sort((a, b) => b.confidence - a.confidence)
    .map((f) => f.value);
}

export function topVerified(
  facts: ProspectFact[],
  factType: FactType,
  minConfidence = 0,
): ProspectFact | null {
  return (
    facts
      .filter(
        (f) => f.factType === factType && f.status === "verified" && f.confidence >= minConfidence,
      )
      .sort((a, b) => b.confidence - a.confidence)[0] ?? null
  );
}
