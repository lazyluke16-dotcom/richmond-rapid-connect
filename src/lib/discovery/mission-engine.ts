/**
 * Discovery mission engine — deterministic, bounded, resumable orchestration.
 *
 * The engine advances a mission in small, idempotent units of work (one provider page at a
 * time). All state — status, provider cursor, counts, cost, retries — lives in the database,
 * so a mission survives process termination and is resumed simply by calling
 * {@link advanceMission} again. There is NO long-lived in-memory worker (Cloudflare/Nitro
 * friendly). Every bound is explicit: target count, hard max-candidate cap, per-page size,
 * retry cap, and an optional metered-cost ceiling.
 *
 * Accepted candidates are handed to the approved Slice-1 pipeline (buildProspectDemo),
 * which preserves all Slice-1 protections (SSRF incl. 6to4/Teredo, provenance, conflict
 * handling, anti-hallucination, deterministic scoring, hashed demo tokens, expiry/
 * revocation, rebuild-supersede, and the demo_ready lifecycle cap). The engine performs NO
 * outreach and creates NO paid provider resources.
 */
import { buildProspectDemo } from "../prospect/build-demo";
import type { ProspectStore } from "../prospect/store";
import { MissionDedupIndex, toIdentityEntry } from "./dedup";
import { normalizeCandidate } from "./normalize";
import { DiscoveryProviderError, type ProviderRegistry } from "./provider";
import { qualifyCandidate } from "./qualify";
import type { MissionStore } from "./mission-store";
import type { CandidateReason, DiscoveryMissionRecord } from "./types";

export interface EngineDeps {
  missionStore: MissionStore;
  prospectStore: ProspectStore;
  registry: ProviderRegistry;
  fetchImpl?: typeof fetch;
  dnsLookup?: (hostname: string) => Promise<string[]>;
  clock?: () => string;
  baseUrl?: string;
  demoTtlDays?: number;
  /** Candidates requested per provider page (default 25). */
  pageSize?: number;
}

export interface AdvanceResult {
  status: DiscoveryMissionRecord["status"];
  processed: number;
  accepted: number;
  /** Input candidates collapsed by the (mission, dedup_key) unique key (exact/format dups). */
  collapsed: number;
  completed: boolean;
  /** True when the step ended on a retryable provider failure. */
  retriedTransientFailure: boolean;
}

async function refreshCounts(deps: EngineDeps, missionId: string): Promise<void> {
  const counts = await deps.missionStore.countByDisposition(missionId);
  await deps.missionStore.updateMission(missionId, { counts });
}

/** Mission status transitions (operator actions), all audited. */
export async function startMission(
  deps: EngineDeps,
  missionId: string,
): Promise<DiscoveryMissionRecord> {
  const mission = await deps.missionStore.getMission(missionId);
  if (!mission) throw new Error(`Mission ${missionId} not found`);
  if (!["draft", "approved", "paused"].includes(mission.status)) {
    throw new Error(`Cannot start mission in status "${mission.status}"`);
  }
  const clock = deps.clock ?? (() => new Date().toISOString());
  const updated = await deps.missionStore.updateMission(missionId, {
    status: "running",
    startedAt: mission.startedAt ?? clock(),
    lastError: null,
  });
  await deps.missionStore.addMissionEvent(
    missionId,
    mission.status === "paused" ? "resumed" : "started",
    {},
  );
  return updated;
}

export async function pauseMission(
  deps: EngineDeps,
  missionId: string,
): Promise<DiscoveryMissionRecord> {
  const mission = await deps.missionStore.getMission(missionId);
  if (!mission) throw new Error(`Mission ${missionId} not found`);
  if (mission.status !== "running")
    throw new Error(`Cannot pause mission in status "${mission.status}"`);
  const updated = await deps.missionStore.updateMission(missionId, { status: "paused" });
  await deps.missionStore.addMissionEvent(missionId, "paused", {});
  return updated;
}

export async function cancelMission(
  deps: EngineDeps,
  missionId: string,
): Promise<DiscoveryMissionRecord> {
  const mission = await deps.missionStore.getMission(missionId);
  if (!mission) throw new Error(`Mission ${missionId} not found`);
  if (["completed", "cancelled", "failed"].includes(mission.status)) return mission;
  const clock = deps.clock ?? (() => new Date().toISOString());
  const updated = await deps.missionStore.updateMission(missionId, {
    status: "cancelled",
    completedAt: clock(),
  });
  await deps.missionStore.addMissionEvent(missionId, "cancelled", {});
  return updated;
}

async function complete(deps: EngineDeps, missionId: string, reason: string): Promise<void> {
  const clock = deps.clock ?? (() => new Date().toISOString());
  await refreshCounts(deps, missionId);
  await deps.missionStore.updateMission(missionId, { status: "completed", completedAt: clock() });
  await deps.missionStore.addMissionEvent(missionId, "completed", { reason });
}

/**
 * Advance a running mission by one bounded unit (one provider page). Idempotent and
 * resumable; safe to call repeatedly and concurrently.
 */
export async function advanceMission(deps: EngineDeps, missionId: string): Promise<AdvanceResult> {
  const clock = deps.clock ?? (() => new Date().toISOString());
  const pageSize = Math.max(1, deps.pageSize ?? 25);
  const mission = await deps.missionStore.getMission(missionId);
  if (!mission) throw new Error(`Mission ${missionId} not found`);

  if (mission.status !== "running") {
    return {
      status: mission.status,
      processed: 0,
      accepted: 0,
      collapsed: 0,
      completed: false,
      retriedTransientFailure: false,
    };
  }

  // Terminal bounds reached before doing any work.
  if (mission.counts.demoReady >= mission.targetCount) {
    await complete(deps, missionId, "target_reached");
    return {
      status: "completed",
      processed: 0,
      accepted: 0,
      collapsed: 0,
      completed: true,
      retriedTransientFailure: false,
    };
  }
  if (mission.counts.discovered >= mission.maxCandidates) {
    await complete(deps, missionId, "max_candidates_reached");
    return {
      status: "completed",
      processed: 0,
      accepted: 0,
      collapsed: 0,
      completed: true,
      retriedTransientFailure: false,
    };
  }

  const provider = deps.registry.get(mission.sources[0]);
  const cursorKey = provider.name;
  const cursor = (mission.cursor[cursorKey] as string | null | undefined) ?? null;

  // Fetch one page, handling transient (retryable) vs terminal provider failures.
  let page;
  try {
    page = await provider.search(
      {
        vertical: mission.vertical,
        geography: mission.geography,
        geoTerms: mission.geoTerms,
        pageSize,
      },
      cursor,
    );
  } catch (error) {
    const transient = error instanceof DiscoveryProviderError ? error.transient : true;
    const message = error instanceof Error ? error.message : "provider error";
    if (transient && mission.retryCount < mission.maxRetries) {
      await deps.missionStore.updateMission(missionId, {
        retryCount: mission.retryCount + 1,
        lastError: message,
      });
      await deps.missionStore.addMissionEvent(missionId, "page_failed", {
        transient: true,
        message,
        attempt: mission.retryCount + 1,
      });
      return {
        status: "running",
        processed: 0,
        accepted: 0,
        collapsed: 0,
        completed: false,
        retriedTransientFailure: true,
      };
    }
    await deps.missionStore.updateMission(missionId, {
      status: "failed",
      lastError: message,
      completedAt: clock(),
    });
    await deps.missionStore.addMissionEvent(missionId, "failed", { transient, message });
    return {
      status: "failed",
      processed: 0,
      accepted: 0,
      collapsed: 0,
      completed: false,
      retriedTransientFailure: false,
    };
  }

  // Successful page resets the retry counter and charges any metered cost.
  const newCost = mission.costCents + page.usage.costCents;
  await deps.missionStore.updateMission(missionId, { retryCount: 0, costCents: newCost });

  // Build the dedup index from candidates already stored for this mission.
  const index = new MissionDedupIndex(await deps.missionStore.listCandidateIdentities(missionId));

  let processed = 0;
  let accepted = 0;
  let collapsed = 0;
  let discovered = mission.counts.discovered;

  for (const raw of page.candidates) {
    if (discovered >= mission.maxCandidates) break;
    if (mission.counts.demoReady + accepted >= mission.targetCount) break;

    const normalized = normalizeCandidate(raw, discovered);
    const claim = await deps.missionStore.claimCandidate({
      missionId,
      normalized,
      discoveryQuery: mission.geography,
      rawHash: null,
    });
    // Another worker (or an earlier page) already claimed this exact identity — the unique
    // (mission, dedup_key) constraint collapsed an exact/differently-formatted duplicate.
    if (!claim.claimed) {
      collapsed += 1;
      continue;
    }
    processed += 1;
    discovered += 1;

    // Cross-dimension duplicate within the mission (weaker signals than the primary key).
    const dup = index.findDuplicate(normalized);
    if (dup) {
      await deps.missionStore.updateCandidate(claim.record.id, {
        disposition: "duplicate",
        reason: dup.reason,
        duplicateOf: dup.matchId,
      });
      index.add(toIdentityEntry(claim.record.id, normalized));
      continue;
    }
    index.add(toIdentityEntry(claim.record.id, normalized));

    // Cheap explainable pre-qualification.
    const qualified = qualifyCandidate(normalized, {
      vertical: mission.vertical,
      geoTerms: mission.geoTerms,
    });
    if (!qualified.ok) {
      await deps.missionStore.updateCandidate(claim.record.id, {
        disposition: "rejected",
        reason: qualified.reason,
      });
      continue;
    }

    // Already a prospect (from this or a prior mission)? Link it; never re-research/rebuild.
    const existing = normalized.canonicalDomain
      ? await deps.prospectStore.findByDomain(normalized.canonicalDomain)
      : null;
    if (existing) {
      await deps.missionStore.updateCandidate(claim.record.id, {
        disposition: "duplicate",
        reason: "existing_prospect",
        acceptedProspectId: existing.id,
      });
      continue;
    }

    // Accept → hand to the Slice-1 pipeline to research + build a private demo.
    await deps.missionStore.updateCandidate(claim.record.id, {
      disposition: "accepted",
      reason: "accepted",
    });
    try {
      const result = await buildProspectDemo(deps.prospectStore, normalized.website!, {
        fetchImpl: deps.fetchImpl,
        dnsLookup: deps.dnsLookup,
        clock: deps.clock,
        baseUrl: deps.baseUrl,
        demoTtlDays: deps.demoTtlDays,
      });
      await deps.missionStore.updateCandidate(claim.record.id, {
        disposition: "demo_ready",
        reason: "demo_built",
        acceptedProspectId: result.prospectId,
      });
      accepted += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : "research failed";
      await deps.missionStore.updateCandidate(claim.record.id, {
        disposition: "failed",
        reason: "research_failed" as CandidateReason,
      });
      await deps.missionStore.addMissionEvent(missionId, "candidate_processed", {
        candidateId: claim.record.id,
        failed: message,
      });
    }
  }

  // Persist the cursor + recomputed counts.
  await deps.missionStore.updateMission(missionId, {
    cursor: { ...mission.cursor, [cursorKey]: page.nextCursor },
  });
  await refreshCounts(deps, missionId);
  await deps.missionStore.addMissionEvent(missionId, "page_fetched", {
    processed,
    accepted,
    costCents: page.usage.costCents,
    exhausted: page.nextCursor === null,
  });

  // Terminal conditions.
  const after = await deps.missionStore.getMission(missionId);
  const done = after!;
  if (done.counts.demoReady >= done.targetCount) {
    await complete(deps, missionId, "target_reached");
    return {
      status: "completed",
      processed,
      accepted,
      collapsed,
      completed: true,
      retriedTransientFailure: false,
    };
  }
  if (done.counts.discovered >= done.maxCandidates) {
    await complete(deps, missionId, "max_candidates_reached");
    return {
      status: "completed",
      processed,
      accepted,
      collapsed,
      completed: true,
      retriedTransientFailure: false,
    };
  }
  if (done.costCeilingCents != null && done.costCents > done.costCeilingCents) {
    await complete(deps, missionId, "cost_ceiling_reached");
    return {
      status: "completed",
      processed,
      accepted,
      collapsed,
      completed: true,
      retriedTransientFailure: false,
    };
  }
  if (page.nextCursor === null) {
    await complete(deps, missionId, "source_exhausted");
    return {
      status: "completed",
      processed,
      accepted,
      collapsed,
      completed: true,
      retriedTransientFailure: false,
    };
  }
  return {
    status: "running",
    processed,
    accepted,
    collapsed,
    completed: false,
    retriedTransientFailure: false,
  };
}

/**
 * Drive a mission to a terminal state by repeatedly advancing it. Bounded by maxSteps to
 * guarantee termination (no infinite loop). In production this loop is the operator/route
 * re-invoking advanceMission; the built-in loop is used for local/dev/test runs and small
 * missions. Transient failures are retried immediately here (real backoff timing is a
 * scheduler concern), up to the mission's retry cap.
 */
export async function runMissionToCompletion(
  deps: EngineDeps,
  missionId: string,
  options: { maxSteps?: number } = {},
): Promise<DiscoveryMissionRecord> {
  const maxSteps = Math.max(1, options.maxSteps ?? 1000);
  for (let step = 0; step < maxSteps; step++) {
    const result = await advanceMission(deps, missionId);
    if (
      result.completed ||
      ["completed", "failed", "cancelled", "paused"].includes(result.status)
    ) {
      break;
    }
  }
  return (await deps.missionStore.getMission(missionId))!;
}
