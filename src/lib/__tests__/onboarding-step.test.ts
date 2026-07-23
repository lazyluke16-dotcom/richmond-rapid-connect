import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  OnboardingStepSchema,
  ONBOARDING_STEP_MAX,
} from '../onboarding-validation';
import { resolveOnboardingResumeStep } from '../onboarding.functions';

const emptyProgress = {
  hasBusiness: true,
  servicesCount: 0,
  areasCount: 0,
  hoursCount: 0,
  hasPlan: false,
  hasWebsiteCopy: false,
  completed: false,
};

describe('OnboardingStepSchema strict write validation', () => {
  it('rejects negative steps', () => {
    expect(OnboardingStepSchema.safeParse(-1).success).toBe(false);
  });
  it('rejects steps above max', () => {
    expect(OnboardingStepSchema.safeParse(ONBOARDING_STEP_MAX + 1).success).toBe(false);
  });
  it('rejects fractional steps', () => {
    expect(OnboardingStepSchema.safeParse(3.5).success).toBe(false);
  });
  it('rejects non-numeric strings', () => {
    expect(OnboardingStepSchema.safeParse('4' as unknown as number).success).toBe(false);
    expect(OnboardingStepSchema.safeParse('foo' as unknown as number).success).toBe(false);
  });
  it('rejects null / undefined / NaN', () => {
    expect(OnboardingStepSchema.safeParse(null as unknown as number).success).toBe(false);
    expect(OnboardingStepSchema.safeParse(undefined as unknown as number).success).toBe(false);
    expect(OnboardingStepSchema.safeParse(Number.NaN).success).toBe(false);
  });
  it('accepts every valid step 0..7', () => {
    for (let i = 0; i <= ONBOARDING_STEP_MAX; i++) {
      expect(OnboardingStepSchema.safeParse(i).success).toBe(true);
    }
  });
});

describe('resolveOnboardingResumeStep', () => {
  it('returns max when completed regardless of persisted or derived', () => {
    expect(
      resolveOnboardingResumeStep({
        persistedStep: 2,
        completed: true,
        progress: { ...emptyProgress, completed: true },
      }),
    ).toBe(ONBOARDING_STEP_MAX);
  });

  it('legacy row (persisted=0) falls back to derived', () => {
    expect(
      resolveOnboardingResumeStep({
        persistedStep: 0,
        completed: false,
        progress: { ...emptyProgress, servicesCount: 3, areasCount: 2 },
      }),
    ).toBe(4); // derived from services+areas
  });

  it('legacy row with null persisted step falls back to derived', () => {
    expect(
      resolveOnboardingResumeStep({
        persistedStep: null,
        completed: false,
        progress: { ...emptyProgress, servicesCount: 1 },
      }),
    ).toBe(3);
  });

  it('honours persisted exact step even when derived would be lower', () => {
    // User advanced to step 5 but has not saved services/areas/hours yet.
    expect(
      resolveOnboardingResumeStep({
        persistedStep: 5,
        completed: false,
        progress: emptyProgress,
      }),
    ).toBe(5);
  });

  it('never regresses persisted progress when derived is higher', () => {
    // Persisted says step 2, but data implies step 6 — the user has moved on.
    expect(
      resolveOnboardingResumeStep({
        persistedStep: 2,
        completed: false,
        progress: {
          ...emptyProgress,
          servicesCount: 1,
          areasCount: 1,
          hoursCount: 1,
          hasPlan: true,
        },
      }),
    ).toBeGreaterThanOrEqual(6);
  });

  it('ignores garbage persisted values and falls back to derived', () => {
    expect(
      resolveOnboardingResumeStep({
        persistedStep: Number.NaN,
        completed: false,
        progress: { ...emptyProgress, servicesCount: 1 },
      }),
    ).toBe(3);
    expect(
      resolveOnboardingResumeStep({
        persistedStep: 3.9 as number,
        completed: false,
        progress: emptyProgress,
      }),
    ).toBe(2); // fractional persisted → treated as legacy → derived (branding)
  });

  it('clamps out-of-range persisted values into [0, MAX]', () => {
    expect(
      resolveOnboardingResumeStep({
        persistedStep: 99,
        completed: false,
        progress: emptyProgress,
      }),
    ).toBe(ONBOARDING_STEP_MAX);
    expect(
      resolveOnboardingResumeStep({
        persistedStep: -5,
        completed: false,
        progress: { ...emptyProgress, servicesCount: 1 },
      }),
    ).toBe(3); // treated as legacy → derived
  });
});

describe('tenant fail-closed contract', () => {
  const ORIGINAL_ENV_ID = process.env.DEFAULT_BUSINESS_ID;
  const ORIGINAL_ENV_SLUG = process.env.DEFAULT_BUSINESS_SLUG;

  beforeEach(() => {
    vi.resetModules();
    delete process.env.DEFAULT_BUSINESS_ID;
    delete process.env.DEFAULT_BUSINESS_SLUG;
  });

  afterEach(() => {
    if (ORIGINAL_ENV_ID === undefined) delete process.env.DEFAULT_BUSINESS_ID;
    else process.env.DEFAULT_BUSINESS_ID = ORIGINAL_ENV_ID;
    if (ORIGINAL_ENV_SLUG === undefined) delete process.env.DEFAULT_BUSINESS_SLUG;
    else process.env.DEFAULT_BUSINESS_SLUG = ORIGINAL_ENV_SLUG;
  });

  it('resolveBusinessId throws when no explicit slug/id is configured', async () => {
    const mod = await import('../tenant');
    await expect(mod.resolveBusinessId()).rejects.toThrow(/Tenant resolution failed/);
  });

  it('has no hardcoded Richmond default', async () => {
    const mod = await import('../tenant');
    expect(mod.DEFAULT_BUSINESS_SLUG).toBeNull();
  });

  it('resolveBusinessId honours DEFAULT_BUSINESS_ID env override without touching the DB', async () => {
    process.env.DEFAULT_BUSINESS_ID = '00000000-0000-0000-0000-000000000abc';
    vi.resetModules();
    const mod = await import('../tenant');
    await expect(mod.resolveBusinessId()).resolves.toBe('00000000-0000-0000-0000-000000000abc');
  });
});