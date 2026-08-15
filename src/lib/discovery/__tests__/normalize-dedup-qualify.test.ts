import { describe, expect, it } from "vitest";
import { identityKeys, normalizeCandidate, normalizePhone, primaryDedupKey } from "../normalize";
import { MissionDedupIndex, toIdentityEntry } from "../dedup";
import { isLikelyOfficialWebsite, qualifyCandidate } from "../qualify";
import type { NormalizedCandidate, RawDiscoveryCandidate } from "../types";

function norm(raw: Partial<RawDiscoveryCandidate>, index = 0): NormalizedCandidate {
  return normalizeCandidate({ source: "import", ...raw } as RawDiscoveryCandidate, index);
}

describe("normalisation", () => {
  it("normalises AU phones to a country-prefixed form", () => {
    expect(normalizePhone("03 9111 2222")).toBe("61391112222");
    expect(normalizePhone("+61 3 9111 2222")).toBe("61391112222");
    expect(normalizePhone("(03) 9111-2222")).toBe("61391112222");
    expect(normalizePhone("123")).toBeNull();
    expect(normalizePhone(null)).toBeNull();
  });

  it("derives canonical domain + dedup key from a website (strongest signal)", () => {
    const c = norm({
      website: "https://www.Example-Plumbing.com.au/services",
      businessName: "Example Plumbing",
    });
    expect(c.canonicalDomain).toBe("example-plumbing.com.au");
    expect(c.dedupKey).toBe("dom:example-plumbing.com.au");
  });

  it("falls back through provider id, phone, then name+locality", () => {
    expect(
      primaryDedupKey(
        { domain: null, providerKey: "import:42", phone: "61391112222", nameLocality: "x|y" },
        "s",
      ),
    ).toBe("pid:import:42");
    expect(
      primaryDedupKey(
        { domain: null, providerKey: null, phone: "61391112222", nameLocality: "x|y" },
        "s",
      ),
    ).toBe("ph:61391112222");
    expect(
      primaryDedupKey({ domain: null, providerKey: null, phone: null, nameLocality: "x|y" }, "s"),
    ).toBe("nm:x|y");
    expect(
      primaryDedupKey({ domain: null, providerKey: null, phone: null, nameLocality: null }, "seed"),
    ).toBe("none:seed");
  });

  it("only forms a name+locality key when BOTH are present", () => {
    expect(identityKeys(norm({ businessName: "Smith Plumbing" })).nameLocality).toBeNull();
    expect(
      identityKeys(norm({ businessName: "Smith Plumbing", locality: "Richmond" })).nameLocality,
    ).toBe("smith plumbing|richmond");
  });
});

describe("layered deduplication", () => {
  it("collapses exact + differently-formatted domain duplicates", () => {
    const index = new MissionDedupIndex();
    const a = norm({ website: "https://x.com.au" });
    index.add(toIdentityEntry("a", a));
    const b = norm({ website: "https://www.x.com.au/" });
    expect(index.findDuplicate(b)).toMatchObject({ matchId: "a", reason: "duplicate_domain" });
  });

  it("collapses phone duplicates when no stronger key exists", () => {
    const index = new MissionDedupIndex();
    index.add(toIdentityEntry("a", norm({ businessName: "A", publicPhone: "03 9111 2222" })));
    const dup = index.findDuplicate(norm({ businessName: "B", publicPhone: "0391112222" }));
    expect(dup).toMatchObject({ reason: "duplicate_phone" });
  });

  it("does NOT merge same-name businesses in different localities", () => {
    const index = new MissionDedupIndex();
    index.add(
      toIdentityEntry(
        "rich",
        norm({
          businessName: "Smith Plumbing",
          locality: "Richmond",
          website: "https://smith-rich.com.au",
        }),
      ),
    );
    const geelong = norm({
      businessName: "Smith Plumbing",
      locality: "Geelong",
      website: "https://smith-geel.com.au",
    });
    expect(index.findDuplicate(geelong)).toBeNull();
  });

  it("merges same name AND same locality (cautious fallback)", () => {
    const index = new MissionDedupIndex();
    index.add(toIdentityEntry("a", norm({ businessName: "Smith Plumbing", locality: "Richmond" })));
    expect(
      index.findDuplicate(norm({ businessName: "Smith  Plumbing", locality: "richmond" })),
    ).toMatchObject({ reason: "duplicate_name_locality" });
  });
});

describe("pre-qualification", () => {
  const mission = { vertical: "plumbing", geoTerms: ["richmond", "cremorne"] };

  it("accepts a safe, in-geography plumbing business with a website", () => {
    expect(
      qualifyCandidate(
        norm({
          businessName: "Ace Plumbing",
          website: "https://ace-plumbing.com.au",
          locality: "Richmond",
        }),
        mission,
      ),
    ).toEqual({ ok: true });
  });

  it("rejects insufficient identity", () => {
    expect(qualifyCandidate(norm({}), mission)).toMatchObject({
      ok: false,
      reason: "insufficient_identity",
    });
  });

  it("rejects a non-plumbing vertical", () => {
    expect(
      qualifyCandidate(
        norm({
          businessName: "Joe's Bakery",
          website: "https://joes.com.au",
          locality: "Richmond",
          vertical: "bakery",
        }),
        mission,
      ),
    ).toMatchObject({ ok: false, reason: "not_target_vertical" });
  });

  it("rejects outside geography", () => {
    expect(
      qualifyCandidate(
        norm({
          businessName: "Sydney Plumbing",
          website: "https://syd-plumbing.com.au",
          locality: "Sydney",
        }),
        mission,
      ),
    ).toMatchObject({ ok: false, reason: "outside_geography" });
  });

  it("rejects a missing website", () => {
    expect(
      qualifyCandidate(
        norm({
          businessName: "Richmond Plumbing",
          publicPhone: "03 9111 2222",
          locality: "Richmond",
        }),
        mission,
      ),
    ).toMatchObject({ ok: false, reason: "no_website" });
  });

  it("rejects unsafe/private URLs, including 6to4 metadata", () => {
    expect(
      qualifyCandidate(
        norm({
          businessName: "Internal Plumbing",
          website: "http://10.0.0.5",
          locality: "Richmond",
        }),
        mission,
      ),
    ).toMatchObject({ ok: false, reason: "unsafe_url" });
    expect(
      qualifyCandidate(
        norm({
          businessName: "Metadata Plumbing",
          website: "http://[2002:a9fe:a9fe::]/",
          locality: "Richmond",
        }),
        mission,
      ),
    ).toMatchObject({ ok: false, reason: "unsafe_url" });
  });

  it("treats social/directory/provider-profile URLs as NOT an official website", () => {
    expect(isLikelyOfficialWebsite("https://ace-plumbing.com.au")).toBe(true);
    for (const url of [
      "https://www.facebook.com/aceplumbing",
      "https://instagram.com/aceplumbing",
      "https://ace.business.site",
      "https://g.page/aceplumbing",
      "https://www.yelp.com.au/biz/ace-plumbing",
      "https://hipages.com.au/connect/aceplumbing",
      "https://linktr.ee/aceplumbing",
    ]) {
      expect(isLikelyOfficialWebsite(url)).toBe(false);
    }
  });

  it("rejects a candidate whose only website is a social/directory page (no_website)", () => {
    expect(
      qualifyCandidate(
        norm({
          businessName: "Ace Plumbing",
          website: "https://facebook.com/ace",
          locality: "Richmond",
        }),
        mission,
      ),
    ).toMatchObject({ ok: false, reason: "no_website" });
  });

  it("skips geography filtering when the mission does not constrain it", () => {
    expect(
      qualifyCandidate(
        norm({
          businessName: "Anywhere Plumbing",
          website: "https://anywhere-plumbing.com.au",
          locality: "Perth",
        }),
        { vertical: "plumbing", geoTerms: [] },
      ),
    ).toEqual({ ok: true });
  });
});
