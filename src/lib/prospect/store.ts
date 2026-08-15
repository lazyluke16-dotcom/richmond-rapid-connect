/**
 * Prospect persistence abstraction.
 *
 * The domain services depend on this narrow {@link ProspectStore} interface rather than
 * on Supabase directly, which keeps them exhaustively unit-testable via
 * {@link InMemoryProspectStore} and keeps all SQL/RLS concerns in one adapter
 * (supabase-store.ts). All access is service-role; there is no per-tenant scoping because
 * prospects are not tenants.
 */
import type { DemoConfig, ProspectFact, ProspectScore, ProspectStatus } from "./types";

export interface ProspectRecord {
  id: string;
  status: ProspectStatus;
  businessName: string | null;
  website: string | null;
  canonicalDomain: string;
  industry: string;
  location: string | null;
  publicPhone: string | null;
  logoUrl: string | null;
  faviconUrl: string | null;
  primaryColour: string | null;
  secondaryColour: string | null;
  accentColour: string | null;
  brandSource: string | null;
  score: number | null;
  scoreBand: string | null;
  outreachAuthority: "none";
  createdAt: string;
  updatedAt: string;
}

export interface DemoRecord {
  id: string;
  prospectId: string;
  version: number;
  slug: string;
  tokenHash: string;
  config: DemoConfig;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export type ProspectEventType =
  | "created"
  | "research_started"
  | "research_completed"
  | "enriched"
  | "scored"
  | "demo_built"
  | "demo_revoked"
  | "demo_viewed"
  | "status_changed";

export interface NewProspect {
  canonicalDomain: string;
  website: string | null;
  businessName: string | null;
  industry: string;
}

export interface ProspectPatch {
  status?: ProspectStatus;
  businessName?: string | null;
  website?: string | null;
  location?: string | null;
  publicPhone?: string | null;
  logoUrl?: string | null;
  faviconUrl?: string | null;
  primaryColour?: string | null;
  secondaryColour?: string | null;
  accentColour?: string | null;
  brandSource?: string | null;
  score?: number | null;
  scoreBand?: string | null;
  researchStartedAt?: string;
  enrichedAt?: string;
  demoBuiltAt?: string;
  lastResearchAt?: string;
}

export interface ProspectStore {
  findByDomain(canonicalDomain: string): Promise<ProspectRecord | null>;
  getById(id: string): Promise<ProspectRecord | null>;
  create(input: NewProspect): Promise<ProspectRecord>;
  update(id: string, patch: ProspectPatch): Promise<ProspectRecord>;
  replaceFacts(prospectId: string, facts: ProspectFact[]): Promise<void>;
  listFacts(prospectId: string): Promise<ProspectFact[]>;
  upsertScore(prospectId: string, score: ProspectScore): Promise<void>;
  getScore(prospectId: string): Promise<ProspectScore | null>;
  addEvent(
    prospectId: string,
    type: ProspectEventType,
    detail: Record<string, unknown>,
  ): Promise<void>;
  listEvents(
    prospectId: string,
  ): Promise<{ type: ProspectEventType; detail: Record<string, unknown>; createdAt: string }[]>;
  insertDemo(demo: Omit<DemoRecord, "createdAt">): Promise<DemoRecord>;
  latestDemo(prospectId: string): Promise<DemoRecord | null>;
  /** All demo versions for a prospect (used to revoke every active version). */
  listDemos(prospectId: string): Promise<DemoRecord[]>;
  findDemoBySlug(slug: string): Promise<DemoRecord | null>;
  revokeDemo(demoId: string, revokedAt: string): Promise<void>;
  list(options?: {
    limit?: number;
    band?: string;
    status?: ProspectStatus;
  }): Promise<ProspectRecord[]>;
}

// ---------------------------------------------------------------------------
// InMemoryProspectStore — a real, dependency-free double for tests and local dev.
// It is NOT a stand-in for production persistence; the Supabase adapter is used at
// runtime. It faithfully models uniqueness (canonical domain, demo slug) so idempotency
// and dedup can be tested without a database.
// ---------------------------------------------------------------------------
export class InMemoryProspectStore implements ProspectStore {
  private prospects = new Map<string, ProspectRecord>();
  private byDomain = new Map<string, string>();
  private facts = new Map<string, ProspectFact[]>();
  private scores = new Map<string, ProspectScore>();
  private events = new Map<
    string,
    { type: ProspectEventType; detail: Record<string, unknown>; createdAt: string }[]
  >();
  private demos = new Map<string, DemoRecord>();
  private demoBySlug = new Map<string, string>();
  private seq = 0;

  constructor(private readonly clock: () => string = () => new Date().toISOString()) {}

  private id(prefix: string): string {
    this.seq += 1;
    return `${prefix}-${this.seq.toString().padStart(6, "0")}`;
  }

  async findByDomain(canonicalDomain: string): Promise<ProspectRecord | null> {
    const id = this.byDomain.get(canonicalDomain);
    return id ? { ...this.prospects.get(id)! } : null;
  }

  async getById(id: string): Promise<ProspectRecord | null> {
    const record = this.prospects.get(id);
    return record ? { ...record } : null;
  }

  async create(input: NewProspect): Promise<ProspectRecord> {
    if (this.byDomain.has(input.canonicalDomain)) {
      throw new Error(`Prospect for domain "${input.canonicalDomain}" already exists.`);
    }
    const now = this.clock();
    const record: ProspectRecord = {
      id: this.id("prospect"),
      status: "discovered",
      businessName: input.businessName,
      website: input.website,
      canonicalDomain: input.canonicalDomain,
      industry: input.industry,
      location: null,
      publicPhone: null,
      logoUrl: null,
      faviconUrl: null,
      primaryColour: null,
      secondaryColour: null,
      accentColour: null,
      brandSource: null,
      score: null,
      scoreBand: null,
      outreachAuthority: "none",
      createdAt: now,
      updatedAt: now,
    };
    this.prospects.set(record.id, record);
    this.byDomain.set(input.canonicalDomain, record.id);
    return { ...record };
  }

  async update(id: string, patch: ProspectPatch): Promise<ProspectRecord> {
    const record = this.prospects.get(id);
    if (!record) throw new Error(`Prospect ${id} not found.`);
    if (patch.status !== undefined) record.status = patch.status;
    if (patch.businessName !== undefined) record.businessName = patch.businessName;
    if (patch.website !== undefined) record.website = patch.website;
    if (patch.location !== undefined) record.location = patch.location;
    if (patch.publicPhone !== undefined) record.publicPhone = patch.publicPhone;
    if (patch.logoUrl !== undefined) record.logoUrl = patch.logoUrl;
    if (patch.faviconUrl !== undefined) record.faviconUrl = patch.faviconUrl;
    if (patch.primaryColour !== undefined) record.primaryColour = patch.primaryColour;
    if (patch.secondaryColour !== undefined) record.secondaryColour = patch.secondaryColour;
    if (patch.accentColour !== undefined) record.accentColour = patch.accentColour;
    if (patch.brandSource !== undefined) record.brandSource = patch.brandSource;
    if (patch.score !== undefined) record.score = patch.score;
    if (patch.scoreBand !== undefined) record.scoreBand = patch.scoreBand;
    record.updatedAt = this.clock();
    return { ...record };
  }

  async replaceFacts(prospectId: string, facts: ProspectFact[]): Promise<void> {
    this.facts.set(
      prospectId,
      facts.map((f) => ({ ...f })),
    );
  }

  async listFacts(prospectId: string): Promise<ProspectFact[]> {
    return (this.facts.get(prospectId) ?? []).map((f) => ({ ...f }));
  }

  async upsertScore(prospectId: string, score: ProspectScore): Promise<void> {
    this.scores.set(prospectId, { ...score });
  }

  async getScore(prospectId: string): Promise<ProspectScore | null> {
    const score = this.scores.get(prospectId);
    return score ? { ...score } : null;
  }

  async addEvent(
    prospectId: string,
    type: ProspectEventType,
    detail: Record<string, unknown>,
  ): Promise<void> {
    const list = this.events.get(prospectId) ?? [];
    list.push({ type, detail, createdAt: this.clock() });
    this.events.set(prospectId, list);
  }

  async listEvents(prospectId: string) {
    return (this.events.get(prospectId) ?? []).map((e) => ({ ...e }));
  }

  async insertDemo(demo: Omit<DemoRecord, "createdAt">): Promise<DemoRecord> {
    if (this.demoBySlug.has(demo.slug)) throw new Error(`Demo slug "${demo.slug}" already exists.`);
    const record: DemoRecord = { ...demo, createdAt: this.clock() };
    this.demos.set(record.id, record);
    this.demoBySlug.set(record.slug, record.id);
    return { ...record };
  }

  async latestDemo(prospectId: string): Promise<DemoRecord | null> {
    const matches = [...this.demos.values()]
      .filter((d) => d.prospectId === prospectId)
      .sort((a, b) => b.version - a.version);
    return matches[0] ? { ...matches[0] } : null;
  }

  async listDemos(prospectId: string): Promise<DemoRecord[]> {
    return [...this.demos.values()]
      .filter((d) => d.prospectId === prospectId)
      .sort((a, b) => b.version - a.version)
      .map((d) => ({ ...d }));
  }

  async findDemoBySlug(slug: string): Promise<DemoRecord | null> {
    const id = this.demoBySlug.get(slug);
    return id ? { ...this.demos.get(id)! } : null;
  }

  async revokeDemo(demoId: string, revokedAt: string): Promise<void> {
    const demo = this.demos.get(demoId);
    if (demo) demo.revokedAt = revokedAt;
  }

  async list(
    options: { limit?: number; band?: string; status?: ProspectStatus } = {},
  ): Promise<ProspectRecord[]> {
    let records = [...this.prospects.values()];
    if (options.band) records = records.filter((r) => r.scoreBand === options.band);
    if (options.status) records = records.filter((r) => r.status === options.status);
    records.sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
    return records.slice(0, options.limit ?? 100).map((r) => ({ ...r }));
  }
}
