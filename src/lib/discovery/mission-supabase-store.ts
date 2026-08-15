/**
 * SupabaseMissionStore — production {@link MissionStore} adapter.
 *
 * Maps the discovery domain onto the service-role tables from
 * 20260815140000_autonomous_discovery.sql. `claimCandidate` relies on the
 * (mission_id, dedup_key) UNIQUE constraint: on a duplicate-key insert it returns the
 * already-claimed row with `claimed: false`, giving concurrency-safe candidate claiming.
 * Table names/rows are cast following the existing repository convention.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { identityNameLocality } from "./mission-store";
import type {
  CandidatePatch,
  ClaimCandidateInput,
  ClaimResult,
  MissionPatch,
  MissionStore,
} from "./mission-store";
import type { CandidateIdentityEntry } from "./dedup";
import type {
  CandidateDisposition,
  DiscoveryCandidateRecord,
  DiscoveryMissionRecord,
  MissionCounts,
  MissionEventType,
  NewMissionInput,
  RawDiscoveryCandidate,
} from "./types";

// Explicit column list keeps the bounded-but-potentially-large import_seed jsonb out of the
// hot getMission/listMissions path; it is fetched separately by getImportSeed only when a
// mission actually runs.
const MISSION_COLUMNS =
  "id,status,vertical,geography,geo_terms,target_count,max_candidates,sources,cursor," +
  "cost_cents,cost_ceiling_cents,retry_count,max_retries,discovered_count,accepted_count," +
  "duplicate_count,rejected_count,failed_count,demo_ready_count,last_error,created_by," +
  "created_at,started_at,completed_at,updated_at";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = SupabaseClient<any, any, any>;

interface MissionRow {
  id: string;
  status: DiscoveryMissionRecord["status"];
  vertical: string;
  geography: string;
  geo_terms: string[];
  target_count: number;
  max_candidates: number;
  sources: string[];
  cursor: Record<string, unknown>;
  cost_cents: number;
  cost_ceiling_cents: number | null;
  retry_count: number;
  max_retries: number;
  discovered_count: number;
  accepted_count: number;
  duplicate_count: number;
  rejected_count: number;
  failed_count: number;
  demo_ready_count: number;
  last_error: string | null;
  created_by: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  updated_at: string;
}

interface CandidateRow {
  id: string;
  mission_id: string;
  source: string;
  provider_business_id: string | null;
  source_url: string | null;
  business_name: string | null;
  website: string | null;
  canonical_domain: string | null;
  public_phone: string | null;
  locality: string | null;
  discovery_query: string | null;
  dedup_key: string;
  disposition: CandidateDisposition;
  duplicate_of: string | null;
  reason: string | null;
  accepted_prospect_id: string | null;
  raw_hash: string | null;
  provider_content_expires_at: string | null;
  discovered_at: string;
  created_at: string;
  updated_at: string;
}

function mapMission(row: MissionRow): DiscoveryMissionRecord {
  return {
    id: row.id,
    status: row.status,
    vertical: row.vertical,
    geography: row.geography,
    geoTerms: row.geo_terms ?? [],
    targetCount: row.target_count,
    maxCandidates: row.max_candidates,
    sources: row.sources ?? [],
    cursor: row.cursor ?? {},
    costCents: row.cost_cents,
    costCeilingCents: row.cost_ceiling_cents,
    retryCount: row.retry_count,
    maxRetries: row.max_retries,
    counts: {
      discovered: row.discovered_count,
      accepted: row.accepted_count,
      duplicate: row.duplicate_count,
      rejected: row.rejected_count,
      failed: row.failed_count,
      demoReady: row.demo_ready_count,
    },
    lastError: row.last_error,
    createdBy: row.created_by,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    updatedAt: row.updated_at,
  };
}

function mapCandidate(row: CandidateRow): DiscoveryCandidateRecord {
  return {
    id: row.id,
    missionId: row.mission_id,
    source: row.source,
    providerBusinessId: row.provider_business_id,
    sourceUrl: row.source_url,
    businessName: row.business_name,
    website: row.website,
    canonicalDomain: row.canonical_domain,
    publicPhone: row.public_phone,
    locality: row.locality,
    discoveryQuery: row.discovery_query,
    dedupKey: row.dedup_key,
    disposition: row.disposition,
    duplicateOf: row.duplicate_of,
    reason: (row.reason as DiscoveryCandidateRecord["reason"]) ?? null,
    acceptedProspectId: row.accepted_prospect_id,
    rawHash: row.raw_hash,
    providerContentExpiresAt: row.provider_content_expires_at,
    discoveredAt: row.discovered_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class SupabaseMissionStore implements MissionStore {
  constructor(private readonly db: Db) {}

  private table(name: string) {
    return this.db.from(name as never);
  }

  async createMission(input: NewMissionInput): Promise<DiscoveryMissionRecord> {
    const { data, error } = await this.table("discovery_missions")
      .insert({
        vertical: input.vertical,
        geography: input.geography,
        geo_terms: input.geoTerms,
        target_count: input.targetCount,
        max_candidates: input.maxCandidates,
        sources: input.sources,
        cost_ceiling_cents: input.costCeilingCents,
        max_retries: input.maxRetries,
        created_by: input.createdBy,
        import_seed: input.importSeed ?? [],
        status: "draft",
      } as never)
      .select(MISSION_COLUMNS)
      .single();
    if (error) throw new Error(`mission create failed: ${error.message}`);
    return mapMission(data as unknown as MissionRow);
  }

  async getMission(id: string): Promise<DiscoveryMissionRecord | null> {
    const { data, error } = await this.table("discovery_missions")
      .select(MISSION_COLUMNS)
      .eq("id", id)
      .maybeSingle();
    if (error) throw new Error(`mission lookup failed: ${error.message}`);
    return data ? mapMission(data as unknown as MissionRow) : null;
  }

  async getImportSeed(missionId: string): Promise<RawDiscoveryCandidate[]> {
    const { data, error } = await this.table("discovery_missions")
      .select("import_seed")
      .eq("id", missionId)
      .maybeSingle();
    if (error) throw new Error(`import seed lookup failed: ${error.message}`);
    const seed = (data as { import_seed?: RawDiscoveryCandidate[] } | null)?.import_seed;
    return Array.isArray(seed) ? seed : [];
  }

  async updateMission(id: string, patch: MissionPatch): Promise<DiscoveryMissionRecord> {
    const row: Record<string, unknown> = {};
    const set = (key: string, value: unknown) => {
      if (value !== undefined) row[key] = value;
    };
    set("status", patch.status);
    set("cursor", patch.cursor);
    set("cost_cents", patch.costCents);
    set("retry_count", patch.retryCount);
    set("last_error", patch.lastError);
    set("started_at", patch.startedAt);
    set("completed_at", patch.completedAt);
    if (patch.counts) {
      row.discovered_count = patch.counts.discovered;
      row.accepted_count = patch.counts.accepted;
      row.duplicate_count = patch.counts.duplicate;
      row.rejected_count = patch.counts.rejected;
      row.failed_count = patch.counts.failed;
      row.demo_ready_count = patch.counts.demoReady;
    }
    const { data, error } = await this.table("discovery_missions")
      .update(row as never)
      .eq("id", id)
      .select(MISSION_COLUMNS)
      .single();
    if (error) throw new Error(`mission update failed: ${error.message}`);
    return mapMission(data as unknown as MissionRow);
  }

  async listMissions(limit = 100): Promise<DiscoveryMissionRecord[]> {
    const { data, error } = await this.table("discovery_missions")
      .select(MISSION_COLUMNS)
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error) throw new Error(`mission list failed: ${error.message}`);
    return ((data ?? []) as unknown as MissionRow[]).map(mapMission);
  }

  async claimCandidate(input: ClaimCandidateInput): Promise<ClaimResult> {
    const n = input.normalized;
    const redact = input.redactProviderContent === true;
    const insert = await this.table("discovery_candidates")
      .insert({
        mission_id: input.missionId,
        source: n.source,
        provider_business_id: n.providerBusinessId,
        // Provider display content is not persisted when redacted (e.g. Google Maps Content):
        // only the durable Place ID + website + derived domain are stored.
        source_url: redact ? null : n.sourceUrl,
        business_name: redact ? null : n.businessName,
        website: n.website,
        canonical_domain: n.canonicalDomain,
        public_phone: redact ? null : n.publicPhone,
        locality: redact ? null : n.locality,
        discovery_query: input.discoveryQuery,
        dedup_key: n.dedupKey,
        raw_hash: input.rawHash,
        provider_content_expires_at: input.providerContentExpiresAt ?? null,
        disposition: "discovered",
      } as never)
      .select("*")
      .single();
    if (!insert.error) {
      return { record: mapCandidate(insert.data as unknown as CandidateRow), claimed: true };
    }
    // Unique (mission_id, dedup_key) violation → another worker already claimed it.
    if ((insert.error as { code?: string }).code === "23505") {
      const { data, error } = await this.table("discovery_candidates")
        .select("*")
        .eq("mission_id", input.missionId)
        .eq("dedup_key", n.dedupKey)
        .maybeSingle();
      if (error || !data)
        throw new Error(`candidate claim reconcile failed: ${error?.message ?? "missing row"}`);
      return { record: mapCandidate(data as unknown as CandidateRow), claimed: false };
    }
    throw new Error(`candidate claim failed: ${insert.error.message}`);
  }

  async updateCandidate(id: string, patch: CandidatePatch): Promise<void> {
    const row: Record<string, unknown> = {};
    const set = (key: string, value: unknown) => {
      if (value !== undefined) row[key] = value;
    };
    set("disposition", patch.disposition);
    set("reason", patch.reason);
    set("duplicate_of", patch.duplicateOf);
    set("accepted_prospect_id", patch.acceptedProspectId);
    set("raw_hash", patch.rawHash);
    const { error } = await this.table("discovery_candidates")
      .update(row as never)
      .eq("id", id);
    if (error) throw new Error(`candidate update failed: ${error.message}`);
  }

  async listCandidateIdentities(missionId: string): Promise<CandidateIdentityEntry[]> {
    const { data, error } = await this.table("discovery_candidates")
      .select("id,source,provider_business_id,canonical_domain,public_phone,business_name,locality")
      .eq("mission_id", missionId);
    if (error) throw new Error(`identity list failed: ${error.message}`);
    return (
      (data ?? []) as unknown as {
        id: string;
        source: string;
        provider_business_id: string | null;
        canonical_domain: string | null;
        public_phone: string | null;
        business_name: string | null;
        locality: string | null;
      }[]
    ).map((row) => ({
      id: row.id,
      domain: row.canonical_domain,
      providerKey: row.provider_business_id ? `${row.source}:${row.provider_business_id}` : null,
      phone: row.public_phone,
      nameLocality: identityNameLocality(row.business_name, row.locality),
    }));
  }

  async listCandidates(
    missionId: string,
    options: { disposition?: CandidateDisposition; limit?: number } = {},
  ): Promise<DiscoveryCandidateRecord[]> {
    let query = this.table("discovery_candidates")
      .select("*")
      .eq("mission_id", missionId)
      .order("discovered_at", { ascending: true });
    if (options.disposition) query = query.eq("disposition", options.disposition);
    if (options.limit) query = query.limit(options.limit);
    const { data, error } = await query;
    if (error) throw new Error(`candidate list failed: ${error.message}`);
    return ((data ?? []) as unknown as CandidateRow[]).map(mapCandidate);
  }

  async countByDisposition(missionId: string): Promise<MissionCounts> {
    const { data, error } = await this.table("discovery_candidates")
      .select("disposition")
      .eq("mission_id", missionId);
    if (error) throw new Error(`count failed: ${error.message}`);
    const counts: MissionCounts = {
      discovered: 0,
      accepted: 0,
      duplicate: 0,
      rejected: 0,
      failed: 0,
      demoReady: 0,
    };
    for (const row of (data ?? []) as unknown as { disposition: CandidateDisposition }[]) {
      counts.discovered += 1;
      if (row.disposition === "accepted") counts.accepted += 1;
      else if (row.disposition === "duplicate") counts.duplicate += 1;
      else if (row.disposition === "rejected") counts.rejected += 1;
      else if (row.disposition === "failed") counts.failed += 1;
      else if (row.disposition === "demo_ready") {
        counts.accepted += 1;
        counts.demoReady += 1;
      }
    }
    return counts;
  }

  async addMissionEvent(
    missionId: string,
    type: MissionEventType,
    detail: Record<string, unknown>,
  ): Promise<void> {
    const { error } = await this.table("discovery_mission_events").insert({
      mission_id: missionId,
      event_type: type,
      detail,
    } as never);
    if (error) throw new Error(`mission event insert failed: ${error.message}`);
  }

  async listMissionEvents(missionId: string) {
    const { data, error } = await this.table("discovery_mission_events")
      .select("event_type,detail,created_at")
      .eq("mission_id", missionId)
      .order("created_at", { ascending: false });
    if (error) throw new Error(`mission event list failed: ${error.message}`);
    return (
      (data ?? []) as unknown as {
        event_type: MissionEventType;
        detail: Record<string, unknown>;
        created_at: string;
      }[]
    ).map((row) => ({ type: row.event_type, detail: row.detail ?? {}, createdAt: row.created_at }));
  }

  async acquireLease(
    missionId: string,
    token: string,
    nowIso: string,
    ttlMs: number,
  ): Promise<boolean> {
    const expiresAt = new Date(Date.parse(nowIso) + ttlMs).toISOString();
    // Atomic conditional acquire: the row is only updated when no live lease is held. Postgres
    // row-locks the UPDATE, so exactly one concurrent worker can succeed.
    const { data, error } = await this.table("discovery_missions")
      .update({ lease_token: token, lease_expires_at: expiresAt } as never)
      .eq("id", missionId)
      .or(`lease_expires_at.is.null,lease_expires_at.lt.${nowIso}`)
      .select("id");
    if (error) throw new Error(`lease acquire failed: ${error.message}`);
    return Array.isArray(data) && data.length > 0;
  }

  async renewLease(
    missionId: string,
    token: string,
    nowIso: string,
    ttlMs: number,
  ): Promise<boolean> {
    const expiresAt = new Date(Date.parse(nowIso) + ttlMs).toISOString();
    // Extend the lease only while THIS token still holds it.
    const { data, error } = await this.table("discovery_missions")
      .update({ lease_expires_at: expiresAt } as never)
      .eq("id", missionId)
      .eq("lease_token", token)
      .select("id");
    if (error) throw new Error(`lease renew failed: ${error.message}`);
    return Array.isArray(data) && data.length > 0;
  }

  async releaseLease(missionId: string, token: string): Promise<void> {
    const { error } = await this.table("discovery_missions")
      .update({ lease_token: null, lease_expires_at: null } as never)
      .eq("id", missionId)
      .eq("lease_token", token);
    if (error) throw new Error(`lease release failed: ${error.message}`);
  }

  async purgeExpiredProviderContent(nowIso: string): Promise<number> {
    const { data, error } = await this.table("discovery_candidates")
      .update({
        business_name: null,
        locality: null,
        source_url: null,
        provider_content_expires_at: null,
      } as never)
      .not("provider_content_expires_at", "is", null)
      .lte("provider_content_expires_at", nowIso)
      .select("id");
    if (error) throw new Error(`provider content purge failed: ${error.message}`);
    return Array.isArray(data) ? data.length : 0;
  }
}

export function createSupabaseMissionStore(client: unknown): SupabaseMissionStore {
  return new SupabaseMissionStore(client as Db);
}
