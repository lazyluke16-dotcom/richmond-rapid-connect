/**
 * SupabaseProspectStore — the production {@link ProspectStore} adapter.
 *
 * Maps the domain model onto the service-role Supabase tables added in
 * 20260815120000_prospect_intelligence.sql. All access is via the service-role client
 * (there is no authenticated/anon RLS grant on these tables); operator authorisation is
 * enforced upstream in the route/server-function layer.
 *
 * The generated Database types do not yet include the prospect tables, so table names and
 * rows are cast following the existing repository convention (`as never` / `as unknown`).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  DemoRecord,
  NewProspect,
  ProspectEventType,
  ProspectPatch,
  ProspectRecord,
  ProspectStore,
} from "./store";
import type { DemoConfig, ProspectFact, ProspectScore, ProspectStatus } from "./types";

interface ProspectRow {
  id: string;
  status: ProspectStatus;
  business_name: string | null;
  website: string | null;
  canonical_domain: string;
  industry: string;
  location: string | null;
  public_phone: string | null;
  logo_url: string | null;
  favicon_url: string | null;
  primary_colour: string | null;
  secondary_colour: string | null;
  accent_colour: string | null;
  brand_source: string | null;
  score: number | null;
  score_band: string | null;
  outreach_authority: "none";
  created_at: string;
  updated_at: string;
}

interface FactRow {
  fact_type: ProspectFact["factType"];
  value: string;
  normalized_value: string;
  status: ProspectFact["status"];
  confidence: number;
  source_url: string | null;
  observed_context: string | null;
  extractor: ProspectFact["extractor"];
  retrieved_at: string;
}

interface DemoRow {
  id: string;
  prospect_id: string;
  version: number;
  slug: string;
  token_hash: string;
  config: DemoConfig;
  expires_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

function mapProspect(row: ProspectRow): ProspectRecord {
  return {
    id: row.id,
    status: row.status,
    businessName: row.business_name,
    website: row.website,
    canonicalDomain: row.canonical_domain,
    industry: row.industry,
    location: row.location,
    publicPhone: row.public_phone,
    logoUrl: row.logo_url,
    faviconUrl: row.favicon_url,
    primaryColour: row.primary_colour,
    secondaryColour: row.secondary_colour,
    accentColour: row.accent_colour,
    brandSource: row.brand_source,
    score: row.score,
    scoreBand: row.score_band,
    outreachAuthority: "none",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapDemo(row: DemoRow): DemoRecord {
  return {
    id: row.id,
    prospectId: row.prospect_id,
    version: row.version,
    slug: row.slug,
    tokenHash: row.token_hash,
    config: row.config,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = SupabaseClient<any, any, any>;

export class SupabaseProspectStore implements ProspectStore {
  constructor(private readonly db: Db) {}

  private table(name: string) {
    return this.db.from(name as never);
  }

  async findByDomain(canonicalDomain: string): Promise<ProspectRecord | null> {
    const { data, error } = await this.table("prospects")
      .select("*")
      .eq("canonical_domain", canonicalDomain)
      .maybeSingle();
    if (error) throw new Error(`prospect lookup failed: ${error.message}`);
    return data ? mapProspect(data as unknown as ProspectRow) : null;
  }

  async getById(id: string): Promise<ProspectRecord | null> {
    const { data, error } = await this.table("prospects").select("*").eq("id", id).maybeSingle();
    if (error) throw new Error(`prospect lookup failed: ${error.message}`);
    return data ? mapProspect(data as unknown as ProspectRow) : null;
  }

  async create(input: NewProspect): Promise<ProspectRecord> {
    const { data, error } = await this.table("prospects")
      .insert({
        canonical_domain: input.canonicalDomain,
        website: input.website,
        business_name: input.businessName,
        industry: input.industry,
        status: "discovered",
      } as never)
      .select("*")
      .single();
    if (error) throw new Error(`prospect create failed: ${error.message}`);
    return mapProspect(data as unknown as ProspectRow);
  }

  async update(id: string, patch: ProspectPatch): Promise<ProspectRecord> {
    const row: Record<string, unknown> = {};
    const set = (key: string, value: unknown) => {
      if (value !== undefined) row[key] = value;
    };
    set("status", patch.status);
    set("business_name", patch.businessName);
    set("website", patch.website);
    set("location", patch.location);
    set("public_phone", patch.publicPhone);
    set("logo_url", patch.logoUrl);
    set("favicon_url", patch.faviconUrl);
    set("primary_colour", patch.primaryColour);
    set("secondary_colour", patch.secondaryColour);
    set("accent_colour", patch.accentColour);
    set("brand_source", patch.brandSource);
    set("score", patch.score);
    set("score_band", patch.scoreBand);
    set("research_started_at", patch.researchStartedAt);
    set("enriched_at", patch.enrichedAt);
    set("demo_built_at", patch.demoBuiltAt);
    set("last_research_at", patch.lastResearchAt);
    const { data, error } = await this.table("prospects")
      .update(row as never)
      .eq("id", id)
      .select("*")
      .single();
    if (error) throw new Error(`prospect update failed: ${error.message}`);
    return mapProspect(data as unknown as ProspectRow);
  }

  async replaceFacts(prospectId: string, facts: ProspectFact[]): Promise<void> {
    const del = await this.table("prospect_facts").delete().eq("prospect_id", prospectId);
    if (del.error) throw new Error(`fact clear failed: ${del.error.message}`);
    if (facts.length === 0) return;
    const rows = facts.map((fact) => ({
      prospect_id: prospectId,
      fact_type: fact.factType,
      value: fact.value,
      normalized_value: fact.normalizedValue,
      status: fact.status,
      confidence: fact.confidence,
      source_url: fact.evidence?.sourceUrl ?? null,
      observed_context: fact.evidence?.observedContext ?? null,
      extractor: fact.extractor,
      retrieved_at: fact.evidence?.retrievedAt ?? new Date().toISOString(),
    }));
    const ins = await this.table("prospect_facts").insert(rows as never);
    if (ins.error) throw new Error(`fact insert failed: ${ins.error.message}`);
  }

  async listFacts(prospectId: string): Promise<ProspectFact[]> {
    const { data, error } = await this.table("prospect_facts")
      .select("*")
      .eq("prospect_id", prospectId);
    if (error) throw new Error(`fact list failed: ${error.message}`);
    return ((data ?? []) as unknown as FactRow[]).map((row) => ({
      factType: row.fact_type,
      value: row.value,
      normalizedValue: row.normalized_value,
      status: row.status,
      confidence: Number(row.confidence),
      extractor: row.extractor,
      evidence: row.source_url
        ? {
            sourceUrl: row.source_url,
            observedContext: row.observed_context ?? "",
            retrievedAt: row.retrieved_at,
            confidence: Number(row.confidence),
          }
        : null,
    }));
  }

  async upsertScore(prospectId: string, score: ProspectScore): Promise<void> {
    const { error } = await this.table("prospect_scores").upsert(
      {
        prospect_id: prospectId,
        score: score.score,
        band: score.band,
        factors: score.factors,
        engine_version: score.engineVersion,
        computed_at: new Date().toISOString(),
      } as never,
      { onConflict: "prospect_id" } as never,
    );
    if (error) throw new Error(`score upsert failed: ${error.message}`);
  }

  async getScore(prospectId: string): Promise<ProspectScore | null> {
    const { data, error } = await this.table("prospect_scores")
      .select("*")
      .eq("prospect_id", prospectId)
      .maybeSingle();
    if (error) throw new Error(`score lookup failed: ${error.message}`);
    if (!data) return null;
    const row = data as unknown as {
      score: number;
      band: ProspectScore["band"];
      factors: ProspectScore["factors"];
      engine_version: string;
    };
    return {
      score: row.score,
      band: row.band,
      factors: row.factors ?? [],
      engineVersion: row.engine_version,
    };
  }

  async addEvent(
    prospectId: string,
    type: ProspectEventType,
    detail: Record<string, unknown>,
  ): Promise<void> {
    const { error } = await this.table("prospect_events").insert({
      prospect_id: prospectId,
      event_type: type,
      detail,
    } as never);
    if (error) throw new Error(`event insert failed: ${error.message}`);
  }

  async listEvents(prospectId: string) {
    const { data, error } = await this.table("prospect_events")
      .select("event_type,detail,created_at")
      .eq("prospect_id", prospectId)
      .order("created_at", { ascending: false });
    if (error) throw new Error(`event list failed: ${error.message}`);
    return (
      (data ?? []) as unknown as {
        event_type: ProspectEventType;
        detail: Record<string, unknown>;
        created_at: string;
      }[]
    ).map((row) => ({ type: row.event_type, detail: row.detail ?? {}, createdAt: row.created_at }));
  }

  async insertDemo(demo: Omit<DemoRecord, "createdAt">): Promise<DemoRecord> {
    const { data, error } = await this.table("prospect_demo_configs")
      .insert({
        id: demo.id,
        prospect_id: demo.prospectId,
        version: demo.version,
        slug: demo.slug,
        token_hash: demo.tokenHash,
        config: demo.config,
        expires_at: demo.expiresAt,
        revoked_at: demo.revokedAt,
      } as never)
      .select("*")
      .single();
    if (error) throw new Error(`demo insert failed: ${error.message}`);
    return mapDemo(data as unknown as DemoRow);
  }

  async latestDemo(prospectId: string): Promise<DemoRecord | null> {
    const { data, error } = await this.table("prospect_demo_configs")
      .select("*")
      .eq("prospect_id", prospectId)
      .order("version", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(`demo lookup failed: ${error.message}`);
    return data ? mapDemo(data as unknown as DemoRow) : null;
  }

  async listDemos(prospectId: string): Promise<DemoRecord[]> {
    const { data, error } = await this.table("prospect_demo_configs")
      .select("*")
      .eq("prospect_id", prospectId)
      .order("version", { ascending: false });
    if (error) throw new Error(`demo list failed: ${error.message}`);
    return ((data ?? []) as unknown as DemoRow[]).map(mapDemo);
  }

  async findDemoBySlug(slug: string): Promise<DemoRecord | null> {
    const { data, error } = await this.table("prospect_demo_configs")
      .select("*")
      .eq("slug", slug)
      .maybeSingle();
    if (error) throw new Error(`demo lookup failed: ${error.message}`);
    return data ? mapDemo(data as unknown as DemoRow) : null;
  }

  async revokeDemo(demoId: string, revokedAt: string): Promise<void> {
    const { error } = await this.table("prospect_demo_configs")
      .update({ revoked_at: revokedAt } as never)
      .eq("id", demoId);
    if (error) throw new Error(`demo revoke failed: ${error.message}`);
  }

  async list(
    options: { limit?: number; band?: string; status?: ProspectStatus } = {},
  ): Promise<ProspectRecord[]> {
    let query = this.table("prospects")
      .select("*")
      .order("score", { ascending: false, nullsFirst: false });
    if (options.band) query = query.eq("score_band", options.band);
    if (options.status) query = query.eq("status", options.status);
    query = query.limit(options.limit ?? 100);
    const { data, error } = await query;
    if (error) throw new Error(`prospect list failed: ${error.message}`);
    return ((data ?? []) as unknown as ProspectRow[]).map(mapProspect);
  }
}

/** Build a store from a service-role Supabase client (e.g. supabaseAdmin). */
export function createSupabaseProspectStore(client: unknown): SupabaseProspectStore {
  return new SupabaseProspectStore(client as Db);
}
