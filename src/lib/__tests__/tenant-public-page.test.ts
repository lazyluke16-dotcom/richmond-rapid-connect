import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Mock @tanstack/react-router BEFORE importing the route module so that
// `createFileRoute(...)(...)` returns a plain object whose useLoaderData
// hook reads a test-controlled bundle. This exercises the SAME TenantHome
// implementation used by src/routes/b.$slug.tsx — not a duplicate helper.
let mockBundle: any = null;
vi.mock('@tanstack/react-router', () => {
  const Link = ({ children, ...props }: any) =>
    React.createElement('a', { 'data-mock-link': true, ...props }, children);
  const Outlet = () => null;
  const createFileRoute = (_path: string) => (_config: any) => ({
    useLoaderData: () => mockBundle,
  });
  const notFound = () => new Error('notFound');
  return { Link, Outlet, createFileRoute, notFound };
});

// Prevent the server-fn module from executing Supabase client creation at
// import time (it references process.env.SUPABASE_URL). We only need the
// export symbol so TenantHome's module can resolve.
vi.mock('@/lib/business.functions', () => ({
  getTenantBundleBySlug: vi.fn(),
}));

import { TenantHome } from '@/routes/b.$slug';
import {
  parsePublicBusiness,
  publicLicenceInfo,
  PUBLIC_BUSINESS_COLUMNS,
  type TenantBundle,
} from '@/lib/business';

const EXPECTED_PUBLIC_BUSINESS_COLUMNS = [
  'id',
  'name',
  'slug',
  'public_phone',
  'public_email',
  'logo_url',
  'primary_colour',
  'secondary_colour',
  'accent_colour',
  'short_description',
  'hero_heading',
  'hero_subheading',
  'emergency_message',
  'active',
  'licence_number',
  'licence_holder_name',
  'licence_expiry',
  'licence_public',
] as const;

function makeBundle(overrides: Partial<TenantBundle['business']> = {}): TenantBundle {
  return {
    business: {
      id: 'biz-1',
      name: 'Tenant One Plumbing',
      slug: 'tenant-one',
      public_phone: null,
      public_email: null,
      logo_url: null,
      primary_colour: '#0EA5E9',
      secondary_colour: '#0B2545',
      accent_colour: '#67E8F9',
      short_description: null,
      hero_heading: null,
      hero_subheading: null,
      emergency_message: null,
      active: true,
      licence_number: 'LIC-12345',
      licence_holder_name: 'Alice Holder',
      licence_expiry: '2030-01-01',
      licence_public: false,
      ...overrides,
    } as any,
    services: [],
    areas: [],
    hours: [],
  } as unknown as TenantBundle;
}

function render(bundle: TenantBundle): string {
  mockBundle = bundle;
  return renderToStaticMarkup(React.createElement(TenantHome));
}

describe('Tenant public page rendering (src/routes/b.$slug.tsx → TenantHome)', () => {
  beforeEach(() => { mockBundle = null; });

  it('omits all licence details when licence_public is false', () => {
    const html = render(makeBundle({ licence_public: false }));
    expect(html).not.toContain('LIC-12345');
    expect(html).not.toContain('Alice Holder');
    expect(html).not.toContain('2030-01-01');
    expect(html).not.toContain('tenant-licence');
    expect(html).not.toContain('Licence number');
  });

  it('omits all licence details when licence_public is null', () => {
    const html = render(makeBundle({ licence_public: null }));
    expect(html).not.toContain('LIC-12345');
    expect(html).not.toContain('Alice Holder');
    expect(html).not.toContain('2030-01-01');
    expect(html).not.toContain('tenant-licence');
  });

  it('omits all licence details when licence_public is undefined (pre-migration schema)', () => {
    const b = makeBundle();
    delete (b.business as any).licence_public;
    const html = render(b);
    expect(html).not.toContain('LIC-12345');
    expect(html).not.toContain('Alice Holder');
    expect(html).not.toContain('2030-01-01');
    expect(html).not.toContain('tenant-licence');
  });

  it('omits all licence details when licence_public is a non-boolean truthy value', () => {
    const truthies: any[] = [1, 'true', 'yes', {}, []];
    for (const v of truthies) {
      const html = render(makeBundle({ licence_public: v }));
      expect(html, `truthy value ${JSON.stringify(v)} must not expose licence`).not.toContain('LIC-12345');
      expect(html).not.toContain('Alice Holder');
      expect(html).not.toContain('2030-01-01');
      expect(html).not.toContain('tenant-licence');
    }
  });

  it('renders licence number, holder, and expiry only when licence_public === true', () => {
    const html = render(makeBundle({ licence_public: true }));
    expect(html).toContain('tenant-licence');
    expect(html).toContain('LIC-12345');
    expect(html).toContain('Alice Holder');
    expect(html).toContain('2030-01-01');
    expect(html).toContain('Licence number');
    expect(html).toContain('Holder');
    expect(html).toContain('Expiry');
  });

  it('renders only the licence fields that are populated when licence_public === true', () => {
    const html = render(makeBundle({
      licence_public: true,
      licence_holder_name: null,
      licence_expiry: null,
    }));
    expect(html).toContain('LIC-12345');
    expect(html).toContain('Licence number');
    expect(html).not.toContain('Alice Holder');
    expect(html).not.toContain('2030-01-01');
    expect(html).not.toContain('Holder</dt>');
    expect(html).not.toContain('Expiry</dt>');
  });

  it('renders no licence values when licence_public === true but every licence field is empty', () => {
    const html = render(makeBundle({
      licence_public: true,
      licence_number: null,
      licence_holder_name: null,
      licence_expiry: null,
    }));
    // No stale/private values from other tests may leak, and no field rows render.
    expect(html).not.toContain('LIC-12345');
    expect(html).not.toContain('Alice Holder');
    expect(html).not.toContain('2030-01-01');
    expect(html).not.toContain('Licence number');
    expect(html).not.toContain('Holder</dt>');
    expect(html).not.toContain('Expiry</dt>');
  });

  it('one tenant opting in cannot expose another tenant\'s private licence', () => {
    // Tenant A: opted in, its own values must appear.
    const htmlA = render(makeBundle({
      id: 'biz-A', slug: 'tenant-a', name: 'Tenant A',
      licence_public: true,
      licence_number: 'A-PUBLIC-111',
      licence_holder_name: 'A Holder',
      licence_expiry: '2031-06-30',
    }));
    expect(htmlA).toContain('A-PUBLIC-111');
    expect(htmlA).toContain('A Holder');
    expect(htmlA).toContain('2031-06-30');

    // Tenant B: NOT opted in. Its own private values must not appear, and
    // Tenant A's values must not leak into Tenant B's rendered page.
    const htmlB = render(makeBundle({
      id: 'biz-B', slug: 'tenant-b', name: 'Tenant B',
      licence_public: false,
      licence_number: 'B-PRIVATE-222',
      licence_holder_name: 'B Holder',
      licence_expiry: '2032-12-31',
    }));
    expect(htmlB).not.toContain('tenant-licence');
    expect(htmlB).not.toContain('B-PRIVATE-222');
    expect(htmlB).not.toContain('B Holder');
    expect(htmlB).not.toContain('2032-12-31');
    // And absolutely no cross-tenant bleed of Tenant A's data.
    expect(htmlB).not.toContain('A-PUBLIC-111');
    expect(htmlB).not.toContain('A Holder');
    expect(htmlB).not.toContain('2031-06-30');
  });
});

describe('public business loader and pending-view disclosure contract', () => {
  const rawPublicBusiness = (pending: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: 'business-1',
    name: 'Example Plumbing',
    slug: 'example-plumbing',
    public_phone: null,
    public_email: null,
    logo_url: null,
    primary_colour: null,
    secondary_colour: null,
    accent_colour: null,
    short_description: null,
    hero_heading: null,
    hero_subheading: null,
    emergency_message: null,
    active: true,
    ...pending,
  });

  it('normalises the pending licence projection and preserves the exact-true gate', () => {
    const business = parsePublicBusiness(rawPublicBusiness({
      licence_number: 'LIC-123',
      licence_holder_name: 'Example Holder',
      licence_expiry: '2030-01-31',
      licence_public: true,
    }));

    expect(business).not.toBeNull();
    expect(publicLicenceInfo(business!)).toEqual({
      licence_number: 'LIC-123',
      licence_holder_name: 'Example Holder',
      licence_expiry: '2030-01-31',
    });
  });

  it('fails closed for absent, null, false, and malformed pending fields', () => {
    for (const pending of [
      {},
      { licence_number: 'LIC-123', licence_public: null },
      { licence_number: 'LIC-123', licence_public: false },
      {
        licence_number: { private: 'value' },
        licence_holder_name: 42,
        licence_expiry: [],
        licence_public: 'true',
      },
    ]) {
      const business = parsePublicBusiness(rawPublicBusiness(pending));
      expect(business).not.toBeNull();
      expect(publicLicenceInfo(business!)).toBeNull();
    }
  });

  it('rejects malformed required public identity fields at the query boundary', () => {
    expect(parsePublicBusiness(rawPublicBusiness({ id: 123 }))).toBeNull();
    expect(parsePublicBusiness(null)).toBeNull();
  });

  it('requests exactly the legacy public fields and four UI-required licence fields', () => {
    expect(PUBLIC_BUSINESS_COLUMNS.split(',')).toEqual(EXPECTED_PUBLIC_BUSINESS_COLUMNS);
  });

  it('keeps the pending view projection allowlisted and gates private licence values', () => {
    const sql = readFileSync(
      resolve(
        process.cwd(),
        'supabase/migrations-pending/20260722200000_phase1_coverage_and_licence.sql',
      ),
      'utf8',
    );
    const view = sql.match(
      /CREATE OR REPLACE VIEW public\.businesses_public\s+WITH \(security_invoker = true\) AS\s+SELECT([\s\S]*?)FROM public\.businesses\s+WHERE active = true;/i,
    );

    expect(view, 'pending migration must define the security-invoker public view').not.toBeNull();
    const projection = view![1];
    const projectedColumns = projection.split(',').map((expression) => {
      const alias = expression.match(/\s+AS\s+([a-z_]+)\s*$/i);
      return alias?.[1] ?? expression.trim();
    });

    expect(projectedColumns).toEqual(EXPECTED_PUBLIC_BUSINESS_COLUMNS);
    expect(projection).toMatch(
      /CASE WHEN licence_public IS TRUE THEN licence_number ELSE NULL END AS licence_number/i,
    );
    expect(projection).toMatch(
      /CASE WHEN licence_public IS TRUE THEN licence_holder_name ELSE NULL END AS licence_holder_name/i,
    );
    expect(projection).toMatch(
      /CASE WHEN licence_public IS TRUE THEN licence_expiry ELSE NULL END AS licence_expiry/i,
    );
    expect(sql).toMatch(
      /GRANT SELECT ON public\.businesses_public TO anon, authenticated;/i,
    );
    expect(sql).not.toMatch(/GRANT\s+SELECT[\s\S]*?ON\s+public\.businesses\s+TO\s+anon/i);

    const forbiddenPrivateFields = [
      'owner_user_id',
      'email',
      'phone',
      'alert_phone',
      'billing_exempt',
      'selected_plan',
      'partner_code',
      'referral_code',
      'signup_source',
      'trial_started_at',
      'trial_ends_at',
    ];
    for (const field of forbiddenPrivateFields) {
      expect(projectedColumns, `${field} must remain private`).not.toContain(field);
    }
  });
});
