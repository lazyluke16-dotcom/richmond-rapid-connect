import { describe, it, expect } from 'vitest';
import {
  clampOnboardingStep,
  deriveOnboardingStep,
  ServicesPayloadSchema,
  AreasPayloadSchema,
  HoursPayloadSchema,
  PlanPayloadSchema,
  ONBOARDING_STEP_MIN,
  ONBOARDING_STEP_MAX,
} from '../onboarding-validation';

describe('clampOnboardingStep', () => {
  it('clamps below range to min', () => {
    expect(clampOnboardingStep(-5)).toBe(ONBOARDING_STEP_MIN);
  });
  it('clamps above range to max', () => {
    expect(clampOnboardingStep(99)).toBe(ONBOARDING_STEP_MAX);
  });
  it('rejects non-finite values', () => {
    expect(clampOnboardingStep(Number.NaN)).toBe(0);
    expect(clampOnboardingStep('foo')).toBe(0);
    expect(clampOnboardingStep(undefined)).toBe(0);
  });
  it('truncates fractional steps', () => {
    expect(clampOnboardingStep(3.9)).toBe(3);
  });
  it('accepts numeric strings', () => {
    expect(clampOnboardingStep('4')).toBe(4);
  });
});

describe('deriveOnboardingStep', () => {
  const base = {
    hasBusiness: false,
    servicesCount: 0,
    areasCount: 0,
    hoursCount: 0,
    hasPlan: false,
    hasWebsiteCopy: false,
    completed: false,
  };
  it('returns 0 when there is no business yet', () => {
    expect(deriveOnboardingStep(base)).toBe(0);
  });
  it('returns max when onboarding is completed', () => {
    expect(deriveOnboardingStep({ ...base, completed: true })).toBe(ONBOARDING_STEP_MAX);
  });
  it('advances to branding once the business exists', () => {
    expect(deriveOnboardingStep({ ...base, hasBusiness: true })).toBeGreaterThanOrEqual(1);
  });
  it('never regresses when later data exists', () => {
    const s = deriveOnboardingStep({
      ...base,
      hasBusiness: true,
      servicesCount: 5,
      areasCount: 3,
      hoursCount: 7,
      hasPlan: true,
    });
    expect(s).toBeGreaterThanOrEqual(6);
  });
  it('never returns a value outside the allowed range', () => {
    const s = deriveOnboardingStep({
      hasBusiness: true,
      servicesCount: 1,
      areasCount: 1,
      hoursCount: 1,
      hasPlan: true,
      hasWebsiteCopy: true,
      completed: false,
    });
    expect(s).toBeGreaterThanOrEqual(ONBOARDING_STEP_MIN);
    expect(s).toBeLessThanOrEqual(ONBOARDING_STEP_MAX);
  });
});

describe('ServicesPayloadSchema', () => {
  it('rejects bad service_key characters', () => {
    const r = ServicesPayloadSchema.safeParse({
      services: [{ service_key: 'bad key!!', display_name: 'X' }],
    });
    expect(r.success).toBe(false);
  });
  it('accepts a valid payload', () => {
    const r = ServicesPayloadSchema.safeParse({
      services: [{ service_key: 'hot_water', display_name: 'Hot Water', active: true }],
    });
    expect(r.success).toBe(true);
  });
  it('caps the array length', () => {
    const many = Array.from({ length: 65 }).map((_, i) => ({
      service_key: `svc_${i}`,
      display_name: `S${i}`,
    }));
    expect(ServicesPayloadSchema.safeParse({ services: many }).success).toBe(false);
  });
});

describe('AreasPayloadSchema', () => {
  it('trims and requires suburb', () => {
    expect(AreasPayloadSchema.safeParse({ areas: [{ suburb: '' }] }).success).toBe(false);
  });
  it('accepts optional nullable state/postcode', () => {
    expect(
      AreasPayloadSchema.safeParse({
        areas: [{ suburb: 'Richmond', state: null, postcode: null }],
      }).success,
    ).toBe(true);
  });
});

describe('HoursPayloadSchema', () => {
  it('rejects malformed times', () => {
    expect(
      HoursPayloadSchema.safeParse({
        hours: [{ day_of_week: 1, closed: false, open_time: '9am', close_time: '5pm' }],
      }).success,
    ).toBe(false);
  });
  it('requires open_time < close_time when open', () => {
    expect(
      HoursPayloadSchema.safeParse({
        hours: [{ day_of_week: 1, closed: false, open_time: '17:00', close_time: '09:00' }],
      }).success,
    ).toBe(false);
  });
  it('accepts a closed day without times', () => {
    expect(
      HoursPayloadSchema.safeParse({
        hours: [{ day_of_week: 0, closed: true }],
      }).success,
    ).toBe(true);
  });
  it('rejects out-of-range day_of_week', () => {
    expect(
      HoursPayloadSchema.safeParse({
        hours: [{ day_of_week: 7, closed: true }],
      }).success,
    ).toBe(false);
  });
});

describe('PlanPayloadSchema', () => {
  it('accepts only known plans', () => {
    expect(PlanPayloadSchema.safeParse({ plan: 'missed_call_recovery' }).success).toBe(true);
    expect(PlanPayloadSchema.safeParse({ plan: 'ai_receptionist' }).success).toBe(true);
    expect(PlanPayloadSchema.safeParse({ plan: 'free' }).success).toBe(false);
  });
});