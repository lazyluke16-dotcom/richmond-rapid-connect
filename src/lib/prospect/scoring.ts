/**
 * Deterministic, rules-based prospect scoring.
 *
 * The score is NOT produced by an LLM. It is a transparent sum of configurable factors,
 * each of which records the points it awarded (or deducted) and a human-readable reason,
 * so an operator can always understand and later re-tune the result against real
 * conversion evidence. The engine is a pure function of the evidence set + a few signals.
 */
import { factValues, topVerified } from "./evidence";
import type { ProspectFact, ProspectScore, ScoreBand, ScoreFactor } from "./types";

export interface ScoringSignals {
  /** The site was reachable and returned parseable HTML. */
  websiteReachable: boolean;
  /** An existing AI-receptionist/chatbot vendor was detected (reduces opportunity). */
  existingAiReceptionist: boolean;
  /** Service areas fall within the target geography (e.g. Greater Melbourne/VIC). */
  inTargetGeography: boolean;
}

export interface ScoringWeights {
  functioningWebsite: number;
  publicPhone: number;
  multipleServices: number;
  manyServices: number;
  emergencyService: number;
  serviceAreasPresent: number;
  targetGeography: number;
  positioningPresent: number;
  afterHoursOpportunity: number;
  existingAiReceptionistPenalty: number;
}

export const DEFAULT_WEIGHTS: ScoringWeights = {
  functioningWebsite: 15,
  publicPhone: 12,
  multipleServices: 12,
  manyServices: 10,
  emergencyService: 15,
  serviceAreasPresent: 12,
  targetGeography: 10,
  positioningPresent: 6,
  afterHoursOpportunity: 8,
  existingAiReceptionistPenalty: -20,
};

export const SCORE_ENGINE_VERSION = "v1";

function band(score: number): ScoreBand {
  if (score >= 75) return "priority";
  if (score >= 55) return "high";
  if (score >= 35) return "medium";
  return "low";
}

/** Compute the deterministic score + full factor breakdown. */
export function scoreProspect(
  facts: ProspectFact[],
  signals: ScoringSignals,
  weights: ScoringWeights = DEFAULT_WEIGHTS,
): ProspectScore {
  const factors: ScoreFactor[] = [];
  const add = (key: string, label: string, points: number, awarded: boolean, detail: string) =>
    factors.push({ key, label, points: awarded ? points : 0, awarded, detail });

  const services = factValues(facts, "service");
  const serviceAreas = factValues(facts, "service_area");
  const emergency = topVerified(facts, "emergency_service");
  const phone = topVerified(facts, "public_phone");
  const positioning = topVerified(facts, "positioning");
  const hoursKnown = topVerified(facts, "opening_hours") !== null;

  add(
    "functioning_website",
    "Functioning business website",
    weights.functioningWebsite,
    signals.websiteReachable,
    signals.websiteReachable
      ? "Website was reachable and machine-readable."
      : "Website could not be read.",
  );

  add(
    "public_phone",
    "Public business phone",
    weights.publicPhone,
    Boolean(phone),
    phone ? `Public number sourced (${phone.value}).` : "No public phone number was verified.",
  );

  add(
    "multiple_services",
    "Offers multiple plumbing services",
    weights.multipleServices,
    services.length >= 2,
    `${services.length} distinct service(s) verified.`,
  );

  add(
    "many_services",
    "Broad service range (4+)",
    weights.manyServices,
    services.length >= 4,
    services.length >= 4
      ? `Broad range: ${services.length} services.`
      : "Fewer than four services verified.",
  );

  add(
    "emergency_service",
    "Emergency / 24-7 service",
    weights.emergencyService,
    emergency?.normalizedValue === "yes",
    emergency?.normalizedValue === "yes"
      ? "Emergency/after-hours availability is advertised — strong missed-call recovery fit."
      : "No emergency availability verified.",
  );

  add(
    "service_areas",
    "Defined service areas",
    weights.serviceAreasPresent,
    serviceAreas.length >= 1,
    `${serviceAreas.length} service area(s) verified.`,
  );

  add(
    "target_geography",
    "Within target geography",
    weights.targetGeography,
    signals.inTargetGeography,
    signals.inTargetGeography ? "Serves the target geography." : "Target geography not confirmed.",
  );

  add(
    "positioning",
    "Clear public positioning",
    weights.positioningPresent,
    Boolean(positioning),
    positioning ? "Public positioning/marketing copy present." : "No clear positioning verified.",
  );

  // After-hours opportunity: emergency service advertised but no published hours to
  // manage overflow → strong case for AI receptionist / missed-call recovery.
  const afterHoursOpportunity = emergency?.normalizedValue === "yes" && !hoursKnown;
  add(
    "after_hours_opportunity",
    "After-hours coverage gap",
    weights.afterHoursOpportunity,
    afterHoursOpportunity,
    afterHoursOpportunity
      ? "Advertises emergency work but publishes no hours — likely unmanaged after-hours calls."
      : "No clear after-hours gap.",
  );

  // Penalty: an existing AI receptionist reduces (but does not zero) the opportunity.
  add(
    "existing_ai_receptionist",
    "Existing AI receptionist detected",
    weights.existingAiReceptionistPenalty,
    signals.existingAiReceptionist,
    signals.existingAiReceptionist
      ? "An existing AI/virtual receptionist vendor was detected."
      : "No existing AI receptionist detected.",
  );

  const raw = factors.reduce((sum, factor) => sum + factor.points, 0);
  const score = Math.max(0, Math.min(100, raw));

  return { score, band: band(score), factors, engineVersion: SCORE_ENGINE_VERSION };
}
