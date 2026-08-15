/**
 * buildProspectDemo — the single controlled entry point for Slice 1.
 *
 * "Build a Rapid Connect prospect demo for https://exampleplumber.com.au" resolves to
 * this function. With no further operator data it: validates the target (SSRF-safe),
 * finds-or-creates the prospect (idempotent by canonical domain), runs deterministic
 * research, persists evidence-backed facts + the deterministic score, generates a safe
 * demo configuration (anti-hallucination guarded), mints an unlisted slug + unguessable
 * token, and advances the lifecycle to `demo_ready` — and no further.
 *
 * It performs NO outreach and provisions NO provider resources. The raw demo token is
 * returned exactly once (only its hash is stored).
 */
import { canonicalDomain, normalizeWebsiteInput } from "./canonical";
import { generateDemoConfig } from "./demo-config";
import { researchProspect, type ResearchDeps } from "./research";
import { ProspectRepository } from "./repository";
import { buildDemoSlug, generateDemoToken, hashDemoToken } from "./slug";
import { assertFetchableUrl } from "./url-safety";
import type { ProspectStore } from "./store";

export interface BuildDemoDeps extends ResearchDeps {
  /** Absolute base URL used to render the demo link (no trailing slash). */
  baseUrl?: string;
  /** Demo link lifetime in days (default 30). Pass 0/undefined for no expiry. */
  demoTtlDays?: number;
}

export interface BuildDemoResult {
  prospectId: string;
  canonicalDomain: string;
  created: boolean;
  businessName: string | null;
  score: number;
  band: string;
  demo: {
    slug: string;
    /** Shown exactly once. Only its hash is persisted. */
    token: string;
    url: string;
    version: number;
    expiresAt: string | null;
  };
  notes: string[];
}

export async function buildProspectDemo(
  store: ProspectStore,
  target: string,
  deps: BuildDemoDeps = {},
): Promise<BuildDemoResult> {
  const clock = deps.clock ?? (() => new Date().toISOString());
  const baseUrl = (deps.baseUrl ?? "").replace(/\/+$/, "");
  const repo = new ProspectRepository(store, clock);

  // 1. Validate the target up-front. Throws on malformed/SSRF/internal targets before
  //    any record is created.
  const website = normalizeWebsiteInput(target);
  assertFetchableUrl(website);
  const domain = canonicalDomain(website);

  // 2. Idempotent find-or-create by canonical domain.
  const { prospect, created } = await repo.findOrCreate({
    canonicalDomain: domain,
    website,
    businessName: null,
    industry: "plumbing",
  });

  // 3. Deterministic research + persistence (facts, score, branding, lifecycle→enriched).
  const result = await researchProspect(website, deps);
  await repo.saveResearch(prospect.id, result);

  // 4. Demo build: enriched → demo_building.
  const current = await repo.getById(prospect.id);
  if (current && current.status === "enriched") await repo.transition(prospect.id, "demo_building");

  const config = generateDemoConfig({
    businessName: result.businessName ?? result.branding.displayName,
    facts: result.facts,
    branding: result.branding,
    generatedAt: clock(),
  });

  // 5. Mint an unlisted slug + unguessable token; only the hash is stored.
  const token = generateDemoToken();
  const tokenHash = await hashDemoToken(token);
  const previous = await store.latestDemo(prospect.id);
  const version = (previous?.version ?? 0) + 1;
  const expiresAt =
    deps.demoTtlDays && deps.demoTtlDays > 0
      ? new Date(Date.parse(clock()) + deps.demoTtlDays * 86_400_000).toISOString()
      : null;

  let inserted = null as Awaited<ReturnType<ProspectStore["insertDemo"]>> | null;
  for (let attempt = 0; attempt < 5 && !inserted; attempt++) {
    const slug = buildDemoSlug(config.businessName);
    try {
      inserted = await store.insertDemo({
        id: `${prospect.id}:demo:${version}:${slug}`,
        prospectId: prospect.id,
        version,
        slug,
        tokenHash,
        config,
        expiresAt,
        revokedAt: null,
      });
    } catch {
      // Slug collision — regenerate (new random suffix) and retry.
      inserted = null;
    }
  }
  if (!inserted) throw new Error("Could not allocate a unique demo slug after several attempts.");

  // A rebuild supersedes prior versions: revoke every earlier active demo so old links
  // (and their tokens) fail closed and only the newest link is live.
  const priorDemos = await store.listDemos(prospect.id);
  const supersededAt = clock();
  for (const demo of priorDemos) {
    if (demo.id !== inserted.id && !demo.revokedAt) {
      await store.revokeDemo(demo.id, supersededAt);
    }
  }

  await store.addEvent(prospect.id, "demo_built", {
    slug: inserted.slug,
    version,
    score: result.score.score,
    supersededPriorVersions: priorDemos.filter((d) => d.id !== inserted.id).length,
  });
  await store.update(prospect.id, { demoBuiltAt: clock() });

  // 6. demo_building → demo_ready. This is the terminal state for V1.
  await repo.transition(prospect.id, "demo_ready");

  return {
    prospectId: prospect.id,
    canonicalDomain: domain,
    created,
    businessName: result.businessName ?? result.branding.displayName,
    score: result.score.score,
    band: result.score.band,
    demo: {
      slug: inserted.slug,
      token,
      url: `${baseUrl}/demo/${inserted.slug}/${token}`,
      version,
      expiresAt,
    },
    notes: result.notes,
  };
}
