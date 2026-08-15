/**
 * Prospect lifecycle state machine.
 *
 * The full journey is declared for forward-compatibility with later slices, but this
 * slice is bounded: {@link V1_TERMINAL_STATUS} is `demo_ready` and no transition helper
 * here will advance a prospect beyond it. Attempting to do so throws — the "no outreach
 * from this slice" guarantee is enforced in code as well as by the database CHECK
 * constraint added in 20260815120000_prospect_intelligence.sql.
 */
import type { FutureProspectStatus, ProspectStatus } from "./types";

export const V1_STATUSES: readonly ProspectStatus[] = [
  "discovered",
  "researching",
  "enriched",
  "demo_building",
  "demo_ready",
] as const;

export const FUTURE_STATUSES: readonly FutureProspectStatus[] = [
  "outreach_approved",
  "contacted",
  "engaged",
  "trial",
  "paid",
  "customer",
] as const;

export const V1_TERMINAL_STATUS: ProspectStatus = "demo_ready";

/** Ordered forward transitions permitted within V1. */
const V1_FORWARD: Record<ProspectStatus, ProspectStatus[]> = {
  discovered: ["researching"],
  researching: ["enriched", "discovered"],
  enriched: ["demo_building", "researching"],
  demo_building: ["demo_ready", "enriched"],
  demo_ready: ["demo_building"], // rebuild allowed; never forward to outreach in V1
};

export function isV1ReachableStatus(status: string): status is ProspectStatus {
  return (V1_STATUSES as readonly string[]).includes(status);
}

export function isFutureStatus(status: string): status is FutureProspectStatus {
  return (FUTURE_STATUSES as readonly string[]).includes(status);
}

/**
 * Whether `from -> to` is a legal V1 transition. Any transition into a future
 * (outreach/customer) status is rejected.
 */
export function canTransition(from: ProspectStatus, to: ProspectStatus): boolean {
  if (!isV1ReachableStatus(to)) return false;
  if (from === to) return true;
  return V1_FORWARD[from]?.includes(to) ?? false;
}

/**
 * Assert a transition is legal in V1, throwing a descriptive error otherwise. This is
 * the single choke point the repository uses to move a prospect's status.
 */
export function assertV1Transition(from: ProspectStatus, to: string): asserts to is ProspectStatus {
  if (isFutureStatus(to)) {
    throw new Error(
      `Refusing to advance prospect to "${to}": Autonomous Acquisition V1 stops at "${V1_TERMINAL_STATUS}". Outreach/customer states are a later slice.`,
    );
  }
  if (!isV1ReachableStatus(to)) {
    throw new Error(`Unknown prospect status "${to}".`);
  }
  if (!canTransition(from, to)) {
    throw new Error(`Illegal prospect transition "${from}" -> "${to}".`);
  }
}
