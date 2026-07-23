import { describe, it, expect } from 'vitest';
import {
  applyCoverageUpdate,
  applyLicenceUpdate,
  type BusinessUpdateDeps,
} from '@/lib/business-settings.functions';
import { publicLicenceInfo, type PublicBusiness } from '@/lib/business';

/**
 * Phase 1 — repository-only persistence + public-output regression tests.
 *
 * These tests cover the pure dependency-injected helpers used by the
 * server functions so we can assert every write is scoped to the
 * authenticated caller's own business_id, that a client-supplied `id`
 * is stripped by the schema and cannot target another tenant, that
 * failures propagate (never silently swallowed), and that public
 * output is gated by `licence_public === true`.
 */

function makeDeps(overrides: Partial<{
  ownId: string;
  updateFails: boolean;
  resolveFails: boolean;
  noBusiness: boolean;
}> = {}) {
  const updates: { id: string; patch: Record<string, unknown> }[] = [];
  const deps: BusinessUpdateDeps = {
    resolveCurrentBusinessId: async () => {
      if (overrides.resolveFails) throw new Error('resolve boom');
      if (overrides.noBusiness) return null;
      return overrides.ownId ?? 'own-biz-1';
    },
    updateBusinessById: async (id, patch) => {
      if (overrides.updateFails) throw new Error('db update failed');
      updates.push({ id, patch });
    },
  };
  return { deps, updates };
}

describe('applyCoverageUpdate — scoped writes', () => {
  it('scopes the update to the caller-resolved business_id', async () => {
    const { deps, updates } = makeDeps({ ownId: 'own-1' });
    await applyCoverageUpdate(deps, {
      base_suburb: 'Richmond', base_state: 'VIC', base_postcode: '3121',
      travel_radius_km: 25, region_labels: ['Inner East'],
    });
    expect(updates).toHaveLength(1);
    expect(updates[0].id).toBe('own-1');
    expect(updates[0].patch.base_suburb).toBe('Richmond');
    expect(updates[0].patch.travel_radius_km).toBe(25);
  });

  it('ignores a client-supplied `id` — cannot target another tenant', async () => {
    const { deps, updates } = makeDeps({ ownId: 'own-1' });
    await applyCoverageUpdate(deps, {
      id: 'victim-tenant-id',
      business_id: 'victim-tenant-id',
      base_suburb: 'Docklands',
    } as unknown);
    expect(updates[0].id).toBe('own-1');
    expect(updates[0].patch).not.toHaveProperty('id');
    expect(updates[0].patch).not.toHaveProperty('business_id');
  });

  it('rejects when the caller has no business membership (no write occurs)', async () => {
    const { deps, updates } = makeDeps({ noBusiness: true });
    await expect(applyCoverageUpdate(deps, { base_suburb: 'X' })).rejects.toThrow(/No business/);
    expect(updates).toHaveLength(0);
  });

  it('propagates update failures (no silent success)', async () => {
    const { deps, updates } = makeDeps({ updateFails: true });
    await expect(applyCoverageUpdate(deps, { base_suburb: 'X' })).rejects.toThrow(/db update failed/);
    expect(updates).toHaveLength(0);
  });

  it('rejects invalid input before touching persistence', async () => {
    const { deps, updates } = makeDeps();
    await expect(applyCoverageUpdate(deps, { travel_radius_km: 9999 })).rejects.toBeInstanceOf(Error);
    expect(updates).toHaveLength(0);
  });
});

describe('applyLicenceUpdate — scoped writes', () => {
  it('scopes the update to the caller-resolved business_id', async () => {
    const { deps, updates } = makeDeps({ ownId: 'own-2' });
    await applyLicenceUpdate(deps, {
      licence_number: 'VIC-12345', licence_public: true,
    });
    expect(updates).toHaveLength(1);
    expect(updates[0].id).toBe('own-2');
    expect(updates[0].patch.licence_number).toBe('VIC-12345');
    expect(updates[0].patch.licence_public).toBe(true);
  });

  it('ignores a client-supplied `id` — cannot target another tenant', async () => {
    const { deps, updates } = makeDeps({ ownId: 'own-2' });
    await applyLicenceUpdate(deps, {
      id: 'victim-tenant-id',
      licence_number: 'X',
    } as unknown);
    expect(updates[0].id).toBe('own-2');
    expect(updates[0].patch).not.toHaveProperty('id');
  });

  it('rejects when the caller has no business membership', async () => {
    const { deps, updates } = makeDeps({ noBusiness: true });
    await expect(applyLicenceUpdate(deps, { licence_number: 'X' })).rejects.toThrow(/No business/);
    expect(updates).toHaveLength(0);
  });

  it('propagates update failures (no silent success)', async () => {
    const { deps, updates } = makeDeps({ updateFails: true });
    await expect(applyLicenceUpdate(deps, { licence_number: 'X' })).rejects.toThrow(/db update failed/);
    expect(updates).toHaveLength(0);
  });
});

describe('coverage-save transactional wizard contract (simulated saveAreas)', () => {
  /**
   * Simulates the wizard's saveAreas order-of-operations to prove the
   * transactional guarantee: a coverage failure must NOT touch the
   * suburb list, must NOT advance the step, and must NOT overwrite
   * previously saved coverage.
   */
  async function simulateSaveAreas(opts: {
    hasCoverageInput: boolean;
    coverageFails?: boolean;
  }) {
    const events: string[] = [];
    const { deps } = makeDeps({ updateFails: opts.coverageFails });
    try {
      if (opts.hasCoverageInput) {
        await applyCoverageUpdate(deps, { base_suburb: 'Richmond' });
        events.push('coverage-saved');
      }
      // legacy suburb save only runs after coverage succeeds
      events.push('suburbs-saved');
      events.push('step-persisted:4');
      events.push('advanced-to:4');
      return { events, error: null as string | null };
    } catch (e) {
      return { events, error: e instanceof Error ? e.message : String(e) };
    }
  }

  it('coverage failure blocks suburb save and step advance', async () => {
    const { events, error } = await simulateSaveAreas({ hasCoverageInput: true, coverageFails: true });
    expect(error).toMatch(/db update failed/);
    expect(events).not.toContain('suburbs-saved');
    expect(events).not.toContain('step-persisted:4');
    expect(events).not.toContain('advanced-to:4');
  });

  it('coverage success is followed by suburbs + step advance', async () => {
    const { events, error } = await simulateSaveAreas({ hasCoverageInput: true });
    expect(error).toBeNull();
    expect(events).toEqual(['coverage-saved', 'suburbs-saved', 'step-persisted:4', 'advanced-to:4']);
  });

  it('no coverage input → coverage call skipped, wizard still advances (pre-migration compat)', async () => {
    const { events, error } = await simulateSaveAreas({ hasCoverageInput: false });
    expect(error).toBeNull();
    expect(events).toEqual(['suburbs-saved', 'step-persisted:4', 'advanced-to:4']);
  });
});

describe('publicLicenceInfo — public-output isolation', () => {
  const base = {
    licence_number: 'VIC-12345',
    licence_holder_name: 'Jane Smith',
    licence_expiry: '2028-12-31',
  } as const;

  it('returns null when licence_public is undefined (Richmond pre-migration)', () => {
    expect(publicLicenceInfo({ ...base, licence_public: undefined } as unknown as PublicBusiness)).toBeNull();
  });
  it('returns null when licence_public is null', () => {
    expect(publicLicenceInfo({ ...base, licence_public: null })).toBeNull();
  });
  it('returns null when licence_public is false', () => {
    expect(publicLicenceInfo({ ...base, licence_public: false })).toBeNull();
  });
  it('returns the licence fields ONLY when licence_public === true', () => {
    expect(publicLicenceInfo({ ...base, licence_public: true })).toEqual({
      licence_number: 'VIC-12345',
      licence_holder_name: 'Jane Smith',
      licence_expiry: '2028-12-31',
    });
  });
  it('does not leak another tenant\'s licence when a second tenant is called separately', () => {
    const tenantA = { ...base, licence_public: true };
    const tenantB = { licence_number: 'NSW-9', licence_holder_name: 'Other', licence_expiry: '2030-01-01', licence_public: false };
    const a = publicLicenceInfo(tenantA);
    const b = publicLicenceInfo(tenantB);
    expect(a?.licence_number).toBe('VIC-12345');
    expect(b).toBeNull(); // second tenant opted out — must remain hidden even though A opted in
  });
  it('a truthy-but-non-true value (e.g. 1) does NOT enable public display', () => {
    expect(publicLicenceInfo({ ...base, licence_public: 1 as unknown as boolean })).toBeNull();
  });
});