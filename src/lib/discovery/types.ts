/**
 * Autonomous Acquisition V1 — Slice 2 (Autonomous Prospect Discovery) shared types.
 *
 * Discovery is deterministic application infrastructure with bounded provider adapters.
 * Application/database state is authoritative. Slice 2 sends NO outreach and creates NO
 * paid provider resources; it discovers, deduplicates, qualifies and feeds accepted
 * businesses into the approved Slice-1 research + demo pipeline, stopping at DEMO_READY.
 * See docs/AUTONOMOUS_DISCOVERY_V1.md.
 */

export type MissionStatus =
  "draft" | "approved" | "running" | "paused" | "completed" | "failed" | "cancelled";

export type CandidateDisposition =
  "discovered" | "duplicate" | "rejected" | "accepted" | "demo_ready" | "failed";

/** Explainable disposition reason codes (never an opaque LLM yes/no). */
export type CandidateReason =
  | "accepted"
  | "demo_built"
  | "duplicate_in_mission"
  | "duplicate_domain"
  | "duplicate_provider_id"
  | "duplicate_phone"
  | "duplicate_name_locality"
  | "existing_prospect"
  | "not_target_vertical"
  | "outside_geography"
  | "no_website"
  | "unsafe_url"
  | "insufficient_identity"
  | "non_business"
  | "research_failed";

export interface MissionCounts {
  discovered: number;
  accepted: number;
  duplicate: number;
  rejected: number;
  failed: number;
  demoReady: number;
}

export interface DiscoveryMissionRecord {
  id: string;
  status: MissionStatus;
  vertical: string;
  geography: string;
  geoTerms: string[];
  targetCount: number;
  maxCandidates: number;
  sources: string[];
  cursor: Record<string, unknown>;
  costCents: number;
  costCeilingCents: number | null;
  retryCount: number;
  maxRetries: number;
  counts: MissionCounts;
  lastError: string | null;
  createdBy: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
}

export interface NewMissionInput {
  vertical: string;
  geography: string;
  geoTerms: string[];
  targetCount: number;
  maxCandidates: number;
  sources: string[];
  costCeilingCents: number | null;
  maxRetries: number;
  createdBy: string | null;
  /** Operator-curated seed for the 'import' source (real businesses they may process). */
  importSeed: RawDiscoveryCandidate[];
}

/** Raw candidate as returned by a provider adapter (before normalisation). */
export interface RawDiscoveryCandidate {
  source: string;
  providerBusinessId?: string | null;
  sourceUrl?: string | null;
  businessName?: string | null;
  website?: string | null;
  publicPhone?: string | null;
  locality?: string | null;
  /** Optional signal that the listing is a plumbing business (else inferred). */
  vertical?: string | null;
}

/** Normalised candidate with the derived deduplication key + canonical fields. */
export interface NormalizedCandidate {
  source: string;
  providerBusinessId: string | null;
  sourceUrl: string | null;
  businessName: string | null;
  website: string | null;
  canonicalDomain: string | null;
  publicPhone: string | null;
  locality: string | null;
  vertical: string | null;
  dedupKey: string;
}

export interface DiscoveryCandidateRecord {
  id: string;
  missionId: string;
  source: string;
  providerBusinessId: string | null;
  sourceUrl: string | null;
  businessName: string | null;
  website: string | null;
  canonicalDomain: string | null;
  publicPhone: string | null;
  locality: string | null;
  discoveryQuery: string | null;
  dedupKey: string;
  disposition: CandidateDisposition;
  duplicateOf: string | null;
  reason: CandidateReason | null;
  acceptedProspectId: string | null;
  rawHash: string | null;
  /** Expiry for temporarily-cacheable provider-derived display content (e.g. Google). */
  providerContentExpiresAt: string | null;
  discoveredAt: string;
  createdAt: string;
  updatedAt: string;
}

export type MissionEventType =
  | "created"
  | "approved"
  | "started"
  | "paused"
  | "resumed"
  | "cancelled"
  | "page_fetched"
  | "page_failed"
  | "candidate_processed"
  | "completed"
  | "failed";
