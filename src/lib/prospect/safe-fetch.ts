/**
 * Bounded, SSRF-aware HTTP fetcher for the enrichment layer.
 *
 * Guarantees:
 *   - every URL (initial and every redirect hop) passes {@link assertFetchableUrl}
 *   - the hostname is resolved and every resolved address is re-validated as public
 *     where a DNS resolver is available (DNS-rebinding defence)
 *   - redirects are followed manually with a hop cap, never automatically
 *   - a wall-clock timeout aborts the request
 *   - the response body is streamed and truncated at a byte cap
 *   - only an allow-listed set of content types is returned
 *
 * The underlying `fetch` and DNS `lookup` are injectable so unit tests can exercise the
 * safety envelope without real network access, and so callers can supply a runtime-
 * appropriate resolver.
 */
import { assertFetchableUrl, isPublicIpAddress, UnsafeUrlError } from "./url-safety";

export interface SafeFetchOptions {
  /** Wall-clock timeout in milliseconds (default 8000). */
  timeoutMs?: number;
  /** Maximum bytes read from the body before truncation (default 3 MiB). */
  maxBytes?: number;
  /** Maximum redirect hops to follow (default 3). */
  maxRedirects?: number;
  /** Allowed response content-type prefixes (default: html + common image types). */
  allowedContentTypes?: string[];
  /** Injectable fetch (defaults to global fetch). */
  fetchImpl?: typeof fetch;
  /** Injectable DNS resolver returning resolved IP strings. Omit to skip DNS guard. */
  dnsLookup?: (hostname: string) => Promise<string[]>;
  /** Accept header sent with the request. */
  accept?: string;
}

export interface SafeFetchResult {
  finalUrl: string;
  status: number;
  contentType: string;
  bytes: Uint8Array;
  truncated: boolean;
}

export class SafeFetchError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "SafeFetchError";
    this.code = code;
  }
}

const DEFAULT_ALLOWED = ["text/html", "application/xhtml+xml", "text/plain", "image/"];

/** Resolve a hostname via node:dns if available; returns [] when no resolver exists. */
export async function defaultDnsLookup(hostname: string): Promise<string[]> {
  try {
    const dns = await import("node:dns/promises");
    const records = await dns.lookup(hostname, { all: true });
    return records.map((r) => r.address);
  } catch {
    // Resolver unavailable (e.g. edge runtime) — caller decides whether to proceed.
    return [];
  }
}

async function guardDns(hostname: string, lookup: (h: string) => Promise<string[]>): Promise<void> {
  // IP literals are already validated by assertFetchableUrl.
  if (/^[0-9.]+$/.test(hostname) || hostname.includes(":")) return;
  let addresses: string[] = [];
  try {
    addresses = await lookup(hostname);
  } catch {
    return; // resolver failure is non-fatal; assertFetchableUrl already blocked literals
  }
  for (const address of addresses) {
    if (!isPublicIpAddress(address)) {
      throw new SafeFetchError(
        "private_address",
        `Hostname "${hostname}" resolves to non-public address "${address}".`,
      );
    }
  }
}

async function readCapped(
  response: Response,
  maxBytes: number,
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  const body = response.body;
  if (!body) {
    const buf = new Uint8Array(await response.arrayBuffer());
    return buf.byteLength > maxBytes
      ? { bytes: buf.slice(0, maxBytes), truncated: true }
      : { bytes: buf, truncated: false };
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      chunks.push(value.slice(0, value.byteLength - (total - maxBytes)));
      truncated = true;
      await reader.cancel().catch(() => {});
      break;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, truncated };
}

export async function safeFetch(
  rawUrl: string,
  options: SafeFetchOptions = {},
): Promise<SafeFetchResult> {
  const {
    timeoutMs = 8000,
    maxBytes = 3 * 1024 * 1024,
    maxRedirects = 3,
    allowedContentTypes = DEFAULT_ALLOWED,
    fetchImpl = fetch,
    dnsLookup = defaultDnsLookup,
    accept = "text/html,application/xhtml+xml,text/plain;q=0.9,image/*;q=0.5,*/*;q=0.1",
  } = options;

  let currentUrl = assertFetchableUrl(rawUrl).toString();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    for (let hop = 0; hop <= maxRedirects; hop++) {
      const parsed = assertFetchableUrl(currentUrl);
      await guardDns(parsed.hostname, dnsLookup);

      let response: Response;
      try {
        response = await fetchImpl(currentUrl, {
          method: "GET",
          redirect: "manual",
          signal: controller.signal,
          headers: {
            Accept: accept,
            "User-Agent": "RichmondRapidConnect-ProspectResearch/1.0 (+demo)",
          },
        });
      } catch (cause) {
        if (cause instanceof UnsafeUrlError || cause instanceof SafeFetchError) throw cause;
        throw new SafeFetchError("network_error", "Upstream request failed.");
      }

      // Manual redirect handling with per-hop re-validation.
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location)
          throw new SafeFetchError("bad_redirect", "Redirect without a Location header.");
        if (hop === maxRedirects)
          throw new SafeFetchError("too_many_redirects", "Redirect limit exceeded.");
        currentUrl = assertFetchableUrl(new URL(location, currentUrl).toString()).toString();
        continue;
      }

      if (!response.ok) {
        throw new SafeFetchError("http_error", `Upstream responded ${response.status}.`);
      }

      const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
      if (!allowedContentTypes.some((prefix) => contentType.startsWith(prefix))) {
        throw new SafeFetchError(
          "content_type_not_allowed",
          `Content type "${contentType}" is not allowed.`,
        );
      }

      const declaredLength = Number(response.headers.get("content-length") ?? "0");
      if (declaredLength && declaredLength > maxBytes) {
        throw new SafeFetchError(
          "too_large",
          `Declared body of ${declaredLength} bytes exceeds cap.`,
        );
      }

      const { bytes, truncated } = await readCapped(response, maxBytes);
      return { finalUrl: currentUrl, status: response.status, contentType, bytes, truncated };
    }
    throw new SafeFetchError("too_many_redirects", "Redirect limit exceeded.");
  } finally {
    clearTimeout(timer);
  }
}
