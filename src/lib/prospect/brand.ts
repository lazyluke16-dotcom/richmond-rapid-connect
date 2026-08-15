/**
 * Brand extraction with safe fallbacks.
 *
 * Chooses a display name, a logo (preferring a schema/`<img>` logo, then favicon), and a
 * colour treatment (theme-color / extracted brand hexes, else a neutral default palette).
 * Remote images are never permanently ingested here; a logo URL is only accepted after
 * {@link validateImageBytes} confirms the fetched bytes are a real, size-bounded PNG/JPEG/
 * WebP/GIF/SVG. A missing or unsafe logo never blocks demo creation — the favicon or the
 * default palette is used instead.
 */
import type { Branding, RawCandidateLike } from "./types";

export const DEFAULT_BRANDING_PALETTE = {
  primary: "#1d4ed8",
  secondary: "#0f172a",
  accent: "#2563eb",
} as const;

const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

const IMAGE_SIGNATURES: { type: string; signature: number[]; svg?: boolean }[] = [
  { type: "image/png", signature: [0x89, 0x50, 0x4e, 0x47] },
  { type: "image/jpeg", signature: [0xff, 0xd8, 0xff] },
  { type: "image/gif", signature: [0x47, 0x49, 0x46, 0x38] },
  { type: "image/webp", signature: [0x52, 0x49, 0x46, 0x46] },
];

export interface ImageValidation {
  ok: boolean;
  type?: string;
  code?: "image_empty" | "image_too_large" | "image_type_not_allowed" | "image_content_invalid";
}

/** Validate fetched image bytes by magic number + size, before any acceptance. */
export function validateImageBytes(bytes: Uint8Array, declaredType?: string): ImageValidation {
  if (bytes.byteLength < 1) return { ok: false, code: "image_empty" };
  if (bytes.byteLength > MAX_IMAGE_BYTES) return { ok: false, code: "image_too_large" };

  // SVG: text-based; sniff for an <svg root and reject embedded scripts.
  const head = new TextDecoder("utf-8", { fatal: false })
    .decode(bytes.slice(0, 512))
    .trim()
    .toLowerCase();
  if (
    (declaredType?.includes("svg") || head.startsWith("<?xml") || head.startsWith("<svg")) &&
    head.includes("<svg")
  ) {
    if (head.includes("<script")) return { ok: false, code: "image_content_invalid" };
    return { ok: true, type: "image/svg+xml" };
  }

  for (const candidate of IMAGE_SIGNATURES) {
    const matches = candidate.signature.every((byte, index) => bytes[index] === byte);
    if (!matches) continue;
    if (candidate.type === "image/webp") {
      const isWebp = String.fromCharCode(...bytes.slice(8, 12)) === "WEBP";
      if (!isWebp) continue;
    }
    return { ok: true, type: candidate.type };
  }
  return { ok: false, code: "image_content_invalid" };
}

export interface BrandInput {
  domain: string;
  nameCandidates: RawCandidateLike[];
  themeColours: string[];
  /** Logo URL that has already passed {@link validateImageBytes}, if any. */
  verifiedLogoUrl: string | null;
  faviconUrl: string | null;
}

/** Pick the safe display name: strongest name candidate, else a name derived from domain. */
export function chooseDisplayName(nameCandidates: RawCandidateLike[], domain: string): string {
  const best = [...nameCandidates].sort((a, b) => b.strength - a.strength)[0];
  const name = best?.value?.trim();
  if (name && name.length >= 2 && name.length <= 120) return name;
  const label = domain.split(".")[0] ?? domain;
  return label
    .split(/[-_]/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function normalizeHex(hex: string): string | null {
  const value = hex.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(value)) return value;
  if (/^#[0-9a-f]{3}$/.test(value)) {
    return `#${value[1]}${value[1]}${value[2]}${value[2]}${value[3]}${value[3]}`;
  }
  return null;
}

/** Relative luminance, used to keep the default text colour readable. */
function isNearWhite(hex: string): boolean {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 235;
}

export function buildBranding(input: BrandInput): Branding {
  const displayName = chooseDisplayName(input.nameCandidates, input.domain);

  const distinctColours = [
    ...new Set(input.themeColours.map(normalizeHex).filter((c): c is string => Boolean(c))),
  ]
    .filter((c) => !isNearWhite(c))
    .slice(0, 3);

  let source: Branding["source"] = "default";
  let logoUrl: string | null = null;
  if (input.verifiedLogoUrl) {
    logoUrl = input.verifiedLogoUrl;
    source = "extracted";
  } else if (input.faviconUrl) {
    source = "favicon_fallback";
  }

  const colours = distinctColours.length
    ? {
        primary: distinctColours[0],
        secondary: distinctColours[1] ?? DEFAULT_BRANDING_PALETTE.secondary,
        accent: distinctColours[2] ?? distinctColours[0],
      }
    : { primary: null, secondary: null, accent: null };
  if (distinctColours.length && source === "default") source = "extracted";

  return {
    displayName,
    logoUrl,
    faviconUrl: input.faviconUrl,
    colours,
    source,
  };
}

/** The colour treatment the demo should render, always safe/defined. */
export function resolvedColours(branding: Branding): {
  primary: string;
  secondary: string;
  accent: string;
} {
  return {
    primary: branding.colours.primary ?? DEFAULT_BRANDING_PALETTE.primary,
    secondary: branding.colours.secondary ?? DEFAULT_BRANDING_PALETTE.secondary,
    accent: branding.colours.accent ?? DEFAULT_BRANDING_PALETTE.accent,
  };
}
