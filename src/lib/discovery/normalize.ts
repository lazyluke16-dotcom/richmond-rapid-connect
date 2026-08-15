/**
 * Deterministic identity normalisation for discovery candidates.
 *
 * Reuses the Slice-1 canonical-domain derivation so a discovered website dedups against
 * existing prospects. Produces the canonical fields and a primary deduplication key from
 * the strongest available identity signal (domain > provider id > phone > name+locality).
 */
import { tryCanonicalDomain } from "../prospect/canonical";
import type { NormalizedCandidate, RawDiscoveryCandidate } from "./types";

/** Normalise an AU business phone to digits with a country prefix, or null if implausible. */
export function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let digits = raw.replace(/[^\d+]/g, "");
  if (digits.startsWith("+")) digits = digits.slice(1);
  digits = digits.replace(/\D/g, "");
  if (!digits) return null;
  if (digits.startsWith("0")) digits = `61${digits.slice(1)}`;
  else if (!digits.startsWith("61")) digits = `61${digits}`;
  // AU numbers are 61 + 9 digits.
  if (digits.length < 10 || digits.length > 12) return null;
  return digits;
}

/** Lowercase, strip punctuation, drop generic suffixes, collapse whitespace. */
export function normalizeName(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const cleaned = raw
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\b(pty|ltd|inc|co|the|and)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || null;
}

export function normalizeLocality(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || null;
}

function boundedWebsite(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 2000) return null;
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

/** All identity keys a candidate exposes, in precedence order (strongest first). */
export interface CandidateIdentityKeys {
  domain: string | null;
  providerKey: string | null; // `${source}:${providerBusinessId}`
  phone: string | null;
  nameLocality: string | null; // `${normName}|${normLocality}`
}

export function identityKeys(candidate: NormalizedCandidate): CandidateIdentityKeys {
  const normName = normalizeName(candidate.businessName);
  const normLoc = normalizeLocality(candidate.locality);
  return {
    domain: candidate.canonicalDomain,
    providerKey:
      candidate.providerBusinessId != null && candidate.providerBusinessId !== ""
        ? `${candidate.source}:${candidate.providerBusinessId}`
        : null,
    phone: candidate.publicPhone,
    // Name+locality is only a usable key when BOTH are present (so same-name businesses in
    // different localities never collide).
    nameLocality: normName && normLoc ? `${normName}|${normLoc}` : null,
  };
}

/** Build the primary dedup_key (strongest available signal). Never empty. */
export function primaryDedupKey(keys: CandidateIdentityKeys, fallbackSeed: string): string {
  if (keys.domain) return `dom:${keys.domain}`.slice(0, 400);
  if (keys.providerKey) return `pid:${keys.providerKey}`.slice(0, 400);
  if (keys.phone) return `ph:${keys.phone}`.slice(0, 400);
  if (keys.nameLocality) return `nm:${keys.nameLocality}`.slice(0, 400);
  return `none:${fallbackSeed}`.slice(0, 400);
}

export function normalizeCandidate(raw: RawDiscoveryCandidate, index: number): NormalizedCandidate {
  const website = boundedWebsite(raw.website);
  const canonicalDomain = website ? tryCanonicalDomain(website) : null;
  const normalized: NormalizedCandidate = {
    source: raw.source,
    providerBusinessId: raw.providerBusinessId ?? null,
    sourceUrl: raw.sourceUrl && /^https?:\/\//i.test(raw.sourceUrl) ? raw.sourceUrl : null,
    businessName: raw.businessName?.trim() ? raw.businessName.trim().slice(0, 200) : null,
    website,
    canonicalDomain,
    publicPhone: normalizePhone(raw.publicPhone),
    locality: raw.locality?.trim() ? raw.locality.trim().slice(0, 200) : null,
    vertical: raw.vertical ?? null,
    dedupKey: "",
  };
  const seed = `${raw.source}:${raw.providerBusinessId ?? ""}:${normalized.businessName ?? ""}:${raw.sourceUrl ?? ""}:${index}`;
  normalized.dedupKey = primaryDedupKey(identityKeys(normalized), seed);
  return normalized;
}
