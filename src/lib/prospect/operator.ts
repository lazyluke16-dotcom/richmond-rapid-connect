/**
 * Operator authorisation + privacy-minimal projection for the acquisition views.
 *
 * Mirrors the existing outreach-report operator model: an explicit allow-list of Supabase
 * user ids, configured via env, gates every prospect surface. There is no public prospect
 * directory. Aggregate/list surfaces deliberately omit contact values; the single-prospect
 * detail view may show the public business phone (which is itself public information).
 */
import type { ProspectFact, ProspectScore } from "./types";
import type { DemoRecord, ProspectRecord } from "./store";

/** Parse a comma-separated env allow-list, tolerating whitespace/blank entries. */
export function parseOperatorIds(...configured: (string | undefined)[]): string[] {
  const ids = new Set<string>();
  for (const value of configured) {
    if (!value?.trim()) continue;
    for (const id of value
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean))
      ids.add(id);
  }
  return [...ids];
}

/**
 * Whether a user id is an authorised acquisition operator. Accepts the dedicated
 * ACQUISITION_OPERATOR_USER_IDS list and also honours the existing
 * OUTREACH_OPERATOR_USER_IDS list so a single operator roster can govern both surfaces.
 */
export function isAcquisitionOperator(
  userId: string,
  env: { acquisition?: string; outreach?: string },
): boolean {
  if (!userId) return false;
  return parseOperatorIds(env.acquisition, env.outreach).includes(userId);
}

/** Privacy-minimal list row: no contact values. */
export interface OperatorProspectSummary {
  id: string;
  businessName: string | null;
  canonicalDomain: string;
  status: string;
  score: number | null;
  scoreBand: string | null;
  hasDemo: boolean;
  updatedAt: string;
}

export function toOperatorSummary(
  prospect: ProspectRecord,
  hasDemo: boolean,
): OperatorProspectSummary {
  return {
    id: prospect.id,
    businessName: prospect.businessName,
    canonicalDomain: prospect.canonicalDomain,
    status: prospect.status,
    score: prospect.score,
    scoreBand: prospect.scoreBand,
    hasDemo,
    updatedAt: prospect.updatedAt,
  };
}

export interface OperatorProspectDetail extends OperatorProspectSummary {
  website: string | null;
  industry: string;
  location: string | null;
  publicPhone: string | null;
  branding: {
    logoUrl: string | null;
    faviconUrl: string | null;
    primaryColour: string | null;
    secondaryColour: string | null;
    accentColour: string | null;
    source: string | null;
  };
  facts: ProspectFact[];
  scoreDetail: ProspectScore | null;
  demo: {
    slug: string;
    version: number;
    expiresAt: string | null;
    revokedAt: string | null;
    createdAt: string;
  } | null;
}

export function toOperatorDetail(
  prospect: ProspectRecord,
  facts: ProspectFact[],
  scoreDetail: ProspectScore | null,
  demo: DemoRecord | null,
): OperatorProspectDetail {
  return {
    ...toOperatorSummary(prospect, Boolean(demo && !demo.revokedAt)),
    website: prospect.website,
    industry: prospect.industry,
    location: prospect.location,
    publicPhone: prospect.publicPhone,
    branding: {
      logoUrl: prospect.logoUrl,
      faviconUrl: prospect.faviconUrl,
      primaryColour: prospect.primaryColour,
      secondaryColour: prospect.secondaryColour,
      accentColour: prospect.accentColour,
      source: prospect.brandSource,
    },
    facts,
    scoreDetail,
    // The token/hash is NEVER included — only non-secret demo metadata.
    demo: demo
      ? {
          slug: demo.slug,
          version: demo.version,
          expiresAt: demo.expiresAt,
          revokedAt: demo.revokedAt,
          createdAt: demo.createdAt,
        }
      : null,
  };
}
