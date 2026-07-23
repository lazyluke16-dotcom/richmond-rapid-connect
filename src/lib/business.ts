/** Explicit allowlist shared by the public loader and its schema contract tests. */
export const PUBLIC_BUSINESS_COLUMNS =
  'id,name,slug,public_phone,public_email,logo_url,primary_colour,secondary_colour,accent_colour,short_description,hero_heading,hero_subheading,emergency_message,active,licence_number,licence_holder_name,licence_expiry,licence_public' as const;

export interface PublicBusiness {
  id: string;
  name: string;
  slug: string;
  public_phone: string | null;
  public_email: string | null;
  logo_url: string | null;
  primary_colour: string | null;
  secondary_colour: string | null;
  accent_colour: string | null;
  short_description: string | null;
  hero_heading: string | null;
  hero_subheading: string | null;
  emergency_message: string | null;
  active: boolean;
  // Phase 1 licence fields — always optional; may be absent pre-migration.
  licence_number?: string | null;
  licence_holder_name?: string | null;
  licence_expiry?: string | null;
  licence_public?: boolean | null;
}

/** Transitional licence fields returned by businesses_public before the
 * pending Phase 1 schema is reflected in generated Supabase types. */
export type TransitionalPublicLicenceFields = Pick<PublicBusiness,
  'licence_number' | 'licence_holder_name' | 'licence_expiry' | 'licence_public'
>;
export type TransitionalPublicBusiness = Omit<PublicBusiness, keyof TransitionalPublicLicenceFields> &
  TransitionalPublicLicenceFields;

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null;
}

function readNullableString(value: unknown): string | null {
  return typeof value === 'string' || value === null ? value : null;
}

function readPendingString(value: unknown): string | null | undefined {
  return value === undefined || value === null || typeof value === 'string'
    ? value
    : undefined;
}

function readPendingBoolean(value: unknown): boolean | null | undefined {
  return value === undefined || value === null || typeof value === 'boolean'
    ? value
    : undefined;
}

/** Safely normalise the public view response, including pending licence fields. */
export function parsePublicBusiness(value: unknown): TransitionalPublicBusiness | null {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.name !== 'string' ||
      typeof value.slug !== 'string' || value.active !== true) {
    return null;
  }

  return {
    id: value.id,
    name: value.name,
    slug: value.slug,
    public_phone: readNullableString(value.public_phone),
    public_email: readNullableString(value.public_email),
    logo_url: readNullableString(value.logo_url),
    primary_colour: readNullableString(value.primary_colour),
    secondary_colour: readNullableString(value.secondary_colour),
    accent_colour: readNullableString(value.accent_colour),
    short_description: readNullableString(value.short_description),
    hero_heading: readNullableString(value.hero_heading),
    hero_subheading: readNullableString(value.hero_subheading),
    emergency_message: readNullableString(value.emergency_message),
    active: true,
    licence_number: readPendingString(value.licence_number),
    licence_holder_name: readPendingString(value.licence_holder_name),
    licence_expiry: readPendingString(value.licence_expiry),
    licence_public: readPendingBoolean(value.licence_public),
  };
}

export interface PublicService {
  id: string;
  service_key: string;
  display_name: string;
  description: string | null;
  display_order: number;
}

export interface PublicArea {
  id: string;
  suburb: string;
  state: string | null;
  display_order: number;
}

export interface PublicHour {
  day_of_week: number;
  open_time: string | null;
  close_time: string | null;
  closed: boolean;
}

export interface TenantBundle {
  business: PublicBusiness;
  services: PublicService[];
  areas: PublicArea[];
  hours: PublicHour[];
}

export const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Build CSS custom-property overrides from a business record. */
export function tenantCssVars(b: PublicBusiness): React.CSSProperties {
  const style: Record<string, string> = {};
  if (b.primary_colour) style['--tenant-primary'] = b.primary_colour;
  if (b.secondary_colour) style['--tenant-secondary'] = b.secondary_colour;
  if (b.accent_colour) style['--tenant-accent'] = b.accent_colour;
  return style as React.CSSProperties;
}

/**
 * Return the licence fields that are safe to render on a public tenant
 * surface — ONLY when the owning tenant has opted in via
 * `licence_public === true`. Every other value (undefined, null, false)
 * MUST hide all licence data. Callers should render nothing when this
 * returns `null`.
 */
export interface PublicLicenceInfo {
  licence_number: string | null;
  licence_holder_name: string | null;
  licence_expiry: string | null;
}
export function publicLicenceInfo(b: Pick<PublicBusiness,
  'licence_public' | 'licence_number' | 'licence_holder_name' | 'licence_expiry'
>): PublicLicenceInfo | null {
  if (b.licence_public !== true) return null;
  return {
    licence_number: b.licence_number ?? null,
    licence_holder_name: b.licence_holder_name ?? null,
    licence_expiry: b.licence_expiry ?? null,
  };
}
