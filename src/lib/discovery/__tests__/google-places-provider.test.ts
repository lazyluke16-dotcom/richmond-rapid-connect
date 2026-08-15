/**
 * Deterministic (mocked) tests for the Google Places live provider + vertical classifier.
 * NO live Google request is made and NO quota is consumed.
 */
import { describe, expect, it, vi } from "vitest";
import {
  GOOGLE_PLACES_FIELD_MASK,
  GOOGLE_TEXT_SEARCH_URL,
  GooglePlacesProvider,
  localityFromPlace,
  mapGooglePlace,
} from "../google-places-provider";
import { classifyPlaceVertical } from "../vertical-classify";
import { DiscoveryProviderError } from "../provider";

const KEY = "test-secret-key-DO-NOT-LOG";
const INPUT = {
  vertical: "plumbing",
  geography: "Richmond, VIC",
  geoTerms: ["richmond"],
  pageSize: 20,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function place(over: Record<string, unknown> = {}) {
  return {
    id: "ChIJ_place_1",
    displayName: { text: "Ace Plumbing", languageCode: "en" },
    websiteUri: "https://ace-plumbing.com.au",
    formattedAddress: "1 Swan St, Richmond VIC 3121",
    addressComponents: [{ longText: "Richmond", types: ["locality"] }],
    primaryType: "plumber",
    types: ["plumber", "point_of_interest"],
    ...over,
  };
}

describe("vertical classification", () => {
  it("classifies a plumber", () => {
    expect(classifyPlaceVertical("plumber", ["plumber"]).vertical).toBe("plumbing");
  });
  it("classifies supply/wholesale/hardware as not a plumber", () => {
    expect(classifyPlaceVertical("hardware_store", ["hardware_store"]).vertical).toBe(
      "plumbing_supply",
    );
    expect(
      classifyPlaceVertical("home_improvement_store", ["home_improvement_store", "store"]).vertical,
    ).toBe("plumbing_supply");
  });
  it("excludes schools/training even if a plumber type sneaks in", () => {
    expect(classifyPlaceVertical("school", ["school", "plumber"]).vertical).toBe("not_plumbing");
  });
  it("classifies unrelated businesses as not plumbing", () => {
    expect(classifyPlaceVertical("bakery", ["bakery"]).vertical).toBe("not_plumbing");
  });
});

describe("place mapping", () => {
  it("maps id/website/locality/vertical and skips records without a Place ID", () => {
    const mapped = mapGooglePlace(place());
    expect(mapped).toMatchObject({
      source: "google_places",
      providerBusinessId: "ChIJ_place_1",
      businessName: "Ace Plumbing",
      website: "https://ace-plumbing.com.au",
      locality: "Richmond",
      vertical: "plumbing",
      publicPhone: null,
    });
    expect(mapGooglePlace(place({ id: undefined }))).toBeNull();
  });
  it("derives locality from address components, then formattedAddress", () => {
    expect(localityFromPlace(place())).toBe("Richmond");
    expect(localityFromPlace(place({ addressComponents: [] }))).toBe(
      "1 Swan St, Richmond VIC 3121",
    );
  });
});

describe("request construction", () => {
  it("POSTs to the Text Search endpoint with the minimal (non-wildcard) field mask", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ places: [place()] }));
    const provider = new GooglePlacesProvider({ apiKey: KEY, fetchImpl: fetchImpl as never });
    await provider.search(INPUT, null);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = (fetchImpl.mock.calls as unknown as [string, RequestInit][])[0];
    expect(url).toBe(GOOGLE_TEXT_SEARCH_URL);
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers["X-Goog-Api-Key"]).toBe(KEY);
    expect(headers["X-Goog-FieldMask"]).toBe(GOOGLE_PLACES_FIELD_MASK);
    expect(GOOGLE_PLACES_FIELD_MASK).not.toContain("*");
    expect(GOOGLE_PLACES_FIELD_MASK).not.toMatch(/review|photo|rating|location/i);
    const body = JSON.parse(init.body as string);
    expect(body.textQuery).toBe("plumber in Richmond, VIC");
    expect(body.pageSize).toBe(20);
    expect(body.regionCode).toBe("AU");
    expect(body.pageToken).toBeUndefined();
  });

  it("passes the page token on subsequent pages and keeps other params identical", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ places: [place()], nextPageToken: "TOKEN2" }),
    );
    const provider = new GooglePlacesProvider({ apiKey: KEY, fetchImpl: fetchImpl as never });
    const first = await provider.search(INPUT, null);
    expect(first.nextCursor).toBeTruthy();
    await provider.search(INPUT, first.nextCursor);
    const calls = fetchImpl.mock.calls as unknown as [string, RequestInit][];
    const body = JSON.parse(calls[1][1].body as string);
    expect(body.pageToken).toBe("TOKEN2");
    expect(body.textQuery).toBe("plumber in Richmond, VIC");
  });
});

describe("pagination termination", () => {
  it("stops when the next page token repeats (cycle detection)", async () => {
    // Always return the same token → must not loop forever.
    const fetchImpl = vi.fn(async () => jsonResponse({ places: [place()], nextPageToken: "SAME" }));
    const provider = new GooglePlacesProvider({ apiKey: KEY, fetchImpl: fetchImpl as never });
    const first = await provider.search(INPUT, null);
    expect(first.nextCursor).toBeTruthy();
    const second = await provider.search(INPUT, first.nextCursor);
    // SAME token was already requested → provider signals exhaustion.
    expect(second.nextCursor).toBeNull();
  });
  it("returns nextCursor=null when Google returns no token", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ places: [place()] }));
    const provider = new GooglePlacesProvider({ apiKey: KEY, fetchImpl: fetchImpl as never });
    expect((await provider.search(INPUT, null)).nextCursor).toBeNull();
  });
});

describe("error classification", () => {
  const cases: { status: number; transient: boolean }[] = [
    { status: 400, transient: false },
    { status: 401, transient: false },
    { status: 403, transient: false },
    { status: 429, transient: true },
    { status: 500, transient: true },
    { status: 503, transient: true },
  ];
  for (const { status, transient } of cases) {
    it(`HTTP ${status} → ${transient ? "transient" : "terminal"}`, async () => {
      const fetchImpl = vi.fn(async () => jsonResponse({ error: {} }, status));
      const provider = new GooglePlacesProvider({ apiKey: KEY, fetchImpl: fetchImpl as never });
      await expect(provider.search(INPUT, null)).rejects.toMatchObject({ transient });
    });
  }
  it("timeout/abort → transient", async () => {
    const fetchImpl = vi.fn(async () => {
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    });
    const provider = new GooglePlacesProvider({ apiKey: KEY, fetchImpl: fetchImpl as never });
    await expect(provider.search(INPUT, null)).rejects.toMatchObject({ transient: true });
  });
  it("malformed JSON → transient", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response("not json", { status: 200, headers: { "content-type": "application/json" } }),
    );
    const provider = new GooglePlacesProvider({ apiKey: KEY, fetchImpl: fetchImpl as never });
    await expect(provider.search(INPUT, null)).rejects.toMatchObject({ transient: true });
  });
});

describe("credential security", () => {
  it("fails closed when the key is absent", () => {
    expect(() => new GooglePlacesProvider({ apiKey: "" })).toThrow(DiscoveryProviderError);
  });
  it("never includes the key in thrown error messages", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, 403));
    const provider = new GooglePlacesProvider({ apiKey: KEY, fetchImpl: fetchImpl as never });
    await provider.search(INPUT, null).catch((error: Error) => {
      expect(error.message).not.toContain(KEY);
    });
  });
  it("exposes a non-negative per-request cost estimate", () => {
    const provider = new GooglePlacesProvider({ apiKey: KEY, perRequestCostCents: 4 });
    expect(provider.estimatedRequestCostCents).toBe(4);
  });
});
