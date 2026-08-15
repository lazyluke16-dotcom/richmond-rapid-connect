/**
 * Private demo slug + access token generation.
 *
 * The slug is a human-readable, non-secret label. The token is the unguessable secret:
 * 32 random bytes (256 bits) rendered base64url. Only the SHA-256 hash of the token is
 * ever persisted (see prospect_demo_configs.token_hash), mirroring the outreach
 * unsubscribe-token model, so a database leak cannot reconstruct a working demo link.
 */

const SLUG_MAX = 60;

/** Slugify a business name into the demo slug base (letters/digits/hyphens). */
export function slugifyBusinessName(name: string): string {
  const base = (name ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX)
    .replace(/-+$/g, "");
  // Slug column requires 3-81 chars starting with an alphanumeric.
  if (base.length >= 3) return base;
  return `demo-${base || "prospect"}`.slice(0, SLUG_MAX);
}

/** A short random suffix so slugs stay unlisted/unguessable even for similar names. */
export function randomSlugSuffix(bytes = 4): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function buildDemoSlug(businessName: string): string {
  return `${slugifyBusinessName(businessName)}-${randomSlugSuffix()}`.slice(0, 81);
}

/** 256-bit URL-safe access token. Return value is shown ONCE; only its hash is stored. */
export function generateDemoToken(): string {
  const buf = new Uint8Array(32);
  crypto.getRandomValues(buf);
  let binary = "";
  for (const byte of buf) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

/** Hex SHA-256 of a token, matching the token_hash CHECK (`^[a-f0-9]{64}$`). */
export async function hashDemoToken(token: string): Promise<string> {
  const data = new TextEncoder().encode(token);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Constant-time-ish comparison of two equal-length hex hashes. Both inputs are hashes
 * (fixed length, non-secret-derivable), but we still avoid early-exit to be safe.
 */
export function timingSafeHexEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
