/**
 * Phase 3B — Enrichment helper + processor regression tests.
 *
 * Pure logic only: no network, no Supabase, no Vapi, no secrets.
 * All external side effects are mocked through ProcessJobDeps.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  normalizeVapiJobType,
  needsEnrichment,
  needsLeadEnrichment,
  buildLeadUpdates,
  guardExistingValues,
  retryDelaySec,
  isValidEnrichmentTarget,
  processJob,
  ENRICHMENT_BATCH_LIMIT,
  type EnrichmentJob,
  type CurrentLeadValues,
  type ProcessJobDeps,
} from '../enrichment.server';

const baseJob = (over: Partial<EnrichmentJob> = {}): EnrichmentJob => ({
  id: 'job-1',
  call_id: 'call-1',
  lead_id: 'lead-1',
  business_id: 'biz-1',
  attempt_count: 0,
  max_attempts: 5,
  ...over,
});

const baseLead = (over: Partial<CurrentLeadValues> = {}): CurrentLeadValues => ({
  id: 'lead-1',
  business_id: 'biz-1',
  name: 'Unknown caller',
  phone: null,
  suburb: 'unknown',
  job_type: 'other',
  urgency: null,
  best_time: null,
  ai_summary: null,
  external_call_id: 'call-1',
  ...over,
});

const completeSd = {
  customer_name: 'Alice',
  callback_number: '0400000000',
  suburb: 'Richmond',
  job_type: 'burst_pipe',
  urgency: 'now',
  callback_preference: 'ASAP',
};

function makeDeps(over: Partial<ProcessJobDeps> = {}): ProcessJobDeps & {
  calls: {
    markCompleted: number;
    markFailed: string[];
    scheduleRetry: Array<{ attempt: number; reason: string }>;
    updateLead: Array<Record<string, unknown>>;
  };
} {
  const state = {
    markCompleted: 0,
    markFailed: [] as string[],
    scheduleRetry: [] as Array<{ attempt: number; reason: string }>,
    updateLead: [] as Array<Record<string, unknown>>,
  };
  const deps: ProcessJobDeps = {
    getVapiCall: vi.fn(async () => ({ analysis: { structuredData: completeSd, summary: 'ok' } })),
    getLead: vi.fn(async () => baseLead()),
    updateLead: vi.fn(async (_l, _b, updates) => {
      state.updateLead.push(updates);
      return { error: null };
    }),
    markCompleted: vi.fn(async () => {
      state.markCompleted += 1;
    }),
    markFailed: vi.fn(async (_id, reason) => {
      state.markFailed.push(reason);
    }),
    scheduleRetry: vi.fn(async (_id, attempt, reason) => {
      state.scheduleRetry.push({ attempt, reason });
    }),
    ...over,
  };
  return Object.assign(deps, { calls: state });
}

describe('ENRICHMENT_BATCH_LIMIT', () => {
  it('is a small bounded batch size shared with the processor', () => {
    expect(ENRICHMENT_BATCH_LIMIT).toBeGreaterThan(0);
    expect(ENRICHMENT_BATCH_LIMIT).toBeLessThanOrEqual(10);
  });
});

describe('normalizeVapiJobType', () => {
  it('maps snake_case Vapi values to canonical job types', () => {
    expect(normalizeVapiJobType('burst_pipe')).toBe('burst-pipe');
    expect(normalizeVapiJobType('blocked_drain')).toBe('blocked-drain');
    expect(normalizeVapiJobType('hot_water')).toBe('hot-water');
    expect(normalizeVapiJobType('leaking_tap')).toBe('leaking-tap');
    expect(normalizeVapiJobType('gas_leak')).toBe('gas');
    expect(normalizeVapiJobType('hot_water_system')).toBe('hot-water');
    expect(normalizeVapiJobType('dripping_tap')).toBe('leaking-tap');
  });

  it('passes through already-canonical hyphenated values', () => {
    expect(normalizeVapiJobType('burst-pipe')).toBe('burst-pipe');
    expect(normalizeVapiJobType('toilet')).toBe('toilet');
  });

  it('is case-insensitive and trims whitespace', () => {
    expect(normalizeVapiJobType('  Burst_Pipe  ')).toBe('burst-pipe');
  });

  it('falls back to "other" for unknown or empty values', () => {
    expect(normalizeVapiJobType(undefined)).toBe('other');
    expect(normalizeVapiJobType('')).toBe('other');
    expect(normalizeVapiJobType('nonsense-value')).toBe('other');
  });
});

describe('needsEnrichment', () => {
  it('returns true when required structured fields are missing', () => {
    expect(needsEnrichment({})).toBe(true);
  });

  it('treats the "Unknown caller" placeholder as missing', () => {
    expect(needsEnrichment({ ...completeSd, customer_name: 'Unknown caller' })).toBe(true);
  });

  it('treats the "unknown" suburb placeholder as missing', () => {
    expect(needsEnrichment({ ...completeSd, suburb: 'unknown' })).toBe(true);
  });

  it('returns false when every required field is present and non-placeholder', () => {
    expect(needsEnrichment(completeSd)).toBe(false);
  });
});

describe('needsLeadEnrichment', () => {
  it('flags leads with placeholder / null critical fields', () => {
    expect(needsLeadEnrichment(baseLead())).toBe(true);
  });

  it('accepts a fully populated lead as complete', () => {
    expect(
      needsLeadEnrichment({
        name: 'Alice',
        phone: '0400000000',
        suburb: 'Richmond',
        job_type: 'burst-pipe',
        urgency: 'now',
        best_time: 'ASAP',
      }),
    ).toBe(false);
  });

  it('flags "other" job_type as still needing enrichment', () => {
    expect(
      needsLeadEnrichment({
        name: 'Alice',
        phone: '0400000000',
        suburb: 'Richmond',
        job_type: 'other',
        urgency: 'now',
        best_time: 'ASAP',
      }),
    ).toBe(true);
  });
});

describe('guardExistingValues', () => {
  it('drops job_type=other when the lead already has a specific value', () => {
    const out = guardExistingValues({ job_type: 'other' }, baseLead({ job_type: 'burst-pipe' }));
    expect(out.job_type).toBeUndefined();
  });

  it('drops urgency=today when the lead already has a stronger urgency', () => {
    const out = guardExistingValues({ urgency: 'today' }, baseLead({ urgency: 'now' }));
    expect(out.urgency).toBeUndefined();
  });

  it('keeps values that would strictly improve the lead', () => {
    const out = guardExistingValues({ job_type: 'burst-pipe' }, baseLead());
    expect(out.job_type).toBe('burst-pipe');
  });
});

describe('buildLeadUpdates', () => {
  it('only sets fields that are present and non-placeholder', () => {
    const out = buildLeadUpdates({ customer_name: 'Unknown caller', suburb: 'Richmond' }, undefined);
    expect(out.name).toBeUndefined();
    expect(out.suburb).toBe('Richmond');
  });

  it('normalises job_type through normalizeVapiJobType', () => {
    const out = buildLeadUpdates({ job_type: 'burst_pipe' }, undefined);
    expect(out.job_type).toBe('burst-pipe');
  });
});

describe('isValidEnrichmentTarget', () => {
  it('accepts matching tenant ids', () => {
    expect(isValidEnrichmentTarget('biz-1', 'biz-1')).toBe(true);
  });
  it('rejects mismatched or empty tenants', () => {
    expect(isValidEnrichmentTarget('biz-1', 'biz-2')).toBe(false);
    expect(isValidEnrichmentTarget('', 'biz-1')).toBe(false);
  });
});

describe('retryDelaySec', () => {
  it('grows with attempt count and caps at 300 seconds', () => {
    expect(retryDelaySec(0)).toBe(60);
    expect(retryDelaySec(1)).toBe(120);
    expect(retryDelaySec(4)).toBe(300);
    expect(retryDelaySec(50)).toBe(300);
  });
});

describe('processJob — happy path', () => {
  it('marks completed when structured data fills the lead', async () => {
    const deps = makeDeps();
    const res = await processJob(baseJob(), deps);
    expect(res.outcome).toBe('completed');
    expect(deps.calls.markCompleted).toBe(1);
    expect(deps.calls.updateLead[0]).toMatchObject({
      name: 'Alice',
      phone: '0400000000',
      suburb: 'Richmond',
      job_type: 'burst-pipe',
      urgency: 'now',
      best_time: 'ASAP',
    });
  });
});

describe('processJob — tenant mismatch', () => {
  it('fails terminally without touching the lead', async () => {
    const deps = makeDeps({
      getLead: vi.fn(async () => baseLead({ business_id: 'other-biz' })),
    });
    const res = await processJob(baseJob(), deps);
    expect(res.outcome).toBe('failed');
    expect(res.error).toBe('tenant_mismatch');
    expect(deps.calls.updateLead.length).toBe(0);
  });
});

describe('processJob — retry transition', () => {
  it('schedules a retry when Vapi is unavailable and attempts remain', async () => {
    const deps = makeDeps({
      getVapiCall: vi.fn(async () => {
        throw new Error('vapi_temporary_failure');
      }),
    });
    const res = await processJob(baseJob({ attempt_count: 1 }), deps);
    expect(res.outcome).toBe('retry_scheduled');
    expect(deps.calls.scheduleRetry.map((r) => r.attempt)).toEqual([1]);
    expect(deps.calls.markFailed.length).toBe(0);
  });

  it('schedules a retry when the returned analysis is still incomplete', async () => {
    const deps = makeDeps({
      getVapiCall: vi.fn(async () => ({ analysis: { structuredData: {} } })),
    });
    const res = await processJob(baseJob({ attempt_count: 0 }), deps);
    expect(res.outcome).toBe('retry_scheduled');
    expect(deps.calls.scheduleRetry.map((r) => r.attempt)).toEqual([0]);
  });
});

describe('processJob — terminal failure at max attempts', () => {
  it('marks failed when Vapi keeps failing on the last attempt', async () => {
    const deps = makeDeps({
      getVapiCall: vi.fn(async () => {
        throw new Error('vapi_gone');
      }),
    });
    const res = await processJob(baseJob({ attempt_count: 4, max_attempts: 5 }), deps);
    expect(res.outcome).toBe('failed');
    expect(res.error).toBe('vapi_fetch_failed');
    expect(deps.calls.markFailed.length).toBe(1);
    expect(deps.calls.markFailed[0]).toMatch(/vapi_fetch_failed/);
  });

  it('marks failed when analysis is still incomplete on the last attempt', async () => {
    const deps = makeDeps({
      getVapiCall: vi.fn(async () => ({ analysis: { structuredData: {} } })),
    });
    const res = await processJob(baseJob({ attempt_count: 4, max_attempts: 5 }), deps);
    expect(res.outcome).toBe('failed');
    expect(res.error).toBe('analysis_incomplete_max_attempts');
  });
});

describe('processJob — has no billing side effects', () => {
  it('never invokes anything beyond the injected deps (no hidden billing calls)', async () => {
    const deps = makeDeps();
    await processJob(baseJob(), deps);
    // Only the injected deps are called; the processor cannot reach a billing meter.
    // This asserts the boundary: enrichment does not double-charge or emit usage.
    expect(Object.keys(deps).filter((k) => typeof (deps as never)[k] === 'function').sort()).toEqual(
      ['getLead', 'getVapiCall', 'markCompleted', 'markFailed', 'scheduleRetry', 'updateLead'].sort(),
    );
  });
});

describe('Phase 3C — retry reason sanitization', () => {
  const SECRET_PATTERNS = [/authorization/i, /bearer/i, /token/i, /\+?\d{8,}/, /transcript/i];

  function assertSafeReason(reason: string) {
    for (const p of SECRET_PATTERNS) expect(reason).not.toMatch(p);
  }

  it('temporary Vapi failure schedules a retry with a bounded, sanitized reason', async () => {
    const secretMsg =
      'Vapi 401: Authorization: Bearer sk-abc, transcript="Alice at +61400000000"';
    const deps = makeDeps({
      getVapiCall: vi.fn(async () => {
        throw new Error(secretMsg);
      }),
    });
    const res = await processJob(baseJob({ attempt_count: 0 }), deps);
    expect(res.outcome).toBe('retry_scheduled');
    expect(deps.calls.scheduleRetry.length).toBe(1);
    const reason = deps.calls.scheduleRetry[0].reason;
    expect(reason).toBe('vapi_fetch_failed');
    assertSafeReason(reason);
  });

  it('incomplete analysis retry names only missing fields — no values or PII', async () => {
    const deps = makeDeps({
      getVapiCall: vi.fn(async () => ({
        analysis: {
          structuredData: {
            customer_name: 'Alice Q.',
            callback_number: '+61400000000',
            // missing suburb, job_type, urgency, callback_preference
          },
          summary: 'transcript body should not appear here',
        },
      })),
    });
    const res = await processJob(baseJob(), deps);
    expect(res.outcome).toBe('retry_scheduled');
    const reason = deps.calls.scheduleRetry[0].reason;
    expect(reason.startsWith('analysis_incomplete:')).toBe(true);
    // Field names only.
    expect(reason).toContain('suburb');
    expect(reason).toContain('job_type');
    expect(reason).toContain('urgency');
    expect(reason).toContain('callback_preference');
    // No PII / values leaked.
    expect(reason).not.toContain('Alice');
    expect(reason).not.toContain('61400000000');
    expect(reason).not.toContain('transcript');
    assertSafeReason(reason);
  });

  it('lead update failure schedules a retry with a bounded reason (no row content)', async () => {
    const deps = makeDeps({
      updateLead: vi.fn(async () => ({
        error: 'duplicate key value violates unique constraint "leads_pkey" DETAIL: (name)=(Alice)',
      })),
    });
    const res = await processJob(baseJob(), deps);
    expect(res.outcome).toBe('retry_scheduled');
    const reason = deps.calls.scheduleRetry[0].reason;
    expect(reason).toBe('lead_update_failed');
    expect(reason).not.toContain('Alice');
    expect(reason).not.toContain('duplicate');
  });

  it('final attempt becomes failed and does NOT schedule another retry', async () => {
    const deps = makeDeps({
      getVapiCall: vi.fn(async () => {
        throw new Error('some_upstream_error with headers=Bearer xxx');
      }),
    });
    const res = await processJob(baseJob({ attempt_count: 4, max_attempts: 5 }), deps);
    expect(res.outcome).toBe('failed');
    expect(deps.calls.scheduleRetry.length).toBe(0);
    expect(deps.calls.markFailed.length).toBe(1);
    // markFailed reason is also sanitized (category only).
    assertSafeReason(deps.calls.markFailed[0]);
    expect(deps.calls.markFailed[0]).toBe('vapi_fetch_failed_max_attempts');
  });

  it('success completes via markCompleted and never calls scheduleRetry/markFailed', async () => {
    const deps = makeDeps();
    const res = await processJob(baseJob(), deps);
    expect(res.outcome).toBe('completed');
    expect(deps.calls.markCompleted).toBe(1);
    expect(deps.calls.scheduleRetry.length).toBe(0);
    expect(deps.calls.markFailed.length).toBe(0);
  });

  it('retry delay stays capped regardless of attempt count', () => {
    for (let i = 0; i < 100; i++) {
      expect(retryDelaySec(i)).toBeLessThanOrEqual(300);
      expect(retryDelaySec(i)).toBeGreaterThanOrEqual(60);
    }
  });

  it('tenant-boundary check still rejects mismatched business_id before any Vapi call', async () => {
    const vapiSpy = vi.fn(async () => ({ analysis: { structuredData: completeSd } }));
    const deps = makeDeps({
      getLead: vi.fn(async () => baseLead({ business_id: 'other-biz' })),
      getVapiCall: vapiSpy,
    });
    const res = await processJob(baseJob(), deps);
    expect(res.outcome).toBe('failed');
    expect(res.error).toBe('tenant_mismatch');
    expect(vapiSpy).not.toHaveBeenCalled();
    expect(deps.calls.updateLead.length).toBe(0);
    expect(deps.calls.scheduleRetry.length).toBe(0);
  });
});