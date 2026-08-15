/**
 * Bounded AI extraction adapter.
 *
 * Architectural principle (Issue #21): do NOT build one giant autonomous LLM agent. The
 * deterministic HTML extractor is the source of truth; an AI extractor may only ever
 * *propose additional candidates* which are then subjected to the exact same evidence,
 * confidence, conflict and anti-hallucination rules as deterministic candidates. AI
 * output is never trusted directly and is capped at a modest confidence.
 *
 * The default {@link NullAiExtractor} proposes nothing, so the entire pipeline — and the
 * whole test suite — runs deterministically with no provider credentials. A real
 * provider adapter can be added behind this interface without touching the prospect
 * model. This is the provider seam, deliberately shipped disabled in V1.
 */
import type { FactType, RawCandidateLike } from "./types";

export interface AiExtractionRequest {
  /** Plain-text (tags stripped) content of the page. */
  text: string;
  sourceUrl: string;
  /** Fact types the caller would like help classifying/extracting. */
  wanted: FactType[];
}

export interface AiExtractor {
  readonly name: string;
  /** Return candidate facts. Confidence is clamped by the caller to <= AI_MAX_CONFIDENCE. */
  propose(request: AiExtractionRequest): Promise<Partial<Record<FactType, RawCandidateLike[]>>>;
}

/** AI-proposed candidates can never exceed this confidence — they are assistive only. */
export const AI_MAX_CONFIDENCE = 0.6;

/** Default: proposes nothing. The deterministic layer remains fully authoritative. */
export class NullAiExtractor implements AiExtractor {
  readonly name = "null";
  async propose(): Promise<Partial<Record<FactType, RawCandidateLike[]>>> {
    return {};
  }
}

/** Clamp/relabel AI candidates so they can never masquerade as high-confidence evidence. */
export function sanitizeAiCandidates(
  proposed: Partial<Record<FactType, RawCandidateLike[]>>,
): Partial<Record<FactType, RawCandidateLike[]>> {
  const out: Partial<Record<FactType, RawCandidateLike[]>> = {};
  for (const [type, candidates] of Object.entries(proposed) as [FactType, RawCandidateLike[]][]) {
    if (!Array.isArray(candidates)) continue;
    out[type] = candidates
      .filter((c) => c && typeof c.value === "string" && c.value.trim())
      .map((c) => ({
        value: c.value.trim().slice(0, 300),
        context: (c.context ?? "AI-proposed").slice(0, 300),
        strength: Math.min(AI_MAX_CONFIDENCE, Math.max(0, Number(c.strength) || 0)),
        extractor: "ai-assisted" as const,
      }));
  }
  return out;
}

let configuredExtractor: AiExtractor = new NullAiExtractor();

/** Resolve the active extractor. Defaults to the null extractor unless one is installed. */
export function getAiExtractor(): AiExtractor {
  return configuredExtractor;
}

/** Install a provider adapter (used by a future slice; not enabled in V1). */
export function setAiExtractor(extractor: AiExtractor): void {
  configuredExtractor = extractor;
}
