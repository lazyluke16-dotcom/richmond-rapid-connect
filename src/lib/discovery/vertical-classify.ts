/**
 * Deterministic, explainable vertical classification from provider place types.
 *
 * Independent-review prerequisite #2: for a live provider we must NOT rely on the V1
 * plumbing keyword fallback. Google Places returns place `types` (e.g. `plumber`,
 * `hardware_store`); this classifier uses those to distinguish an actual plumbing
 * contractor from a supplier/wholesaler/retailer/education/directory listing whose name
 * merely contains "plumbing". The result is stamped onto the candidate's `vertical`, so the
 * existing qualifier uses the provider classification rather than keywords.
 */

export type VerticalClass = "plumbing" | "plumbing_supply" | "not_plumbing";

/** Google place types that identify an actual plumbing contractor. */
const PLUMBER_TYPES = new Set(["plumber"]);

/** Types indicating a supplier/retailer/wholesaler rather than a service contractor. */
const SUPPLY_TYPES = new Set([
  "hardware_store",
  "home_improvement_store",
  "home_goods_store",
  "store",
  "wholesaler",
  "plumbing_supply_store",
]);

/** Types that are never a plumber even if "plumber" is coincidentally present. */
const HARD_EXCLUDE_TYPES = new Set([
  "school",
  "university",
  "primary_school",
  "secondary_school",
  "training",
  "local_government_office",
  "real_estate_agency",
  "insurance_agency",
  "travel_agency",
  "lodging",
  "restaurant",
]);

export interface VerticalClassification {
  vertical: VerticalClass;
  reason: string;
}

/**
 * Classify from the primary type + full type list. Explainable and deterministic.
 */
export function classifyPlaceVertical(
  primaryType: string | null | undefined,
  types: string[] | null | undefined,
): VerticalClassification {
  const all = new Set<string>();
  if (primaryType) all.add(primaryType.toLowerCase());
  for (const t of types ?? []) if (t) all.add(t.toLowerCase());

  const hasHardExclude = [...all].some((t) => HARD_EXCLUDE_TYPES.has(t));
  const hasPlumber = [...all].some((t) => PLUMBER_TYPES.has(t));
  const hasSupply = [...all].some((t) => SUPPLY_TYPES.has(t));

  if (hasPlumber && !hasHardExclude) {
    // A plumber that is ALSO a supply store is treated as supply (retail, not a callout
    // service) to keep the demo audience clean.
    if (hasSupply && (primaryType ?? "").toLowerCase() !== "plumber") {
      return { vertical: "plumbing_supply", reason: "plumber+supply types; primary is retail" };
    }
    return { vertical: "plumbing", reason: "place type 'plumber'" };
  }
  if (hasSupply) {
    return { vertical: "plumbing_supply", reason: "retail/wholesale supply place type" };
  }
  return {
    vertical: "not_plumbing",
    reason: hasHardExclude ? "excluded place type" : "no plumber place type",
  };
}
