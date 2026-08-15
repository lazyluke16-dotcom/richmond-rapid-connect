/**
 * Canonical domain + URL normalisation.
 *
 * The canonical domain is the prospect deduplication key: a lowercase host with no
 * scheme, no leading "www.", no port, and no trailing dot. Running research twice on
 * `https://www.ExamplePlumbing.com.au/` and `http://exampleplumbing.com.au` must resolve
 * to the same prospect record (Issue #21 idempotency requirement).
 */

/** Accepts a bare domain or a full URL and returns a normalised https URL string. */
export function normalizeWebsiteInput(raw: string): string {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) throw new Error("A website or domain is required.");
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  const url = new URL(withScheme); // throws on genuinely malformed input
  url.hash = "";
  return url.toString();
}

/** Derive the canonical domain from a URL or bare domain. Throws if none can be derived. */
export function canonicalDomain(raw: string): string {
  const url = new URL(normalizeWebsiteInput(raw));
  let host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (host.startsWith("www.")) host = host.slice(4);
  if (!host || !host.includes(".")) {
    throw new Error(`Could not derive a canonical domain from "${raw}".`);
  }
  return host;
}

/** Best-effort canonical domain that returns null instead of throwing. */
export function tryCanonicalDomain(raw: string): string | null {
  try {
    return canonicalDomain(raw);
  } catch {
    return null;
  }
}

/** A display-friendly business name guess from a domain, used only as a last resort. */
export function displayNameFromDomain(domain: string): string {
  const label = domain.split(".")[0] ?? domain;
  return label
    .split(/[-_]/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}
