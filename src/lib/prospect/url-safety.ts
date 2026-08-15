/**
 * SSRF protection for the research/enrichment layer.
 *
 * The enrichment layer fetches attacker-influenced URLs (a prospect website supplied by
 * an operator, plus links discovered on that site). These helpers are the single gate
 * that decides whether a URL may be fetched. They are pure and exhaustively unit-tested;
 * the network layer in safe-fetch.ts must call {@link assertFetchableUrl} for the
 * initial URL AND for every redirect target before connecting.
 *
 * Policy:
 *   - only http/https
 *   - no embedded credentials (user:pass@host)
 *   - only ports 80/443 (or scheme default)
 *   - hostname must not be localhost / a private-use TLD / an IP literal in a private,
 *     loopback, link-local, unique-local, reserved or otherwise non-public range
 *   - IPv6 literals are rejected unless demonstrably global unicast
 *
 * Because `fetch` performs its own DNS resolution (creating a DNS-rebinding gap for
 * hostnames), safe-fetch.ts additionally resolves the hostname and re-validates every
 * resolved address against {@link isPublicIpAddress} where a resolver is available.
 */

export type UrlRejectionReason =
  | "invalid_url"
  | "protocol_not_allowed"
  | "credentials_not_allowed"
  | "port_not_allowed"
  | "hostname_not_allowed"
  | "private_address"
  | "unsupported_ip";

export class UnsafeUrlError extends Error {
  readonly reason: UrlRejectionReason;
  constructor(reason: UrlRejectionReason, message: string) {
    super(message);
    this.name = "UnsafeUrlError";
    this.reason = reason;
  }
}

const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);
const ALLOWED_PORTS = new Set(["", "80", "443"]);

/** Hostnames that must never be resolved/fetched, regardless of DNS. */
const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "ip6-localhost",
  "ip6-loopback",
  "metadata", // GCP metadata short name
  "metadata.google.internal",
]);

/** Suffixes that indicate private/internal scope. */
const BLOCKED_HOST_SUFFIXES = [
  ".localhost",
  ".local",
  ".internal",
  ".intranet",
  ".lan",
  ".home.arpa",
];

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

export function isIpv4(host: string): boolean {
  const match = IPV4_RE.exec(host);
  if (!match) return false;
  return match.slice(1).every((part) => {
    const value = Number(part);
    return value >= 0 && value <= 255 && String(value) === part.replace(/^0+(?=\d)/, "");
  });
}

/** True only for public (globally routable) IPv4 addresses. */
export function isPublicIpv4(host: string): boolean {
  const match = IPV4_RE.exec(host);
  if (!match) return false;
  const [a, b, c, d] = match.slice(1).map(Number);
  if ([a, b, c, d].some((n) => n < 0 || n > 255)) return false;
  if (a === 0) return false; // 0.0.0.0/8 "this network"
  if (a === 10) return false; // 10/8 private
  if (a === 127) return false; // loopback
  if (a === 169 && b === 254) return false; // link-local / cloud metadata (169.254.169.254)
  if (a === 172 && b >= 16 && b <= 31) return false; // 172.16/12 private
  if (a === 192 && b === 168) return false; // 192.168/16 private
  if (a === 192 && b === 0 && c === 0) return false; // 192.0.0.0/24 IETF
  if (a === 192 && b === 0 && c === 2) return false; // TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return false; // 198.18/15 benchmarking
  if (a === 198 && b === 51 && c === 100) return false; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return false; // TEST-NET-3
  if (a === 100 && b >= 64 && b <= 127) return false; // 100.64/10 CGNAT
  if (a >= 224) return false; // 224/4 multicast + 240/4 reserved + 255.255.255.255
  return true;
}

/**
 * True only for public IPv6 addresses. Conservative: only 2000::/3 global unicast is
 * allowed, and IPv4-mapped/compat forms are rejected outright.
 */
export function isPublicIpv6(host: string): boolean {
  const raw = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  const lower = raw.toLowerCase();
  if (!lower.includes(":")) return false;
  if (lower === "::1" || lower === "::") return false; // loopback / unspecified
  if (
    lower.startsWith("fe8") ||
    lower.startsWith("fe9") ||
    lower.startsWith("fea") ||
    lower.startsWith("feb")
  )
    return false; // fe80::/10 link-local
  if (lower.startsWith("fc") || lower.startsWith("fd")) return false; // fc00::/7 unique-local
  if (lower.startsWith("ff")) return false; // ff00::/8 multicast
  if (lower.startsWith("::ffff:") || lower.startsWith("::0.") || lower.includes("::ffff:"))
    return false; // IPv4-mapped
  if (lower.startsWith("64:ff9b:")) return false; // NAT64
  if (lower.startsWith("2001:db8")) return false; // documentation
  // 6to4 (2002::/16) and Teredo (2001:0000::/32) embed an arbitrary IPv4 address, so a
  // literal here can reach a private/loopback/metadata IPv4 (e.g. 2002:a9fe:a9fe:: -> the
  // 169.254.169.254 metadata address). They fall inside 2000::/3, so the global-unicast
  // whitelist below would otherwise accept them. Reject outright.
  if (lower.startsWith("2002:")) return false; // 6to4
  if (lower.startsWith("2001:0:") || lower.startsWith("2001::")) return false; // Teredo 2001:0000::/32
  // Global unicast 2000::/3 -> first hextet 2000-3fff.
  const firstHextet = parseInt(lower.split(":")[0] || "0", 16);
  return firstHextet >= 0x2000 && firstHextet <= 0x3fff;
}

/** Whether a raw IP literal (v4 or bracketed/plain v6) is public. */
export function isPublicIpAddress(host: string): boolean {
  if (isIpv4(host)) return isPublicIpv4(host);
  if (host.includes(":")) return isPublicIpv6(host);
  return false;
}

export function isBlockedHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (BLOCKED_HOSTNAMES.has(host)) return true;
  return BLOCKED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

/**
 * Validate and normalise a URL for fetching. Throws {@link UnsafeUrlError} on any
 * violation; returns the parsed URL on success.
 */
export function assertFetchableUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new UnsafeUrlError("invalid_url", "URL could not be parsed.");
  }

  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    throw new UnsafeUrlError("protocol_not_allowed", `Protocol "${url.protocol}" is not allowed.`);
  }
  if (url.username || url.password) {
    throw new UnsafeUrlError(
      "credentials_not_allowed",
      "URLs with embedded credentials are rejected.",
    );
  }
  if (!ALLOWED_PORTS.has(url.port)) {
    throw new UnsafeUrlError("port_not_allowed", `Port "${url.port}" is not allowed.`);
  }

  const hostname = url.hostname.toLowerCase();
  if (!hostname) {
    throw new UnsafeUrlError("hostname_not_allowed", "URL has no hostname.");
  }
  if (isBlockedHostname(hostname)) {
    throw new UnsafeUrlError("hostname_not_allowed", `Hostname "${hostname}" is not permitted.`);
  }

  // IP literals (v4, or bracketed/plain v6) must be provably public.
  const isBracketedV6 = hostname.startsWith("[") && hostname.endsWith("]");
  const bareHost = isBracketedV6 ? hostname.slice(1, -1) : hostname;
  if (isIpv4(bareHost)) {
    if (!isPublicIpv4(bareHost)) {
      throw new UnsafeUrlError("private_address", `IP address "${bareHost}" is not public.`);
    }
    return url;
  }
  if (isBracketedV6 || (bareHost.includes(":") && !bareHost.includes("."))) {
    if (!isPublicIpv6(bareHost)) {
      throw new UnsafeUrlError("private_address", `IPv6 address "${bareHost}" is not public.`);
    }
    return url;
  }

  // Registrable hostname: require at least one dot and a plausible TLD.
  if (!hostname.includes(".") || hostname.endsWith(".")) {
    throw new UnsafeUrlError(
      "hostname_not_allowed",
      `Hostname "${hostname}" is not a public domain.`,
    );
  }
  return url;
}

/** Non-throwing convenience wrapper. */
export function isFetchableUrl(rawUrl: string): boolean {
  try {
    assertFetchableUrl(rawUrl);
    return true;
  } catch {
    return false;
  }
}
