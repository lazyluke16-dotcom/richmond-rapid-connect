/**
 * Discovery provider adapter contract.
 *
 * The mission engine is coupled to this interface, never to a concrete source, so lawful
 * providers can be added/replaced without touching the engine. A provider is a bounded,
 * cursor-paged search: given a search input and an opaque cursor it returns a page of raw
 * candidates, the next cursor (null when exhausted) and usage/cost metadata for spend caps.
 *
 * IMPORTANT: only sources usable lawfully under their current terms/API may be implemented
 * as live providers. Scraping Google Maps or similar in violation of terms is prohibited.
 * V1 ships a deterministic fixture/import provider; live discovery is an external
 * dependency (see docs/AUTONOMOUS_DISCOVERY_V1.md).
 */
import type { RawDiscoveryCandidate } from "./types";

export interface DiscoverySearchInput {
  vertical: string;
  geography: string;
  geoTerms: string[];
  /** Page size hint; the provider may return fewer. */
  pageSize: number;
}

export interface ProviderUsage {
  /** Metered cost of this page in cents (0 for free/fixture sources). */
  costCents: number;
  /** Number of upstream requests this page consumed. */
  requests: number;
}

export interface DiscoveryPage {
  candidates: RawDiscoveryCandidate[];
  /** Opaque cursor for the next page, or null when the source is exhausted. */
  nextCursor: string | null;
  usage: ProviderUsage;
}

export class DiscoveryProviderError extends Error {
  /** Whether the failure is transient (retryable) vs terminal. */
  readonly transient: boolean;
  constructor(message: string, transient = true) {
    super(message);
    this.name = "DiscoveryProviderError";
    this.transient = transient;
  }
}

export interface DiscoveryProvider {
  readonly name: string;
  search(input: DiscoverySearchInput, cursor: string | null): Promise<DiscoveryPage>;
}

/** Registry so a mission's configured source names resolve to provider instances. */
export class ProviderRegistry {
  private providers = new Map<string, DiscoveryProvider>();

  register(provider: DiscoveryProvider): void {
    this.providers.set(provider.name, provider);
  }

  get(name: string): DiscoveryProvider {
    const provider = this.providers.get(name);
    if (!provider)
      throw new DiscoveryProviderError(`No approved discovery provider "${name}"`, false);
    return provider;
  }

  has(name: string): boolean {
    return this.providers.has(name);
  }
}
