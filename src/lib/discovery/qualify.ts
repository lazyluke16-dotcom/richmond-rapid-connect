/**
 * Cheap, explainable pre-qualification.
 *
 * Applied BEFORE the relatively expensive Slice-1 crawl/demo build. Every decision is a
 * deterministic rule with a stored reason code — never an opaque LLM yes/no. Reuses the
 * hardened Slice-1 SSRF gate (incl. 6to4/Teredo blocking) for the unsafe-URL check, so an
 * unsafe website is rejected before any fetch is attempted.
 */
import { isFetchableUrl } from "../prospect/url-safety";
import { normalizeLocality } from "./normalize";
import type { CandidateReason, NormalizedCandidate } from "./types";

// Prefix match (no trailing \b) so "plumbing"/"plumbers"/"drains" are recognised.
const PLUMBING_SIGNAL =
  /\b(plumb|drain|hot\s*water|gas\s*fit|burst\s*pipe|pipe|sewer|stormwater|leak|tap|toilet|backflow|gutter)/i;

/**
 * Hosts that are social/directory/aggregator/provider-owned pages, NOT a business's own
 * official website. A discovered "website" on one of these is not a usable research target
 * (the durable demo facts must come from the business's own site), so we treat it as "no
 * official website" rather than researching a Facebook page or a Google profile as if it were
 * the business site.
 */
const NON_OFFICIAL_HOST =
  /(^|\.)(facebook\.com|instagram\.com|twitter\.com|x\.com|linkedin\.com|youtube\.com|tiktok\.com|pinterest\.com|google\.com|business\.site|sites\.google\.com|g\.page|goo\.gl|maps\.app\.goo\.gl|yelp\.com(\.au)?|yellowpages\.com(\.au)?|truelocal\.com\.au|hipages\.com\.au|oneflare\.com\.au|serviceseeking\.com\.au|localsearch\.com\.au|wa\.me|t\.me|linktr\.ee|wixsite\.com)$/i;

export function isLikelyOfficialWebsite(url: string | null): boolean {
  if (!url) return false;
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    return !NON_OFFICIAL_HOST.test(host);
  } catch {
    return false;
  }
}

export interface QualifyInput {
  vertical: string;
  geoTerms: string[];
}

export type QualifyResult = { ok: true } | { ok: false; reason: CandidateReason };

export function qualifyCandidate(
  candidate: NormalizedCandidate,
  mission: QualifyInput,
): QualifyResult {
  // 1. Minimum useful identity: we need at least a name or website or phone.
  if (!candidate.businessName && !candidate.website && !candidate.publicPhone) {
    return { ok: false, reason: "insufficient_identity" };
  }

  // 2. Target vertical relevance (deterministic keyword/vertical match).
  const haystack = [candidate.businessName, candidate.canonicalDomain, candidate.website]
    .filter(Boolean)
    .join(" ");
  const explicitVertical = candidate.vertical?.trim().toLowerCase();
  const verticalOk =
    explicitVertical === mission.vertical.toLowerCase() ||
    (explicitVertical == null && PLUMBING_SIGNAL.test(haystack));
  if (!verticalOk) {
    return { ok: false, reason: "not_target_vertical" };
  }

  // 3. Geography (only when the mission constrains it). Conservative: match ONLY against the
  //    candidate's explicit locality — never the business name or domain, since either can
  //    contain a suburb word coincidentally (e.g. "Richmond Plumbing" or
  //    "richmond-plumbing-sydney.com.au" operating in Sydney). A geo-constrained mission
  //    therefore requires a locality it can confirm; an unconfirmable candidate is rejected.
  if (mission.geoTerms.length > 0) {
    const locality = normalizeLocality(candidate.locality);
    const inGeo =
      locality != null && mission.geoTerms.some((term) => locality.includes(term.toLowerCase()));
    if (!inGeo) return { ok: false, reason: "outside_geography" };
  }

  // 4. A usable OFFICIAL business website is required to research + build a demo. A social/
  //    directory/provider-profile URL is not a research target (durable facts come from the
  //    business's own site), so it counts as no official website.
  if (!candidate.website || !isLikelyOfficialWebsite(candidate.website)) {
    return { ok: false, reason: "no_website" };
  }

  // 5. The website must pass the SSRF/safety gate before any fetch.
  if (!isFetchableUrl(candidate.website) || !candidate.canonicalDomain) {
    return { ok: false, reason: "unsafe_url" };
  }

  return { ok: true };
}
