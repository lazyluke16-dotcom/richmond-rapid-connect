/**
 * FixtureDiscoveryProvider — a deterministic, controlled provider adapter.
 *
 * This is NOT a live source. It serves a fixed, operator/test-supplied set of raw
 * candidates through the standard cursor-paged {@link DiscoveryProvider} contract, so the
 * complete orchestration (paging, dedup, qualification, Slice-1 integration, retry/resume/
 * cancel, caps) can be certified without contacting any real business. It is also the
 * shape a lawful "import" provider (operator-supplied CSV/JSON of businesses they are
 * permitted to process) would take.
 *
 * It can be configured to fail a specific page a fixed number of times to exercise
 * transient-failure + retry paths, deterministically (no randomness).
 */
import {
  DiscoveryProviderError,
  type DiscoveryPage,
  type DiscoveryProvider,
  type DiscoverySearchInput,
} from "./provider";
import type { RawDiscoveryCandidate } from "./types";

export interface FixtureProviderOptions {
  name?: string;
  candidates: RawDiscoveryCandidate[];
  pageSize?: number;
  /** costCents charged per page (default 0 — free/fixture). */
  costCentsPerPage?: number;
  /**
   * Page index -> number of times to fail transiently before succeeding. The counter is
   * decremented on each failed attempt, so { 1: 2 } fails page 1 twice then succeeds.
   */
  transientFailures?: Record<number, number>;
}

export class FixtureDiscoveryProvider implements DiscoveryProvider {
  readonly name: string;
  private readonly candidates: RawDiscoveryCandidate[];
  private readonly pageSize: number;
  private readonly costCentsPerPage: number;
  private readonly remainingFailures: Map<number, number>;

  constructor(options: FixtureProviderOptions) {
    this.name = options.name ?? "fixture";
    this.candidates = options.candidates;
    this.pageSize = Math.max(1, options.pageSize ?? 25);
    this.costCentsPerPage = Math.max(0, options.costCentsPerPage ?? 0);
    this.remainingFailures = new Map(
      Object.entries(options.transientFailures ?? {}).map(([k, v]) => [Number(k), v]),
    );
  }

  async search(_input: DiscoverySearchInput, cursor: string | null): Promise<DiscoveryPage> {
    const offset = cursor ? Number.parseInt(cursor, 10) : 0;
    if (!Number.isInteger(offset) || offset < 0) {
      throw new DiscoveryProviderError("Malformed cursor", false);
    }
    const page = Math.floor(offset / this.pageSize);

    const remaining = this.remainingFailures.get(page) ?? 0;
    if (remaining > 0) {
      this.remainingFailures.set(page, remaining - 1);
      throw new DiscoveryProviderError(`Transient provider failure on page ${page}`, true);
    }

    const slice = this.candidates.slice(offset, offset + this.pageSize);
    const nextOffset = offset + slice.length;
    const exhausted = nextOffset >= this.candidates.length || slice.length === 0;
    return {
      candidates: slice.map((candidate) => ({
        ...candidate,
        source: candidate.source || this.name,
      })),
      nextCursor: exhausted ? null : String(nextOffset),
      usage: { costCents: this.costCentsPerPage, requests: 1 },
    };
  }
}
