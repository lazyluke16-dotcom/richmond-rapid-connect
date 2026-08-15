import { describe, expect, it } from "vitest";
import { extractFromHtml } from "../html-extract";
import { assembleFacts, factValues, MATERIAL_FACT_TYPES, topVerified } from "../evidence";

const RICH_HTML = `<!doctype html><html><head>
<title>Richmond Rapid Plumbing | Blocked Drains &amp; Hot Water</title>
<meta name="description" content="24/7 emergency plumbers serving Richmond and Cremorne.">
<meta name="theme-color" content="#c0392b">
<link rel="icon" href="/favicon.ico">
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Plumber","name":"Richmond Rapid Plumbing","telephone":"03 9111 2222","address":{"@type":"PostalAddress","addressLocality":"Richmond","addressRegion":"VIC"},"openingHours":"Mo-Fr 08:00-17:00","areaServed":["Richmond","Cremorne"]}</script>
</head><body>
<header><img class="logo" alt="Richmond Rapid Plumbing logo" src="/logo.png"></header>
<h1>Fast local plumbers</h1>
<a href="tel:0391112222">Call 03 9111 2222</a>
<ul><li>Blocked drains</li><li>Hot water systems</li><li>Burst pipes</li><li>Gas fitting</li></ul>
<p>24/7 emergency plumbing available across Richmond and Cremorne.</p>
<p>Areas we service: Richmond, Cremorne, Hawthorn.</p>
</body></html>`;

describe("extractFromHtml", () => {
  const extraction = extractFromHtml(RICH_HTML, "https://richmondrapid.com.au/");

  it("prefers schema.org for name, phone, address, hours (high confidence)", () => {
    expect(
      extraction.businessNames.some(
        (c) => c.value === "Richmond Rapid Plumbing" && c.extractor === "structured-data",
      ),
    ).toBe(true);
    expect(extraction.phones.some((c) => c.extractor === "structured-data")).toBe(true);
    expect(extraction.addresses.some((c) => c.context.includes("schema.org"))).toBe(true);
    expect(extraction.openingHours.length).toBeGreaterThan(0);
  });

  it("extracts services from body text", () => {
    const services = extraction.services.map((c) => c.value);
    expect(services).toContain("Blocked drains");
    expect(services).toContain("Hot water systems");
    expect(services).toContain("Gas fitting");
  });

  it("detects emergency availability with supporting context", () => {
    expect(extraction.emergency[0]?.value).toBe("yes");
    expect(extraction.emergency[0]?.context.toLowerCase()).toContain("24/7");
  });

  it("extracts tel: phone, theme colour, favicon and logo", () => {
    expect(extraction.phones.some((c) => c.context === "tel: link")).toBe(true);
    expect(extraction.themeColours).toContain("#c0392b");
    expect(extraction.faviconUrls[0]?.value).toContain("/favicon.ico");
    expect(extraction.logoUrls.some((c) => c.value.endsWith("/logo.png"))).toBe(true);
  });

  it("extracts service areas from areaServed and copy", () => {
    const areas = extraction.serviceAreas.map((c) => c.value.toLowerCase());
    expect(areas).toContain("richmond");
    expect(areas).toContain("cremorne");
  });

  it("never fabricates: an empty page yields no candidates", () => {
    const empty = extractFromHtml(
      "<html><head><title></title></head><body></body></html>",
      "https://x.com.au/",
    );
    expect(empty.services).toHaveLength(0);
    expect(empty.phones).toHaveLength(0);
    expect(empty.emergency).toHaveLength(0);
  });

  it("ignores malformed JSON-LD rather than trusting it", () => {
    const bad = extractFromHtml(
      `<script type="application/ld+json">{ not valid json </script><body>Blocked drains</body>`,
      "https://x.com.au/",
    );
    expect(bad.businessNames.every((c) => c.extractor !== "structured-data")).toBe(true);
  });
});

describe("assembleFacts (provenance + unknowns + conflict)", () => {
  it("produces verified facts with evidence and explicit unknowns", () => {
    const extraction = extractFromHtml(RICH_HTML, "https://richmondrapid.com.au/");
    const facts = assembleFacts([
      {
        sourceUrl: "https://richmondrapid.com.au/",
        retrievedAt: "2026-08-15T00:00:00.000Z",
        candidatesByType: {
          service: extraction.services.map((c) => ({ ...c })),
          public_phone: extraction.phones.map((c) => ({ ...c })),
          emergency_service: extraction.emergency.map((c) => ({ ...c })),
          opening_hours: extraction.openingHours.map((c) => ({ ...c })),
          service_area: extraction.serviceAreas.map((c) => ({ ...c })),
          business_name: extraction.businessNames.map((c) => ({ ...c })),
          address: extraction.addresses.map((c) => ({ ...c })),
        },
      },
    ]);

    const service = topVerified(facts, "service");
    expect(service?.evidence?.sourceUrl).toBe("https://richmondrapid.com.au/");
    expect(service?.status).toBe("verified");
    expect(factValues(facts, "service").length).toBeGreaterThanOrEqual(4);

    // Every material fact type is represented (verified or unknown), never missing.
    for (const type of MATERIAL_FACT_TYPES) {
      expect(facts.some((f) => f.factType === type)).toBe(true);
    }
  });

  it("emits unknown (not fabricated) for absent material facts", () => {
    const facts = assembleFacts([
      {
        sourceUrl: "https://x.com.au/",
        retrievedAt: "2026-08-15T00:00:00.000Z",
        candidatesByType: {},
      },
    ]);
    const phone = facts.find((f) => f.factType === "public_phone");
    expect(phone?.status).toBe("unknown");
    expect(phone?.evidence).toBeNull();
    expect(phone?.value).toBe("UNKNOWN");
  });

  it("marks conflicting single-valued facts instead of silently choosing", () => {
    const facts = assembleFacts([
      {
        sourceUrl: "https://x.com.au/a",
        retrievedAt: "2026-08-15T00:00:00.000Z",
        candidatesByType: {
          public_phone: [
            { value: "0391110000", context: "a", strength: 0.9, extractor: "structured-data" },
          ],
        },
      },
      {
        sourceUrl: "https://x.com.au/b",
        retrievedAt: "2026-08-15T00:00:00.000Z",
        candidatesByType: {
          public_phone: [
            { value: "0392220000", context: "b", strength: 0.9, extractor: "structured-data" },
          ],
        },
      },
    ]);
    const phone = facts.find((f) => f.factType === "public_phone");
    expect(phone?.status).toBe("conflicting");
    expect(phone?.evidence?.observedContext).toContain("Conflicting");
  });
});
