/**
 * GooglePlacesProvider — live discovery via Google Places API (New), Text Search.
 *
 * Behind the standard {@link DiscoveryProvider} contract. Server-side only: the API key
 * never reaches the browser, is never logged, and the provider fails closed if it is absent.
 * See docs/LIVE_DISCOVERY_GOOGLE_PLACES.md for the official sources and compliance rationale.
 *
 * Compliance highlights:
 *   - explicit, minimal field mask (NO wildcard `*`);
 *   - never requests reviews/photos/ratings/hours or latitude/longitude;
 *   - Place ID is the durable identifier (dedup key + provider id);
 *   - other Google-derived display content is treated as temporary cache by the engine;
 *   - place-type-based vertical classification (not keyword fallback);
 *   - retryable (429/5xx/timeout) vs terminal (400/401/403/malformed) error classification;
 *   - repeated/cycling page-token detection on top of the engine's hard page cap.
 */
import {
  DiscoveryProviderError,
  type DiscoveryPage,
  type DiscoveryProvider,
  type DiscoverySearchInput,
} from "./provider";
import { classifyPlaceVertical } from "./vertical-classify";
import type { RawDiscoveryCandidate } from "./types";

export const GOOGLE_TEXT_SEARCH_URL = "https://places.googleapis.com/v1/places:searchText";

/**
 * Minimal production field mask. Intentionally excludes reviews/photos/ratings/hours and
 * lat/long. Lands in the Text Search Pro SKU (websiteUri/types are above IDs-Only).
 */
export const GOOGLE_PLACES_FIELD_MASK = [
  "places.id",
  "places.displayName",
  "places.websiteUri",
  "places.formattedAddress",
  "places.addressComponents",
  "places.primaryType",
  "places.types",
  "nextPageToken",
].join(",");

interface GooglePlace {
  id?: string;
  displayName?: { text?: string; languageCode?: string };
  websiteUri?: string;
  formattedAddress?: string;
  addressComponents?: { longText?: string; shortText?: string; types?: string[] }[];
  primaryType?: string;
  types?: string[];
}

interface GoogleTextSearchResponse {
  places?: GooglePlace[];
  nextPageToken?: string;
}

interface CursorState {
  pageToken?: string;
  seen: string[];
}

export interface GooglePlacesProviderOptions {
  apiKey: string;
  fetchImpl?: typeof fetch;
  /** Conservative internal per-request spend estimate in cents (not Google's invoice). */
  perRequestCostCents?: number;
  /** 1–20; Google caps a page at 20. */
  pageSize?: number;
  timeoutMs?: number;
  /** CLDR region code to bias/format results, e.g. "AU". */
  regionCode?: string;
  languageCode?: string;
}

/** Extract a usable locality from Google address components (falls back to formattedAddress). */
export function localityFromPlace(place: GooglePlace): string | null {
  const components = place.addressComponents ?? [];
  const byType = (type: string) =>
    components.find((c) => (c.types ?? []).includes(type))?.longText ?? null;
  return (
    byType("locality") ??
    byType("postal_town") ??
    byType("administrative_area_level_2") ??
    byType("administrative_area_level_1") ??
    place.formattedAddress ??
    null
  );
}

/** Map a Google place to a raw discovery candidate (null if the record is unusable). */
export function mapGooglePlace(place: GooglePlace): RawDiscoveryCandidate | null {
  if (!place.id) return null; // incomplete record — Place ID is required
  const classification = classifyPlaceVertical(place.primaryType, place.types);
  const vertical =
    classification.vertical === "plumbing"
      ? "plumbing"
      : classification.vertical === "plumbing_supply"
        ? "plumbing_supply"
        : "not_plumbing";
  return {
    source: "google_places",
    providerBusinessId: place.id,
    sourceUrl: null,
    businessName: place.displayName?.text ?? null,
    website: place.websiteUri ?? null,
    publicPhone: null, // not requested (kept out of the field mask)
    locality: localityFromPlace(place),
    vertical,
  };
}

export class GooglePlacesProvider implements DiscoveryProvider {
  readonly name = "google_places";
  readonly estimatedRequestCostCents: number;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly pageSize: number;
  private readonly timeoutMs: number;
  private readonly regionCode: string;
  private readonly languageCode: string;

  constructor(options: GooglePlacesProviderOptions) {
    if (!options.apiKey || !options.apiKey.trim()) {
      // Fail closed — the provider must never run without a server-side credential.
      throw new DiscoveryProviderError("Google Places API key is not configured", false);
    }
    this.apiKey = options.apiKey.trim();
    this.fetchImpl = options.fetchImpl ?? fetch;
    // Floor at 1 so the engine's pre-request spend gate can never be disabled by a 0/negative
    // estimate. This is an internal conservative estimate, NOT Google's actual invoice.
    this.estimatedRequestCostCents = Math.max(1, Math.floor(options.perRequestCostCents ?? 4));
    this.pageSize = Math.min(20, Math.max(1, options.pageSize ?? 20));
    this.timeoutMs = options.timeoutMs ?? 8000;
    this.regionCode = options.regionCode ?? "AU";
    this.languageCode = options.languageCode ?? "en";
  }

  private buildQuery(input: DiscoverySearchInput): string {
    const vertical = input.vertical === "plumbing" ? "plumber" : input.vertical;
    return `${vertical} in ${input.geography}`.slice(0, 400);
  }

  async search(input: DiscoverySearchInput, cursor: string | null): Promise<DiscoveryPage> {
    const state: CursorState = decodeCursor(cursor);

    // Per Google, all params except pageToken must be identical across a paginated series.
    const body: Record<string, unknown> = {
      textQuery: this.buildQuery(input),
      pageSize: this.pageSize,
      regionCode: this.regionCode,
      languageCode: this.languageCode,
    };
    if (state.pageToken) body.pageToken = state.pageToken;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(GOOGLE_TEXT_SEARCH_URL, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": this.apiKey,
          "X-Goog-FieldMask": GOOGLE_PLACES_FIELD_MASK,
        },
        body: JSON.stringify(body),
      });
    } catch (cause) {
      // Abort/network — transient (retryable). Never leak the key in the message.
      throw new DiscoveryProviderError(
        cause instanceof Error && cause.name === "AbortError"
          ? "Places request timed out"
          : "Places request failed",
        true,
      );
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) throw classifyHttpError(response.status);

    let json: GoogleTextSearchResponse;
    try {
      json = (await response.json()) as GoogleTextSearchResponse;
    } catch {
      // Malformed/truncated body — transient (retry within the cap).
      throw new DiscoveryProviderError("Places response was not valid JSON", true);
    }

    const candidates = (json.places ?? [])
      .map(mapGooglePlace)
      .filter((c): c is RawDiscoveryCandidate => c !== null);

    // Repeated/cycling page-token detection (in addition to the engine's hard page cap): stop
    // if Google returns the token we just used or one we have already requested.
    const nextToken = json.nextPageToken ?? null;
    const cycled =
      nextToken !== null && (nextToken === state.pageToken || state.seen.includes(nextToken));
    let nextCursor: string | null = null;
    if (nextToken && !cycled) {
      const seen = [...state.seen, state.pageToken]
        .filter((t): t is string => Boolean(t))
        .slice(-12);
      nextCursor = encodeCursor({ pageToken: nextToken, seen });
    }

    return {
      candidates,
      nextCursor,
      usage: { costCents: this.estimatedRequestCostCents, requests: 1 },
    };
  }
}

function classifyHttpError(status: number): DiscoveryProviderError {
  // Terminal (do NOT retry): malformed request, auth, permission/billing.
  if (status === 400) return new DiscoveryProviderError("Places request rejected (400)", false);
  if (status === 401) return new DiscoveryProviderError("Places API key invalid (401)", false);
  if (status === 403)
    return new DiscoveryProviderError("Places API forbidden/billing (403)", false);
  // Transient (retry with backoff): rate limit + server errors.
  if (status === 429) return new DiscoveryProviderError("Places rate limited (429)", true);
  if (status >= 500) return new DiscoveryProviderError(`Places server error (${status})`, true);
  // Other 4xx — treat conservatively as terminal.
  return new DiscoveryProviderError(`Places request failed (${status})`, false);
}

function decodeCursor(cursor: string | null): CursorState {
  if (!cursor) return { seen: [] };
  try {
    const parsed = JSON.parse(cursor) as CursorState;
    return { pageToken: parsed.pageToken, seen: Array.isArray(parsed.seen) ? parsed.seen : [] };
  } catch {
    return { seen: [] };
  }
}

function encodeCursor(state: CursorState): string {
  return JSON.stringify(state);
}
