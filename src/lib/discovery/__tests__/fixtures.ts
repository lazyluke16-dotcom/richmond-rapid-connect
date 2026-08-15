/**
 * Controlled, deterministic discovery fixtures for certifying the mission engine.
 *
 * SYNTHETIC ONLY — no real business is represented or contacted, and no network request is
 * made (a fake fetch serves each candidate's site). The candidate set deliberately includes
 * the messy cases required by Issue #23: exact duplicates, differently-formatted duplicates,
 * same-name/different-locality independent businesses, phone-only duplicates, missing
 * websites, malformed URLs, unsafe/private URLs, irrelevant businesses and out-of-geography
 * listings.
 */
import type { RawDiscoveryCandidate } from "../types";

const GEO = "richmond";

function plumber(n: number, opts: Partial<RawDiscoveryCandidate> = {}): RawDiscoveryCandidate {
  const domain = `disco-plumber-${n}.com.au`;
  return {
    source: "import",
    providerBusinessId: `imp-${n}`,
    businessName: `Disco Plumbing ${n}`,
    website: `https://${domain}`,
    publicPhone: `03 9${(1000000 + n).toString().slice(0, 7)}`,
    locality: "Richmond",
    vertical: "plumbing",
    ...opts,
  };
}

/** Build a >100 candidate set with the full spread of dedup/qualify cases. */
export function buildDiscoveryCandidates(): RawDiscoveryCandidate[] {
  const list: RawDiscoveryCandidate[] = [];

  // 90 unique, valid plumbers (accepted -> demo_ready).
  for (let i = 1; i <= 90; i++) list.push(plumber(i));

  // Exact duplicate (same provider id + domain) of #1.
  list.push(plumber(1));
  // Same business, different formatting (www + trailing slash, no provider id) -> same domain.
  list.push(
    plumber(2, { providerBusinessId: null, website: "https://www.disco-plumber-2.com.au/" }),
  );
  // Phone-only duplicate: no website/domain, same phone as #3.
  list.push({
    source: "import",
    providerBusinessId: null,
    businessName: "Third Plumbing Co",
    website: null,
    publicPhone: plumber(3).publicPhone,
    locality: "Richmond",
    vertical: "plumbing",
  });

  // Same-name, DIFFERENT locality + different domain -> must NOT be merged (two businesses).
  list.push({
    source: "import",
    providerBusinessId: "smith-rich",
    businessName: "Smith Plumbing",
    website: "https://smith-richmond.com.au",
    publicPhone: "03 9500 0001",
    locality: "Richmond",
    vertical: "plumbing",
  });
  list.push({
    source: "import",
    providerBusinessId: "smith-geel",
    businessName: "Smith Plumbing",
    website: "https://smith-geelong.com.au",
    publicPhone: "03 9500 0002",
    locality: "Geelong",
    vertical: "plumbing",
  });

  // Missing website (name + phone only) -> rejected no_website.
  list.push({
    source: "import",
    providerBusinessId: "nw-1",
    businessName: "No Website Plumbing",
    website: null,
    publicPhone: "03 9500 0003",
    locality: "Richmond",
    vertical: "plumbing",
  });
  // Malformed website -> rejected (unsafe_url/no_website).
  list.push({
    source: "import",
    providerBusinessId: "bad-1",
    businessName: "Malformed Plumbing",
    website: "not a url",
    publicPhone: "03 9500 0004",
    locality: "Richmond",
    vertical: "plumbing",
  });
  // Unsafe private URL -> rejected unsafe_url.
  list.push({
    source: "import",
    providerBusinessId: "ssrf-1",
    businessName: "Internal Plumbing",
    website: "http://10.0.0.5/admin",
    publicPhone: "03 9500 0005",
    locality: "Richmond",
    vertical: "plumbing",
  });
  // 6to4 IPv6 embedding metadata -> rejected unsafe_url (Slice-1 hardened SSRF).
  list.push({
    source: "import",
    providerBusinessId: "ssrf-2",
    businessName: "Metadata Plumbing",
    website: "http://[2002:a9fe:a9fe::]/",
    publicPhone: "03 9500 0006",
    locality: "Richmond",
    vertical: "plumbing",
  });

  // Irrelevant business (not plumbing) -> rejected not_target_vertical.
  list.push({
    source: "import",
    providerBusinessId: "bake-1",
    businessName: "Joe's Bakery",
    website: "https://joesbakery.com.au",
    publicPhone: "03 9500 0007",
    locality: "Richmond",
    vertical: "bakery",
  });
  // Out-of-geography plumber -> rejected outside_geography.
  list.push({
    source: "import",
    providerBusinessId: "syd-1",
    businessName: "Sydney Plumbing",
    website: "https://sydney-plumbing.example.com.au",
    publicPhone: "02 9000 0001",
    locality: "Sydney",
    vertical: "plumbing",
  });

  return list;
}

/** Domains that should successfully build a demo (safe website + in geography + plumbing). */
export function expectedAcceptedDomains(): string[] {
  const domains: string[] = [];
  for (let i = 1; i <= 90; i++) domains.push(`disco-plumber-${i}.com.au`);
  domains.push("smith-richmond.com.au");
  // smith-geelong is out of the Richmond geography and is rejected; sydney too.
  return domains;
}

function siteHtml(name: string, locality: string, phone: string): string {
  const tel = phone.replace(/\s/g, "");
  return `<!doctype html><html><head><title>${name}</title>
<meta name="description" content="${name} — plumbers in ${locality}."></head>
<body><h1>${name}</h1><a href="tel:${tel}">Call ${phone}</a>
<ul><li>Blocked drains</li><li>Hot water systems</li></ul>
<p>Servicing ${locality} and surrounds. 24/7 emergency plumbing.</p></body></html>`;
}

/** Fake fetch that serves a simple plumbing site for each candidate's real (safe) website. */
export function fakeFetchForCandidates(candidates: RawDiscoveryCandidate[]): typeof fetch {
  const byUrl = new Map<string, string>();
  for (const candidate of candidates) {
    if (!candidate.website || !/^https?:\/\//i.test(candidate.website)) continue;
    let origin: string;
    try {
      origin = new URL(candidate.website).origin;
    } catch {
      continue;
    }
    const html = siteHtml(
      candidate.businessName ?? "Plumbing",
      candidate.locality ?? "Richmond",
      candidate.publicPhone ?? "03 9000 0000",
    );
    byUrl.set(`${origin}/`, html);
  }
  const impl = async (input: RequestInfo | URL): Promise<Response> => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const normalized = url.replace(/#.*$/, "");
    const html =
      byUrl.get(normalized) ??
      byUrl.get(`${normalized}/`) ??
      byUrl.get(normalized.replace(/\/$/, "/"));
    if (html === undefined) return new Response("not found", { status: 404 });
    return new Response(html, {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  };
  return impl as unknown as typeof fetch;
}

export const RICHMOND_GEO_TERMS = [GEO, "cremorne", "hawthorn"];
