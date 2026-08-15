/**
 * Layered deterministic deduplication.
 *
 * Checks a normalised candidate against previously-seen candidates (within the mission)
 * across four identity dimensions in precedence order: canonical domain, provider business
 * id, normalised phone, then normalised name+locality as the cautious fallback. Two
 * businesses are NEVER merged merely because their names are similar — the name+locality
 * key requires BOTH name and locality to match, so "Smith Plumbing — Richmond" and
 * "Smith Plumbing — Geelong" remain distinct.
 *
 * The hard "no duplicate prospect" guarantee is enforced downstream by the
 * prospects.canonical_domain UNIQUE constraint (Slice 1); this layer avoids wasted work
 * and produces explainable duplicate reasons.
 */
import { identityKeys } from "./normalize";
import type { CandidateReason, NormalizedCandidate } from "./types";

/** A lightweight identity index entry for a stored candidate. */
export interface CandidateIdentityEntry {
  id: string;
  domain: string | null;
  providerKey: string | null;
  phone: string | null;
  nameLocality: string | null;
}

export interface DuplicateMatch {
  matchId: string;
  reason: Extract<
    CandidateReason,
    "duplicate_domain" | "duplicate_provider_id" | "duplicate_phone" | "duplicate_name_locality"
  >;
}

/**
 * In-memory index of already-seen candidate identities, supporting incremental additions as
 * a page is processed. Race-safety for the strongest key is provided by the DB unique
 * constraint; this index resolves weaker cross-dimension duplicates within a mission.
 */
export class MissionDedupIndex {
  private byDomain = new Map<string, string>();
  private byProviderKey = new Map<string, string>();
  private byPhone = new Map<string, string>();
  private byNameLocality = new Map<string, string>();

  constructor(entries: CandidateIdentityEntry[] = []) {
    for (const entry of entries) this.add(entry);
  }

  add(entry: CandidateIdentityEntry): void {
    if (entry.domain && !this.byDomain.has(entry.domain)) this.byDomain.set(entry.domain, entry.id);
    if (entry.providerKey && !this.byProviderKey.has(entry.providerKey))
      this.byProviderKey.set(entry.providerKey, entry.id);
    if (entry.phone && !this.byPhone.has(entry.phone)) this.byPhone.set(entry.phone, entry.id);
    if (entry.nameLocality && !this.byNameLocality.has(entry.nameLocality))
      this.byNameLocality.set(entry.nameLocality, entry.id);
  }

  /** First matching prior candidate by precedence, or null if the candidate is new. */
  findDuplicate(candidate: NormalizedCandidate): DuplicateMatch | null {
    const keys = identityKeys(candidate);
    if (keys.domain && this.byDomain.has(keys.domain)) {
      return { matchId: this.byDomain.get(keys.domain)!, reason: "duplicate_domain" };
    }
    if (keys.providerKey && this.byProviderKey.has(keys.providerKey)) {
      return {
        matchId: this.byProviderKey.get(keys.providerKey)!,
        reason: "duplicate_provider_id",
      };
    }
    if (keys.phone && this.byPhone.has(keys.phone)) {
      return { matchId: this.byPhone.get(keys.phone)!, reason: "duplicate_phone" };
    }
    if (keys.nameLocality && this.byNameLocality.has(keys.nameLocality)) {
      return {
        matchId: this.byNameLocality.get(keys.nameLocality)!,
        reason: "duplicate_name_locality",
      };
    }
    return null;
  }
}

/** Build an identity index entry for a normalised candidate + its stored id. */
export function toIdentityEntry(
  id: string,
  candidate: NormalizedCandidate,
): CandidateIdentityEntry {
  const keys = identityKeys(candidate);
  return {
    id,
    domain: keys.domain,
    providerKey: keys.providerKey,
    phone: keys.phone,
    nameLocality: keys.nameLocality,
  };
}
