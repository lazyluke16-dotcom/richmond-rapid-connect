/**
 * ProspectResearchService — orchestrates the deterministic enrichment pipeline.
 *
 * Given a business website it: fetches the homepage and a small, capped set of same-site
 * pages (SSRF-guarded), extracts candidate facts deterministically, optionally augments
 * them with sanitised AI candidates, assembles evidence-backed facts (with explicit
 * unknowns and conflict detection), validates and selects branding, derives scoring
 * signals and computes the deterministic score. It performs NO writes and NO provider
 * calls; persistence is the repository's job.
 */
import { buildBranding, validateImageBytes } from "./brand";
import { canonicalDomain, normalizeWebsiteInput } from "./canonical";
import { assembleFacts, type PageExtractionInput } from "./evidence";
import { extractFromHtml, type RawCandidate, type RawExtraction } from "./html-extract";
import { getAiExtractor, sanitizeAiCandidates, type AiExtractor } from "./ai-extractor";
import { safeFetch, defaultDnsLookup, type SafeFetchResult } from "./safe-fetch";
import { scoreProspect, type ScoringSignals } from "./scoring";
import { assertFetchableUrl } from "./url-safety";
import type { FactType, RawCandidateLike, ResearchResult } from "./types";

/** Default target geography for scoring (Greater Melbourne / Victoria). Configurable. */
export const DEFAULT_TARGET_GEOGRAPHY =
  /\b(vic|victoria|melbourne|richmond|cremorne|hawthorn|kew|abbotsford|collingwood|fitzroy|prahran|south yarra|st kilda|brunswick|carlton|footscray|geelong)\b/i;

/** Internal paths worth crawling, in priority order. */
const CANDIDATE_PATHS = [
  "/services",
  "/our-services",
  "/contact",
  "/contact-us",
  "/about",
  "/areas",
  "/service-areas",
  "/emergency",
];

export interface ResearchDeps {
  fetchImpl?: typeof fetch;
  dnsLookup?: (hostname: string) => Promise<string[]>;
  aiExtractor?: AiExtractor;
  /** Deterministic clock for evidence timestamps (defaults to Date.now). */
  clock?: () => string;
  /** Max same-site pages to fetch beyond the homepage (default 4). */
  maxPages?: number;
  targetGeography?: RegExp;
}

const RAW_TO_FACT: [keyof RawExtraction, FactType][] = [
  ["businessNames", "business_name"],
  ["services", "service"],
  ["serviceAreas", "service_area"],
  ["phones", "public_phone"],
  ["addresses", "address"],
  ["openingHours", "opening_hours"],
  ["emergency", "emergency_service"],
  ["positioning", "positioning"],
  ["logoUrls", "logo"],
];

function toCandidatesByType(
  extraction: RawExtraction,
): Partial<Record<FactType, RawCandidateLike[]>> {
  const out: Partial<Record<FactType, RawCandidateLike[]>> = {};
  for (const [rawKey, factType] of RAW_TO_FACT) {
    const list = extraction[rawKey] as RawCandidate[];
    if (Array.isArray(list) && list.length) {
      out[factType] = list.map((c) => ({
        value: c.value,
        context: c.context,
        strength: c.strength,
        extractor: c.extractor,
      }));
    }
  }
  return out;
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

function stripTags(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Discover a capped set of same-origin internal links to crawl. */
export function discoverInternalLinks(html: string, baseUrl: string, max: number): string[] {
  const base = new URL(baseUrl);
  const found = new Map<string, string>();
  const anchorRe = /<a\b[^>]*href\s*=\s*("([^"]*)"|'([^']*)')/gi;
  let m: RegExpExecArray | null;
  while ((m = anchorRe.exec(html)) && found.size < 40) {
    const href = (m[2] ?? m[3] ?? "").trim();
    if (!href || href.startsWith("#") || href.startsWith("mailto:") || href.startsWith("tel:"))
      continue;
    let resolved: URL;
    try {
      resolved = new URL(href, baseUrl);
    } catch {
      continue;
    }
    if (resolved.hostname.replace(/^www\./, "") !== base.hostname.replace(/^www\./, "")) continue;
    const path = resolved.pathname.toLowerCase();
    const priority = CANDIDATE_PATHS.some(
      (candidate) => path === candidate || path.startsWith(`${candidate}/`),
    )
      ? 0
      : /service|contact|about|area|emergency|hot-?water|drain|gas|plumb/.test(path)
        ? 1
        : 2;
    resolved.hash = "";
    const key = resolved.toString();
    if (!found.has(key) && priority < 2 && key !== baseUrl) found.set(key, `${priority}`);
  }
  return [...found.entries()]
    .sort((a, b) => Number(a[1]) - Number(b[1]))
    .slice(0, max)
    .map(([url]) => url);
}

export async function researchProspect(
  target: string,
  deps: ResearchDeps = {},
): Promise<ResearchResult> {
  const {
    fetchImpl = fetch,
    dnsLookup = defaultDnsLookup,
    aiExtractor = getAiExtractor(),
    clock = () => new Date().toISOString(),
    maxPages = 4,
    targetGeography = DEFAULT_TARGET_GEOGRAPHY,
  } = deps;

  const website = normalizeWebsiteInput(target);
  const domain = canonicalDomain(website);
  assertFetchableUrl(website); // reject internal/SSRF targets up-front
  const notes: string[] = [];

  const fetchPage = (url: string): Promise<SafeFetchResult> =>
    safeFetch(url, {
      fetchImpl,
      dnsLookup,
      allowedContentTypes: ["text/html", "application/xhtml+xml", "text/plain"],
    });

  // 1. Homepage.
  let websiteReachable = false;
  const pages: PageExtractionInput[] = [];
  const extractions: RawExtraction[] = [];
  let homepageHtml = "";
  let homepageFinalUrl = website;
  try {
    const home = await fetchPage(website);
    websiteReachable = true;
    homepageHtml = decode(home.bytes);
    homepageFinalUrl = home.finalUrl;
    const extraction = extractFromHtml(homepageHtml, home.finalUrl);
    extractions.push(extraction);
    pages.push({
      sourceUrl: home.finalUrl,
      retrievedAt: clock(),
      candidatesByType: toCandidatesByType(extraction),
    });
    await augmentWithAi(aiExtractor, homepageHtml, home.finalUrl, pages[pages.length - 1], notes);
  } catch (cause) {
    notes.push(`Homepage fetch failed: ${cause instanceof Error ? cause.message : String(cause)}`);
  }

  // 2. A few internal pages (same-origin, priority-ordered).
  if (homepageHtml) {
    const internalLinks = discoverInternalLinks(homepageHtml, homepageFinalUrl, maxPages);
    for (const link of internalLinks) {
      try {
        const page = await fetchPage(link);
        const html = decode(page.bytes);
        const extraction = extractFromHtml(html, page.finalUrl);
        extractions.push(extraction);
        const input: PageExtractionInput = {
          sourceUrl: page.finalUrl,
          retrievedAt: clock(),
          candidatesByType: toCandidatesByType(extraction),
        };
        await augmentWithAi(aiExtractor, html, page.finalUrl, input, notes);
        pages.push(input);
      } catch (cause) {
        notes.push(
          `Page ${link} skipped: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
      }
    }
  }

  // 3. Assemble evidence-backed facts (with explicit unknowns + conflict detection).
  const facts = assembleFacts(pages);

  // 4. Branding: validate the strongest logo candidate's bytes before trusting it.
  const logoCandidates = extractions
    .flatMap((e) => e.logoUrls)
    .sort((a, b) => b.strength - a.strength);
  const faviconCandidate =
    extractions.flatMap((e) => e.faviconUrls).sort((a, b) => b.strength - a.strength)[0] ?? null;
  let verifiedLogoUrl: string | null = null;
  for (const candidate of logoCandidates.slice(0, 3)) {
    try {
      const url = assertFetchableUrl(candidate.value).toString();
      const image = await safeFetch(url, {
        fetchImpl,
        dnsLookup,
        allowedContentTypes: ["image/"],
        maxBytes: 2 * 1024 * 1024,
      });
      const validation = validateImageBytes(image.bytes, image.contentType);
      if (validation.ok) {
        verifiedLogoUrl = image.finalUrl;
        break;
      }
      notes.push(`Logo candidate rejected (${validation.code}): ${url}`);
    } catch (cause) {
      notes.push(
        `Logo candidate unfetchable: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
  }

  const nameCandidates = extractions.flatMap((e) => e.businessNames);
  const branding = buildBranding({
    domain,
    nameCandidates,
    themeColours: extractions.flatMap((e) => e.themeColours),
    verifiedLogoUrl,
    faviconUrl:
      faviconCandidate && isFetchable(faviconCandidate.value) ? faviconCandidate.value : null,
  });

  // 5. Scoring signals.
  const existingAiReceptionist = extractions.some((e) => e.aiReceptionistSignals.length > 0);
  const geoHaystack = [
    ...facts.filter((f) => f.factType === "service_area").map((f) => f.value),
    ...facts.filter((f) => f.factType === "address").map((f) => f.value),
    stripTags(homepageHtml).slice(0, 4000),
  ].join(" ");
  const signals: ScoringSignals = {
    websiteReachable,
    existingAiReceptionist,
    inTargetGeography: targetGeography.test(geoHaystack),
  };
  const score = scoreProspect(facts, signals);

  const businessNameFact = facts.find(
    (f) => f.factType === "business_name" && f.status === "verified",
  );
  return {
    businessName: businessNameFact?.value ?? branding.displayName ?? null,
    website,
    canonicalDomain: domain,
    industry: "plumbing",
    facts,
    branding,
    score,
    notes,
  };
}

async function augmentWithAi(
  aiExtractor: AiExtractor,
  html: string,
  sourceUrl: string,
  page: PageExtractionInput,
  notes: string[],
): Promise<void> {
  if (aiExtractor.name === "null") return;
  try {
    const proposed = sanitizeAiCandidates(
      await aiExtractor.propose({
        text: stripTags(html).slice(0, 12000),
        sourceUrl,
        wanted: ["service", "service_area", "opening_hours", "emergency_service", "positioning"],
      }),
    );
    for (const [type, candidates] of Object.entries(proposed) as [FactType, RawCandidateLike[]][]) {
      const existing = page.candidatesByType[type] ?? [];
      page.candidatesByType[type] = [...existing, ...candidates];
    }
  } catch (cause) {
    notes.push(
      `AI extractor "${aiExtractor.name}" failed: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
}

function isFetchable(url: string): boolean {
  try {
    assertFetchableUrl(url);
    return true;
  } catch {
    return false;
  }
}
