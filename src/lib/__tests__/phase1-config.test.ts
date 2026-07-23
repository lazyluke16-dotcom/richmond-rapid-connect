import { describe, it, expect } from 'vitest';
import {
  CoveragePayloadSchema,
  LicencePayloadSchema,
  isValidTenantSlug,
  resolveLogoLink,
} from '../onboarding-validation';

describe('resolveLogoLink — tenant-aware top-left link', () => {
  it('public views route to "/"', () => {
    expect(resolveLogoLink({ authenticated: false })).toEqual({ kind: 'public', to: '/' });
    expect(resolveLogoLink({ authenticated: false, tenantSlug: 'richmond-rapid-plumbing' }))
      .toEqual({ kind: 'public', to: '/' });
  });

  it('authenticated + valid Richmond slug routes to /b/richmond-rapid-plumbing', () => {
    const r = resolveLogoLink({ authenticated: true, tenantSlug: 'richmond-rapid-plumbing' });
    expect(r.kind).toBe('tenant-public');
    if (r.kind === 'tenant-public') expect(r.slug).toBe('richmond-rapid-plumbing');
  });

  it('authenticated + valid second-tenant slug routes to /b/harbour-plumbing-co (never to Richmond or /)', () => {
    const r = resolveLogoLink({ authenticated: true, tenantSlug: 'harbour-plumbing-co' });
    expect(r.kind).toBe('tenant-public');
    if (r.kind === 'tenant-public') {
      expect(r.slug).toBe('harbour-plumbing-co');
      expect(r.slug).not.toBe('richmond-rapid-plumbing');
    }
  });

  it('authenticated with no slug falls back to /dashboard (never /)', () => {
    expect(resolveLogoLink({ authenticated: true })).toEqual({ kind: 'dashboard', to: '/dashboard' });
    expect(resolveLogoLink({ authenticated: true, tenantSlug: null }))
      .toEqual({ kind: 'dashboard', to: '/dashboard' });
  });

  it('authenticated with invalid slug falls back to /dashboard (never /)', () => {
    for (const bad of ['', 'A', '_bad', '-bad', 'bad_', 'bad slug', '../etc/passwd', 'x'.repeat(200)]) {
      const r = resolveLogoLink({ authenticated: true, tenantSlug: bad });
      expect(r.kind).toBe('dashboard');
    }
  });
});

describe('isValidTenantSlug', () => {
  it('accepts kebab-case slugs', () => {
    expect(isValidTenantSlug('richmond-rapid-plumbing')).toBe(true);
    expect(isValidTenantSlug('bluewave-plumbing')).toBe(true);
    expect(isValidTenantSlug('harbour-plumbing-co')).toBe(true);
  });
  it('rejects non-strings, empty, uppercase, and hostile inputs', () => {
    expect(isValidTenantSlug(null)).toBe(false);
    expect(isValidTenantSlug(undefined)).toBe(false);
    expect(isValidTenantSlug(123 as unknown)).toBe(false);
    expect(isValidTenantSlug('')).toBe(false);
    expect(isValidTenantSlug('Richmond')).toBe(false); // uppercase
    expect(isValidTenantSlug('foo/bar')).toBe(false);
    expect(isValidTenantSlug('/../evil')).toBe(false);
  });
});

describe('CoveragePayloadSchema — service coverage', () => {
  it('accepts base location + radius', () => {
    const r = CoveragePayloadSchema.safeParse({
      base_suburb: 'Richmond',
      base_state: 'VIC',
      base_postcode: '3121',
      travel_radius_km: 25,
      region_labels: ['Inner East Melbourne', 'CBD'],
      postcode_ranges: ['3000-3199', '3121'],
      excluded_areas: ['Docklands'],
    });
    expect(r.success).toBe(true);
  });
  it('rejects radius above 500 or below 0', () => {
    expect(CoveragePayloadSchema.safeParse({ travel_radius_km: -1 }).success).toBe(false);
    expect(CoveragePayloadSchema.safeParse({ travel_radius_km: 501 }).success).toBe(false);
  });
  it('rejects fractional or non-integer radius', () => {
    expect(CoveragePayloadSchema.safeParse({ travel_radius_km: 3.5 }).success).toBe(false);
  });
  it('rejects malformed postcode ranges', () => {
    expect(
      CoveragePayloadSchema.safeParse({ postcode_ranges: ['not-a-range'] }).success,
    ).toBe(false);
    expect(
      CoveragePayloadSchema.safeParse({ postcode_ranges: ['3000-3199-9999'] }).success,
    ).toBe(false);
  });
  it('rejects non-numeric base_postcode', () => {
    expect(CoveragePayloadSchema.safeParse({ base_postcode: 'ABCD' }).success).toBe(false);
  });
  it('accepts empty payload (all fields optional)', () => {
    expect(CoveragePayloadSchema.safeParse({}).success).toBe(true);
  });
  it('caps region_labels and excluded_areas array length', () => {
    const tooManyRegions = Array.from({ length: 33 }).map((_, i) => `Region ${i}`);
    expect(CoveragePayloadSchema.safeParse({ region_labels: tooManyRegions }).success).toBe(false);
  });
});

describe('LicencePayloadSchema — business profile licence', () => {
  it('accepts a fully-populated licence', () => {
    const r = LicencePayloadSchema.safeParse({
      licence_number: 'VIC-12345',
      licence_holder_name: 'Jane Smith',
      licence_expiry: '2028-12-31',
      licence_public: true,
    });
    expect(r.success).toBe(true);
  });
  it('licence_public defaults to hidden (must be explicit true)', () => {
    // Absence means "not public"; the server writes false by default at the column level.
    const r = LicencePayloadSchema.safeParse({ licence_number: 'X' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.licence_public).toBeUndefined();
  });
  it('rejects a non-ISO date', () => {
    expect(LicencePayloadSchema.safeParse({ licence_expiry: '31/12/2028' }).success).toBe(false);
  });
  it('accepts empty payload (all fields optional)', () => {
    expect(LicencePayloadSchema.safeParse({}).success).toBe(true);
  });
  it('caps licence_number length', () => {
    expect(LicencePayloadSchema.safeParse({ licence_number: 'x'.repeat(100) }).success).toBe(false);
  });
});