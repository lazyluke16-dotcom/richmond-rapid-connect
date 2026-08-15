/**
 * Deterministic HTML → candidate-fact extraction.
 *
 * This is the primary, dependency-free understanding layer. It is fully deterministic
 * and testable: given the same HTML it always yields the same candidates. It NEVER
 * invents a value — it only reports what is present in the markup, with the exact text
 * context that supports it, so evidence.ts can attach provenance. Structured data
 * (schema.org JSON-LD) is preferred over visible-text heuristics and carries higher
 * confidence. Where a signal is absent, it is simply omitted (→ unknown downstream).
 */

export interface RawCandidate {
  value: string;
  context: string;
  /** Relative source strength used to seed confidence (0..1). */
  strength: number;
  extractor: "deterministic-html" | "structured-data";
}

export interface RawExtraction {
  businessNames: RawCandidate[];
  services: RawCandidate[];
  serviceAreas: RawCandidate[];
  phones: RawCandidate[];
  addresses: RawCandidate[];
  openingHours: RawCandidate[];
  emergency: RawCandidate[];
  positioning: RawCandidate[];
  themeColours: string[];
  logoUrls: RawCandidate[];
  faviconUrls: RawCandidate[];
  aiReceptionistSignals: RawCandidate[];
}

/** Canonical plumbing services and the surface forms that evidence them. */
const SERVICE_VOCABULARY: { canonical: string; patterns: RegExp }[] = [
  {
    canonical: "Blocked drains",
    patterns: /\b(blocked|clogged)\s+drain|drain\s+cleaning|drain\s+unblocking\b/i,
  },
  { canonical: "Hot water systems", patterns: /\bhot\s+water\b/i },
  { canonical: "Burst pipes", patterns: /\bburst\s+pipe|pipe\s+repair|leaking\s+pipe\b/i },
  { canonical: "Leak detection", patterns: /\bleak\s+detection|water\s+leak\b/i },
  { canonical: "Gas fitting", patterns: /\bgas\s+fitt|gas\s+plumb|gas\s+leak\b/i },
  {
    canonical: "Toilet repairs",
    patterns: /\btoilet\s+(repair|install|replace)|blocked\s+toilet\b/i,
  },
  {
    canonical: "Tap and mixer repairs",
    patterns: /\b(tap|faucet|mixer)\s+(repair|install|replace)|dripping\s+tap\b/i,
  },
  { canonical: "Roof and gutter", patterns: /\b(roof|gutter)\s+(plumb|leak|repair)\b/i },
  { canonical: "Sewer and stormwater", patterns: /\b(sewer|stormwater|storm\s+water)\b/i },
  { canonical: "Drain cameras (CCTV)", patterns: /\b(cctv|drain\s+camera|pipe\s+inspection)\b/i },
  { canonical: "Backflow prevention", patterns: /\bbackflow\b/i },
  { canonical: "Water filtration", patterns: /\bwater\s+filt/i },
  {
    canonical: "Renovations and bathrooms",
    patterns: /\b(bathroom|kitchen)\s+(renovation|plumb)|renovation\s+plumb\b/i,
  },
  {
    canonical: "Dishwasher and appliance install",
    patterns: /\b(dishwasher|appliance)\s+(install|connect)\b/i,
  },
];

const AU_STATES =
  /\b(NSW|VIC|QLD|SA|WA|TAS|NT|ACT|New South Wales|Victoria|Queensland|South Australia|Western Australia|Tasmania|Northern Territory)\b/;

function stripTags(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function attr(tag: string, name: string): string | null {
  const re = new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i");
  const m = re.exec(tag);
  if (!m) return null;
  return (m[2] ?? m[3] ?? m[4] ?? "").trim() || null;
}

function firstContext(text: string, index: number, span = 120): string {
  const start = Math.max(0, index - span / 2);
  return text.slice(start, start + span).trim();
}

/** Parse and merge all JSON-LD blocks into a flat list of nodes. */
function parseJsonLd(html: string): Record<string, unknown>[] {
  const nodes: Record<string, unknown>[] = [];
  const re = /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html))) {
    try {
      const parsed = JSON.parse(match[1].trim());
      const flatten = (node: unknown): void => {
        if (Array.isArray(node)) node.forEach(flatten);
        else if (node && typeof node === "object") {
          nodes.push(node as Record<string, unknown>);
          const graph = (node as Record<string, unknown>)["@graph"];
          if (Array.isArray(graph)) graph.forEach(flatten);
        }
      };
      flatten(parsed);
    } catch {
      // Malformed JSON-LD is ignored rather than trusted.
    }
  }
  return nodes;
}

function asString(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number") return String(value);
  return null;
}

export function extractFromHtml(html: string, pageUrl: string): RawExtraction {
  const out: RawExtraction = {
    businessNames: [],
    services: [],
    serviceAreas: [],
    phones: [],
    addresses: [],
    openingHours: [],
    emergency: [],
    positioning: [],
    themeColours: [],
    logoUrls: [],
    faviconUrls: [],
    aiReceptionistSignals: [],
  };
  const text = stripTags(html);
  const seen = new Set<string>();
  const push = (
    list: RawCandidate[],
    value: string,
    context: string,
    strength: number,
    extractor: RawCandidate["extractor"],
  ) => {
    const key = `${list === out.services ? "svc" : list === out.serviceAreas ? "area" : "x"}:${value.toLowerCase()}`;
    const norm = value.trim();
    if (!norm) return;
    if (seen.has(`${extractor}:${key}`)) return;
    seen.add(`${extractor}:${key}`);
    list.push({ value: norm, context: context.slice(0, 300), strength, extractor });
  };

  // --- Structured data (highest confidence) ---
  for (const node of parseJsonLd(html)) {
    const type = String(node["@type"] ?? "").toLowerCase();
    const looksLikeBusiness =
      type.includes("plumber") ||
      type.includes("localbusiness") ||
      type.includes("organization") ||
      type.includes("homeandconstructionbusiness");
    if (!looksLikeBusiness) continue;
    const name = asString(node.name);
    if (name) push(out.businessNames, name, "schema.org name", 0.97, "structured-data");
    const phone = asString(node.telephone);
    if (phone) push(out.phones, phone, "schema.org telephone", 0.95, "structured-data");
    const address = node.address;
    if (address && typeof address === "object") {
      const a = address as Record<string, unknown>;
      const parts = [a.streetAddress, a.addressLocality, a.addressRegion, a.postalCode]
        .map(asString)
        .filter(Boolean);
      if (parts.length)
        push(out.addresses, parts.join(", "), "schema.org address", 0.95, "structured-data");
    }
    const areaServed = node.areaServed;
    const areaList = Array.isArray(areaServed) ? areaServed : areaServed ? [areaServed] : [];
    for (const area of areaList) {
      const label =
        typeof area === "string" ? area : asString((area as Record<string, unknown>)?.name);
      if (label) push(out.serviceAreas, label, "schema.org areaServed", 0.9, "structured-data");
    }
    const hours = node.openingHours ?? node.openingHoursSpecification;
    if (hours) {
      const label = Array.isArray(hours)
        ? hours.map((h) => asString(h) ?? JSON.stringify(h)).join("; ")
        : (asString(hours) ?? JSON.stringify(hours));
      if (label)
        push(
          out.openingHours,
          label.slice(0, 300),
          "schema.org openingHours",
          0.9,
          "structured-data",
        );
    }
    const logo = asString(node.logo) ?? asString((node.logo as Record<string, unknown>)?.url);
    if (logo)
      push(out.logoUrls, resolveUrl(logo, pageUrl), "schema.org logo", 0.9, "structured-data");
    const makesOffer = node.makesOffer ?? node.hasOfferCatalog;
    if (makesOffer) {
      const blob = JSON.stringify(makesOffer);
      matchServices(blob).forEach((svc) =>
        push(out.services, svc.canonical, "schema.org offer", 0.85, "structured-data"),
      );
    }
  }

  // --- <head> signals ---
  const headTags =
    html.match(/<meta\b[^>]*>|<title\b[^>]*>[\s\S]*?<\/title>|<link\b[^>]*>/gi) ?? [];
  for (const tag of headTags) {
    if (/^<title/i.test(tag)) {
      const value = stripTags(tag);
      // Title-derived names are weak (kept below the conflict threshold): a page title
      // is a noisy source of the true business name compared to schema.org / og:site_name.
      if (value)
        push(out.businessNames, cleanTitle(value), "document title", 0.55, "deterministic-html");
    }
    if (/^<meta/i.test(tag)) {
      const property = (attr(tag, "property") ?? attr(tag, "name") ?? "").toLowerCase();
      const content = attr(tag, "content");
      if (!content) continue;
      if (property === "og:site_name")
        push(out.businessNames, content, "og:site_name", 0.75, "deterministic-html");
      if (property === "og:title")
        push(out.businessNames, cleanTitle(content), "og:title", 0.55, "deterministic-html");
      if (property === "description" || property === "og:description")
        push(out.positioning, content, `meta ${property}`, 0.6, "deterministic-html");
      if (property === "theme-color" && /^#[0-9a-f]{6}$/i.test(content.trim()))
        out.themeColours.push(content.trim().toLowerCase());
      if (property === "og:image")
        push(out.logoUrls, resolveUrl(content, pageUrl), "og:image", 0.5, "deterministic-html");
    }
    if (/^<link/i.test(tag)) {
      const rel = (attr(tag, "rel") ?? "").toLowerCase();
      const href = attr(tag, "href");
      if (!href) continue;
      if (rel.includes("icon"))
        push(
          out.faviconUrls,
          resolveUrl(href, pageUrl),
          `link rel="${rel}"`,
          0.8,
          "deterministic-html",
        );
    }
  }

  // --- Logo <img> heuristics ---
  const imgTags = html.match(/<img\b[^>]*>/gi) ?? [];
  for (const tag of imgTags) {
    const cls = (attr(tag, "class") ?? "").toLowerCase();
    const alt = (attr(tag, "alt") ?? "").toLowerCase();
    const id = (attr(tag, "id") ?? "").toLowerCase();
    const src = attr(tag, "src") ?? attr(tag, "data-src");
    if (!src) continue;
    if (/logo|brand/.test(cls) || /logo/.test(alt) || /logo/.test(id)) {
      push(
        out.logoUrls,
        resolveUrl(src, pageUrl),
        `<img> logo (${alt || cls || id})`,
        0.7,
        "deterministic-html",
      );
    }
  }

  // --- Phone numbers (tel: links strongest, then AU patterns in text) ---
  const telLinks = html.match(/href\s*=\s*["']tel:([^"']+)["']/gi) ?? [];
  for (const link of telLinks) {
    const num = /tel:([^"']+)/i.exec(link)?.[1];
    if (num) push(out.phones, num.trim(), "tel: link", 0.9, "deterministic-html");
  }
  const phoneRe = /(?:\+?61\s?|\b0)[2-478](?:[\s-]?\d){8}\b|\b1[38]00[\s-]?\d{3}[\s-]?\d{3}\b/g;
  let pm: RegExpExecArray | null;
  while ((pm = phoneRe.exec(text))) {
    push(out.phones, pm[0].trim(), firstContext(text, pm.index), 0.65, "deterministic-html");
  }

  // --- Services from visible text ---
  for (const svc of matchServices(text)) {
    push(out.services, svc.canonical, svc.context, 0.7, "deterministic-html");
  }

  // --- Emergency / after-hours availability ---
  const emergencyRe =
    /\b(24\/7|24[\s-]?hours?|around the clock|after[\s-]?hours|emergency (?:plumb|call|service)|same[\s-]?day)\b/i;
  const em = emergencyRe.exec(text);
  if (em) push(out.emergency, "yes", firstContext(text, em.index), 0.75, "deterministic-html");

  // --- Service areas from "areas we service" style copy + AU state hints ---
  const areaSectionRe =
    /(?:areas?\s+we\s+(?:service|serve|cover)|suburbs?\s+we\s+(?:service|cover)|service\s+areas?|proudly\s+serving)[:\s]([^.]{0,240})/i;
  const areaMatch = areaSectionRe.exec(text);
  if (areaMatch) {
    for (const token of splitAreaList(areaMatch[1])) {
      push(
        out.serviceAreas,
        token,
        `service-area copy: "${areaMatch[1].trim().slice(0, 120)}"`,
        0.6,
        "deterministic-html",
      );
    }
  }
  const stateMatch = AU_STATES.exec(text);
  if (stateMatch && out.serviceAreas.length === 0) {
    push(
      out.serviceAreas,
      stateMatch[0],
      firstContext(text, stateMatch.index),
      0.4,
      "deterministic-html",
    );
  }

  // --- Positioning fallback: first heading ---
  const h1 = /<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(html);
  if (h1) {
    const value = stripTags(h1[1]);
    if (value) push(out.positioning, value, "h1 heading", 0.5, "deterministic-html");
  }

  // --- Existing AI receptionist / chat-bot detection (a scoring signal) ---
  const aiRe =
    /\b(vapi|retell|ai\s+receptionist|virtual\s+receptionist|answering\s+bot|chatbot|voiceflow|synthflow)\b/i;
  const aiMatch = aiRe.exec(html);
  if (aiMatch)
    push(
      out.aiReceptionistSignals,
      aiMatch[0],
      firstContext(stripTags(html), aiMatch.index),
      0.6,
      "deterministic-html",
    );

  return out;
}

function matchServices(text: string): { canonical: string; context: string }[] {
  const results: { canonical: string; context: string }[] = [];
  for (const entry of SERVICE_VOCABULARY) {
    const m = entry.patterns.exec(text);
    if (m) results.push({ canonical: entry.canonical, context: firstContext(text, m.index) });
  }
  return results;
}

function splitAreaList(raw: string): string[] {
  return raw
    .split(/[,/&]|\band\b|·|\|/i)
    .map((token) => token.replace(/[^A-Za-z\s'-]/g, "").trim())
    .filter((token) => token.length >= 3 && token.length <= 40 && /[a-z]/i.test(token))
    .slice(0, 20);
}

const GENERIC_TITLE_SEGMENT =
  /^(home|homepage|services?|our services|contact( us)?|about( us)?|blog|gallery|reviews|testimonials|book( now)?|welcome|plumbers?|local plumbers?)$/i;

function cleanTitle(title: string): string {
  // Split "Brand | Tagline" / "Services | Brand" style titles and choose the segment
  // most likely to be the business name (dropping generic page labels).
  const segments = title
    .split(/[|·–—\-:•»]/)
    .map((segment) => segment.trim())
    .filter(Boolean);
  if (segments.length <= 1) return title.trim();
  const meaningful = segments.filter((segment) => !GENERIC_TITLE_SEGMENT.test(segment));
  if (meaningful.length === 0) return segments[0];
  // Prefer the shortest meaningful segment — brand names are typically shorter than
  // descriptive taglines like "Blocked Drains & Hot Water Specialists".
  return meaningful.sort((a, b) => a.length - b.length)[0];
}

function resolveUrl(href: string, base: string): string {
  try {
    return new URL(href, base).toString();
  } catch {
    return href;
  }
}

export { SERVICE_VOCABULARY };
