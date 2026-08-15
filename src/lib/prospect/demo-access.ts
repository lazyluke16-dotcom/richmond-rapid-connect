/**
 * DemoAccessService — fail-closed access control for private prospect demos.
 *
 * A demo is reachable only with the correct unlisted slug AND the matching unguessable
 * token. Access is denied — with a single opaque reason to the caller — if the slug is
 * unknown, the token does not match, the demo is revoked, or the demo has expired. The
 * service never leaks other prospects' data and never returns the token hash.
 */
import { hashDemoToken, timingSafeHexEqual } from "./slug";
import type { DemoRecord, ProspectRecord, ProspectStore } from "./store";
import type { DemoConfig } from "./types";

export type DemoDenyReason = "not_found" | "revoked" | "expired" | "invalid_token";

export type DemoAccessResult =
  | { ok: true; prospect: ProspectRecord; demo: DemoRecord; config: DemoConfig }
  | { ok: false; reason: DemoDenyReason };

export class DemoAccessService {
  constructor(
    private readonly store: ProspectStore,
    private readonly clock: () => number = () => Date.now(),
  ) {}

  /**
   * Resolve a demo by slug + raw token. Read-only and fail-closed: any inconsistency or
   * thrown error results in denial rather than exposure.
   */
  async resolve(slug: string, token: string): Promise<DemoAccessResult> {
    try {
      if (!slug || !token) return { ok: false, reason: "invalid_token" };
      const demo = await this.store.findDemoBySlug(slug);
      if (!demo) return { ok: false, reason: "not_found" };
      if (demo.revokedAt) return { ok: false, reason: "revoked" };
      if (demo.expiresAt && new Date(demo.expiresAt).getTime() <= this.clock()) {
        return { ok: false, reason: "expired" };
      }
      const providedHash = await hashDemoToken(token);
      if (!timingSafeHexEqual(providedHash, demo.tokenHash)) {
        return { ok: false, reason: "invalid_token" };
      }
      const prospect = await this.store.getById(demo.prospectId);
      if (!prospect) return { ok: false, reason: "not_found" };
      return { ok: true, prospect, demo, config: demo.config };
    } catch {
      // Fail closed on any unexpected error.
      return { ok: false, reason: "not_found" };
    }
  }

  /** Record a demo view (called explicitly by the runtime, not by the SSR loader). */
  async logView(prospectId: string, detail: Record<string, unknown> = {}): Promise<void> {
    try {
      await this.store.addEvent(prospectId, "demo_viewed", detail);
    } catch {
      // View logging is best-effort and must never break access.
    }
  }

  /**
   * Revoke EVERY active demo version for a prospect (optionally excluding one, used when a
   * rebuild supersedes prior versions). Revoking only the latest would leave earlier
   * rebuilt-over links live, so revocation must cover all active versions. Idempotent;
   * returns the number of demos newly revoked.
   */
  async revokeForProspect(prospectId: string, exceptDemoId?: string): Promise<number> {
    const demos = await this.store.listDemos(prospectId);
    const active = demos.filter((demo) => !demo.revokedAt && demo.id !== exceptDemoId);
    if (active.length === 0) return 0;
    const revokedAt = new Date(this.clock()).toISOString();
    for (const demo of active) {
      await this.store.revokeDemo(demo.id, revokedAt);
    }
    await this.store.addEvent(prospectId, "demo_revoked", {
      revokedCount: active.length,
      demoIds: active.map((demo) => demo.id),
      slugs: active.map((demo) => demo.slug),
    });
    return active.length;
  }
}
