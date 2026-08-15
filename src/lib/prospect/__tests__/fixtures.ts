/**
 * Representative AU plumbing-business fixtures for reliability testing.
 *
 * These are SYNTHETIC fixtures, not live businesses — clearly distinguished from any
 * real-business evidence. Each returns HTML for its pages, keyed by URL, so a fake fetch
 * can serve a whole site. They deliberately vary completeness (missing hours, no phone,
 * conflicting phones, existing AI receptionist, malformed markup, sparse content) to
 * exercise fail-closed and anti-hallucination behaviour across the pipeline.
 */

export interface SiteFixture {
  name: string;
  origin: string;
  /** Map of absolute URL -> HTML. The origin root ("/") must be present. */
  pages: Record<string, string>;
  /** Expectations used by the reliability report (not business facts). */
  expect: {
    minServices: number;
    hasPhone: boolean;
    emergency: "yes" | "no" | "UNKNOWN";
    hoursKnown: boolean;
  };
}

function page(opts: {
  title: string;
  name?: string;
  themeColor?: string;
  jsonLd?: Record<string, unknown>;
  bodyServices?: string[];
  phoneTel?: string;
  phoneText?: string;
  emergency?: boolean;
  areas?: string[];
  logo?: boolean;
  favicon?: boolean;
  ai?: boolean;
  positioning?: string;
  extra?: string;
}): string {
  const jsonLd = opts.jsonLd
    ? `<script type="application/ld+json">${JSON.stringify(opts.jsonLd)}</script>`
    : "";
  const theme = opts.themeColor ? `<meta name="theme-color" content="${opts.themeColor}">` : "";
  const favicon = opts.favicon ? `<link rel="icon" href="/favicon.ico">` : "";
  const logo = opts.logo
    ? `<img class="site-logo" alt="${opts.name ?? "logo"} logo" src="/logo.png">`
    : "";
  const tel = opts.phoneTel ? `<a href="tel:${opts.phoneTel}">Call ${opts.phoneTel}</a>` : "";
  const phoneText = opts.phoneText ? `<p>Phone us on ${opts.phoneText}</p>` : "";
  const services = (opts.bodyServices ?? []).map((s) => `<li>${s}</li>`).join("");
  const emergency = opts.emergency ? `<p>24/7 emergency plumbing available.</p>` : "";
  const areas = opts.areas?.length ? `<p>Areas we service: ${opts.areas.join(", ")}.</p>` : "";
  const ai = opts.ai ? `<div data-widget="ai receptionist chatbot"></div>` : "";
  const positioning = opts.positioning
    ? `<meta name="description" content="${opts.positioning}">`
    : "";
  return `<!doctype html><html><head><title>${opts.title}</title>${positioning}${theme}${favicon}${jsonLd}</head>
<body><header>${logo}</header><h1>${opts.name ?? opts.title}</h1>${positioning ? `<p>${opts.positioning}</p>` : ""}
${tel}${phoneText}<ul>${services}</ul>${emergency}${areas}${ai}${opts.extra ?? ""}</body></html>`;
}

function localBusinessLd(
  name: string,
  phone?: string,
  suburb?: string,
  hours?: string,
): Record<string, unknown> {
  const node: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "Plumber",
    name,
  };
  if (phone) node.telephone = phone;
  if (suburb)
    node.address = { "@type": "PostalAddress", addressLocality: suburb, addressRegion: "VIC" };
  if (hours) node.openingHours = hours;
  return node;
}

const AU_SUBURBS = [
  "Richmond",
  "Cremorne",
  "Hawthorn",
  "Kew",
  "Abbotsford",
  "Fitzroy",
  "Prahran",
  "St Kilda",
];
const SERVICE_POOL = [
  "Blocked drains and drain cleaning",
  "Hot water system repairs",
  "Burst pipe and leaking pipe repair",
  "Gas fitting and gas leak repair",
  "Toilet repairs and blocked toilet",
  "Tap and mixer repairs",
  "Roof and gutter plumbing",
  "Sewer and stormwater",
  "CCTV drain camera inspection",
  "Bathroom renovation plumbing",
];

/** Build the 25 representative fixtures deterministically. */
export function buildFixtures(): SiteFixture[] {
  const fixtures: SiteFixture[] = [];
  for (let i = 0; i < 25; i++) {
    const n = i + 1;
    const domain = `exampleplumbing${n}.com.au`;
    const origin = `https://${domain}`;
    const name = `Example Plumbing ${n}`;
    const services = SERVICE_POOL.slice(0, 2 + (i % 6)); // 2..7 services
    const suburb = AU_SUBURBS[i % AU_SUBURBS.length];
    const areas = AU_SUBURBS.slice(0, 1 + (i % 4));
    const emergency = i % 3 !== 0; // ~2/3 have emergency
    const hasPhone = i % 5 !== 0; // 4/5 have a phone
    const hasHours = i % 4 === 0; // 1/4 publish hours
    const useJsonLd = i % 2 === 0;
    const phone = `03 9${(1000000 + n).toString().slice(0, 7)}`;
    const ai = i % 7 === 0; // a few have an existing AI receptionist

    const home = page({
      title: `${name} | Local Plumbers ${suburb}`,
      name,
      themeColor: ["#0b5", "#1d4ed8", "#c0392b", "#0f766e"][i % 4],
      positioning: `${name} — fast, reliable plumbers serving ${suburb} and surrounds.`,
      jsonLd: useJsonLd
        ? localBusinessLd(
            name,
            hasPhone ? phone : undefined,
            suburb,
            hasHours ? "Mo-Fr 08:00-17:00" : undefined,
          )
        : undefined,
      bodyServices: services,
      phoneTel: hasPhone && !useJsonLd ? phone.replace(/\s/g, "") : undefined,
      phoneText: hasPhone && i % 2 === 1 ? phone : undefined,
      emergency,
      areas,
      logo: i % 2 === 0,
      favicon: true,
      ai,
    });

    const servicesPage = page({
      title: `Services | ${name}`,
      name,
      bodyServices: services,
      areas,
    });

    const pages: Record<string, string> = {
      [`${origin}/`]: home,
      [`${origin}/services`]: `${servicesPage}`,
    };
    // Link the services page from the homepage so discovery finds it.
    pages[`${origin}/`] = home.replace("<header>", `<header><a href="/services">Our services</a>`);

    fixtures.push({
      name,
      origin,
      pages,
      expect: {
        minServices: Math.min(2, services.length),
        hasPhone,
        emergency: emergency ? "yes" : "UNKNOWN",
        hoursKnown: hasHours && useJsonLd,
      },
    });
  }
  return fixtures;
}

/** A fixture with two DIFFERENT phone numbers across pages, to test conflict detection. */
export function conflictingPhoneFixture(): SiteFixture {
  const origin = "https://conflictingplumber.com.au";
  return {
    name: "Conflicting Plumber",
    origin,
    pages: {
      [`${origin}/`]: page({
        title: "Conflicting Plumber",
        name: "Conflicting Plumber",
        jsonLd: localBusinessLd("Conflicting Plumber", "03 9111 1111", "Richmond"),
        bodyServices: ["Blocked drains"],
        extra: `<a href="/contact">Contact</a>`,
      }),
      [`${origin}/contact`]: page({
        title: "Contact | Conflicting Plumber",
        name: "Conflicting Plumber",
        jsonLd: localBusinessLd("Conflicting Plumber", "03 9222 2222", "Richmond"),
      }),
    },
    expect: { minServices: 1, hasPhone: true, emergency: "UNKNOWN", hoursKnown: false },
  };
}

/** Build a fake fetch that serves a set of fixtures (by absolute URL). */
export function fakeFetchFor(fixtures: SiteFixture[]): typeof fetch {
  const byUrl = new Map<string, string>();
  for (const fixture of fixtures) {
    for (const [url, html] of Object.entries(fixture.pages)) byUrl.set(url, html);
  }
  const impl = async (input: RequestInfo | URL): Promise<Response> => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const normalized = url.replace(/#.*$/, "");
    const html =
      byUrl.get(normalized) ??
      byUrl.get(normalized.replace(/\/$/, "")) ??
      byUrl.get(`${normalized}/`);
    if (html === undefined) {
      return new Response("not found", { status: 404 });
    }
    return new Response(html, {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  };
  return impl as unknown as typeof fetch;
}

/** A fake DNS lookup that treats all fixture hosts as public. */
export const publicDnsLookup = async (): Promise<string[]> => ["203.0.113.10"].filter(() => false);
