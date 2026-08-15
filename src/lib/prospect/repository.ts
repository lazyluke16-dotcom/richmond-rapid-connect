/**
 * ProspectRepository — the transactional heart of the prospect domain.
 *
 * Owns idempotent create-or-update by canonical domain, evidence-backed persistence of a
 * research result, denormalised branding/score caches (only ever from verified facts),
 * the deterministic score, and every lifecycle transition. All status changes flow
 * through {@link assertV1Transition}, so no code path in this slice can advance a prospect
 * beyond `demo_ready`.
 */
import { topVerified } from "./evidence";
import { assertV1Transition } from "./lifecycle";
import { resolvedColours } from "./brand";
import type { ProspectPatch, ProspectRecord, ProspectStore } from "./store";
import type { ProspectStatus, ResearchResult } from "./types";

export class ProspectRepository {
  constructor(
    private readonly store: ProspectStore,
    private readonly clock: () => string = () => new Date().toISOString(),
  ) {}

  /** Idempotent: returns the existing prospect for a domain or creates a new one. */
  async findOrCreate(input: {
    canonicalDomain: string;
    website: string | null;
    businessName: string | null;
    industry: string;
  }): Promise<{ prospect: ProspectRecord; created: boolean }> {
    const existing = await this.store.findByDomain(input.canonicalDomain);
    if (existing) return { prospect: existing, created: false };
    const prospect = await this.store.create(input);
    await this.store.addEvent(prospect.id, "created", { canonicalDomain: input.canonicalDomain });
    return { prospect, created: true };
  }

  async getById(id: string): Promise<ProspectRecord | null> {
    return this.store.getById(id);
  }

  /** Safely move a prospect's status, recording an audit event. */
  async transition(id: string, to: ProspectStatus): Promise<ProspectRecord> {
    const prospect = await this.store.getById(id);
    if (!prospect) throw new Error(`Prospect ${id} not found.`);
    assertV1Transition(prospect.status, to);
    const updated = await this.store.update(id, { status: to });
    await this.store.addEvent(id, "status_changed", { from: prospect.status, to });
    return updated;
  }

  /**
   * Persist a research result against a prospect: replace facts, upsert the score, refresh
   * the denormalised caches, and advance the lifecycle discovered→researching→enriched.
   * Re-runnable: calling twice on the same domain updates in place, never forks.
   */
  async saveResearch(prospectId: string, result: ResearchResult): Promise<ProspectRecord> {
    const current = await this.store.getById(prospectId);
    if (!current) throw new Error(`Prospect ${prospectId} not found.`);

    // discovered -> researching (idempotent if already past it).
    if (current.status === "discovered") await this.transition(prospectId, "researching");
    await this.store.addEvent(prospectId, "research_started", { website: result.website });

    await this.store.replaceFacts(prospectId, result.facts);
    await this.store.upsertScore(prospectId, result.score);

    const colours = resolvedColours(result.branding);
    const phoneFact = topVerified(result.facts, "public_phone");
    const addressFact = topVerified(result.facts, "address");
    const patch: ProspectPatch = {
      businessName: result.businessName,
      website: result.website,
      location: addressFact?.value ?? null,
      publicPhone: phoneFact?.value ?? null,
      logoUrl: result.branding.logoUrl,
      faviconUrl: result.branding.faviconUrl,
      primaryColour: result.branding.colours.primary ?? colours.primary,
      secondaryColour: result.branding.colours.secondary ?? colours.secondary,
      accentColour: result.branding.colours.accent ?? colours.accent,
      brandSource: result.branding.source,
      score: result.score.score,
      scoreBand: result.score.band,
    };
    await this.store.update(prospectId, patch);

    await this.store.addEvent(prospectId, "research_completed", {
      factCount: result.facts.length,
      notes: result.notes,
    });
    await this.store.addEvent(prospectId, "scored", {
      score: result.score.score,
      band: result.score.band,
    });

    const afterResearch = await this.store.getById(prospectId);
    if (afterResearch && afterResearch.status === "researching") {
      await this.transition(prospectId, "enriched");
      await this.store.addEvent(prospectId, "enriched", {});
    }
    return (await this.store.getById(prospectId))!;
  }
}
