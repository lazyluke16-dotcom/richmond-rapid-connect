/**
 * Operator-facing projections for discovery missions.
 *
 * Reuses the Slice-1 acquisition operator allow-list. Surfaces mission progress, disposition
 * counts and explainable candidate outcomes. No public discovery interface exists; these
 * shapes are only ever returned to an authorised operator.
 */
import { isFetchableUrl } from "../prospect/url-safety";
import type {
  DiscoveryCandidateRecord,
  DiscoveryMissionRecord,
  RawDiscoveryCandidate,
} from "./types";

export interface MissionSummary {
  id: string;
  status: string;
  vertical: string;
  geography: string;
  targetCount: number;
  maxCandidates: number;
  sources: string[];
  counts: DiscoveryMissionRecord["counts"];
  costCents: number;
  createdAt: string;
  updatedAt: string;
}

export function toMissionSummary(mission: DiscoveryMissionRecord): MissionSummary {
  return {
    id: mission.id,
    status: mission.status,
    vertical: mission.vertical,
    geography: mission.geography,
    targetCount: mission.targetCount,
    maxCandidates: mission.maxCandidates,
    sources: mission.sources,
    counts: mission.counts,
    costCents: mission.costCents,
    createdAt: mission.createdAt,
    updatedAt: mission.updatedAt,
  };
}

export interface CandidateView {
  id: string;
  businessName: string | null;
  canonicalDomain: string | null;
  locality: string | null;
  source: string;
  disposition: string;
  reason: string | null;
  acceptedProspectId: string | null;
}

/** Candidate row without contact values beyond public business identity. */
export function toCandidateView(candidate: DiscoveryCandidateRecord): CandidateView {
  return {
    id: candidate.id,
    businessName: candidate.businessName,
    canonicalDomain: candidate.canonicalDomain,
    locality: candidate.locality,
    source: candidate.source,
    disposition: candidate.disposition,
    reason: candidate.reason,
    acceptedProspectId: candidate.acceptedProspectId,
  };
}

export interface MissionDetail extends MissionSummary {
  geoTerms: string[];
  costCeilingCents: number | null;
  retryCount: number;
  maxRetries: number;
  lastError: string | null;
  startedAt: string | null;
  completedAt: string | null;
  candidates: CandidateView[];
}

export function toMissionDetail(
  mission: DiscoveryMissionRecord,
  candidates: DiscoveryCandidateRecord[],
): MissionDetail {
  return {
    ...toMissionSummary(mission),
    geoTerms: mission.geoTerms,
    costCeilingCents: mission.costCeilingCents,
    retryCount: mission.retryCount,
    maxRetries: mission.maxRetries,
    lastError: mission.lastError,
    startedAt: mission.startedAt,
    completedAt: mission.completedAt,
    candidates: candidates.map(toCandidateView),
  };
}

/** Parse + validate operator mission-creation input into a NewMissionInput-friendly shape. */
export interface MissionCreateRequest {
  vertical?: unknown;
  geography?: unknown;
  targetCount?: unknown;
  maxCandidates?: unknown;
  sources?: unknown;
  costCeilingCents?: unknown;
  geoTerms?: unknown;
  importCandidates?: unknown;
}

export interface ParsedMissionCreate {
  vertical: string;
  geography: string;
  geoTerms: string[];
  targetCount: number;
  maxCandidates: number;
  sources: string[];
  costCeilingCents: number | null;
  maxRetries: number;
  importSeed: RawDiscoveryCandidate[];
}

/** The only operator-selectable source in V1 (no lawful live provider is wired). */
const ALLOWED_SOURCES = new Set(["import"]);
const MAX_IMPORT_SEED = 1000;

function parseImportCandidates(raw: unknown): RawDiscoveryCandidate[] {
  if (!Array.isArray(raw)) return [];
  const seed: RawDiscoveryCandidate[] = [];
  for (const item of raw.slice(0, MAX_IMPORT_SEED)) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const website = typeof record.website === "string" ? record.website.trim() : null;
    const businessName =
      typeof record.businessName === "string" ? record.businessName.trim() : null;
    // Require at least a name or a website; drop obviously unusable entries early.
    if (!website && !businessName) continue;
    seed.push({
      source: "import",
      providerBusinessId:
        typeof record.providerBusinessId === "string"
          ? record.providerBusinessId.slice(0, 200)
          : null,
      sourceUrl:
        typeof record.sourceUrl === "string" && /^https?:\/\//i.test(record.sourceUrl)
          ? record.sourceUrl
          : null,
      businessName: businessName ? businessName.slice(0, 200) : null,
      website: website ? website.slice(0, 2000) : null,
      publicPhone: typeof record.publicPhone === "string" ? record.publicPhone.slice(0, 40) : null,
      locality: typeof record.locality === "string" ? record.locality.slice(0, 200) : null,
      vertical: typeof record.vertical === "string" ? record.vertical.slice(0, 80) : null,
    });
  }
  return seed;
}

export function parseMissionCreate(body: MissionCreateRequest): ParsedMissionCreate {
  const geography = typeof body.geography === "string" ? body.geography.trim() : "";
  if (geography.length < 2 || geography.length > 200)
    throw new Error("geography is required (2-200 chars)");

  const vertical =
    typeof body.vertical === "string" && body.vertical.trim() ? body.vertical.trim() : "plumbing";

  const targetCount = Number(body.targetCount);
  if (!Number.isInteger(targetCount) || targetCount < 1 || targetCount > 1000) {
    throw new Error("targetCount must be an integer 1-1000");
  }
  const requestedMax = body.maxCandidates == null ? targetCount * 5 : Number(body.maxCandidates);
  const maxCandidates = Math.min(
    5000,
    Math.max(targetCount, Math.trunc(requestedMax) || targetCount),
  );

  // 'import' is the only operator-selectable source in V1 (no lawful live provider is wired).
  const sources =
    Array.isArray(body.sources) && body.sources.length > 0
      ? body.sources.map((s) => String(s)).filter((s) => ALLOWED_SOURCES.has(s))
      : ["import"];
  if (sources.length === 0) throw new Error("no approved discovery source selected");

  // Geo terms: explicit, else derive from the geography label (comma/space separated words).
  const geoTerms = Array.isArray(body.geoTerms)
    ? body.geoTerms.map((t) => String(t).toLowerCase().trim()).filter(Boolean)
    : geography
        .toLowerCase()
        .split(/[,/]/)
        .map((t) => t.replace(/\b(vic|nsw|qld|sa|wa|tas|nt|act|greater|area|region)\b/g, "").trim())
        .filter((t) => t.length >= 3);

  const costCeilingCents =
    body.costCeilingCents == null
      ? null
      : Math.max(0, Math.trunc(Number(body.costCeilingCents)) || 0);

  const importSeed = parseImportCandidates(body.importCandidates);
  // The 'import' source requires an operator-supplied business list to process.
  if (sources.includes("import") && importSeed.length === 0) {
    throw new Error(
      "the import source requires importCandidates (a list of businesses to process)",
    );
  }
  // Reject an import list whose websites are all unsafe/unfetchable up-front (defense in depth;
  // the qualifier + Slice-1 SSRF gate also enforce this per candidate).
  const anyUsable = importSeed.some(
    (c) => c.businessName || (c.website && isFetchableUrl(c.website)),
  );
  if (importSeed.length > 0 && !anyUsable) {
    throw new Error("importCandidates contains no usable business (safe website or name required)");
  }

  return {
    vertical,
    geography,
    geoTerms,
    targetCount,
    maxCandidates,
    sources,
    costCeilingCents,
    maxRetries: 3,
    importSeed,
  };
}
