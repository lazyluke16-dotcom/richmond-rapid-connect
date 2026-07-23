import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * Route-boundary regression tests for the actual unauthenticated intake
 * paths (`/api/demo/trigger-sms` and `/api/webhooks/ai-phone-lead`).
 *
 * These tests prove the fail-closed contract at the route level: missing or
 * unresolved tenant identity MUST reject BEFORE any database insert, any
 * billing side effect, any outbound webhook, and MUST NOT fall back to a
 * default/Richmond tenant. Helper-only tests in `onboarding-step.test.ts`
 * cover the internal resolver; these tests cover the wired handler bodies.
 */

// --- Track every side effect a handler tries to perform. -------------------
const inserts: { table: string; row: unknown }[] = [];
const rpcCalls: { fn: string; args: unknown }[] = [];
const outboundWebhooks: unknown[] = [];
let slugLookup: (slug: string) => string | null = () => null;
let providerMappingLookup: (tokenHash: string) => string | null = () => null;
let resolveAiTenantResult: string | null = null;

function reset() {
  inserts.length = 0;
  rpcCalls.length = 0;
  outboundWebhooks.length = 0;
  slugLookup = () => null;
  providerMappingLookup = () => null;
  resolveAiTenantResult = null;
}

// Fake supabaseAdmin — any insert is recorded so the test can assert none
// happened on the reject path.
const fakeSupabaseAdmin = {
  from(table: string) {
    return {
      insert: async (row: unknown) => {
        inserts.push({ table, row });
        return { error: null };
      },
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: null }),
          }),
          maybeSingle: async () => ({ data: null }),
        }),
      }),
    };
  },
  rpc: async (fn: string, args: unknown) => {
    rpcCalls.push({ fn, args });
    if (fn === 'resolve_ai_tenant') return { data: resolveAiTenantResult };
    return { data: null };
  },
};

vi.mock('@/integrations/supabase/client.server', () => ({
  supabaseAdmin: fakeSupabaseAdmin,
}));

vi.mock('@/lib/tenant', () => ({
  DEFAULT_BUSINESS_SLUG: null,
  resolveBusinessId: async () => { throw new Error('Tenant resolution failed: no fallback'); },
  resolveBusinessIdBySlug: async (slug: string) => slugLookup(slug),
}));

vi.mock('@/lib/webhooks', () => ({
  fireOutboundWebhook: async (lead: unknown) => { outboundWebhooks.push(lead); },
}));

vi.mock('@/lib/missed-call.functions', () => ({
  renderSmsTemplate: (tpl: string) => tpl,
}));

// -----------------------------------------------------------------------------

function makeJsonRequest(url: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

describe('/api/demo/trigger-sms — route-boundary tenant contract', () => {
  beforeEach(reset);
  afterEach(reset);

  it('rejects with 400 when businessSlug is missing (no inserts, no side effects)', async () => {
    const { handleTriggerSms } = await import('../../routes/api/demo.trigger-sms');
    const res = await handleTriggerSms(
      makeJsonRequest('http://x/api/demo/trigger-sms', { callerPhone: '0400000000' }),
    );
    expect(res.status).toBe(400);
    const j = (await res.json()) as { error: string };
    expect(j.error).toMatch(/businessSlug/i);
    expect(inserts).toHaveLength(0);
    expect(outboundWebhooks).toHaveLength(0);
  });

  it('rejects with 400 when callerPhone is empty', async () => {
    const { handleTriggerSms } = await import('../../routes/api/demo.trigger-sms');
    const res = await handleTriggerSms(
      makeJsonRequest('http://x/api/demo/trigger-sms', { callerPhone: '   ', businessSlug: 'harbour' }),
    );
    expect(res.status).toBe(400);
    expect(inserts).toHaveLength(0);
  });

  it('rejects with 404 when businessSlug does not resolve (never inserts a missed_call or sms_event)', async () => {
    slugLookup = () => null; // Unknown slug — must NOT fall back to Richmond.
    const { handleTriggerSms } = await import('../../routes/api/demo.trigger-sms');
    const res = await handleTriggerSms(
      makeJsonRequest('http://x/api/demo/trigger-sms', {
        callerPhone: '0400000000',
        businessSlug: 'ghost-tenant-that-does-not-exist',
      }),
    );
    expect(res.status).toBe(404);
    const j = (await res.json()) as { error: string };
    expect(j.error).toMatch(/Unknown business slug/i);
    // Critical: NO writes hit missed_calls or sms_events on the reject path.
    expect(inserts.filter((i) => i.table === 'missed_calls')).toHaveLength(0);
    expect(inserts.filter((i) => i.table === 'sms_events')).toHaveLength(0);
  });
});

describe('/api/webhooks/ai-phone-lead — route-boundary tenant contract', () => {
  const ORIGINAL_SECRET = process.env.WEBHOOK_SECRET;

  beforeEach(() => {
    reset();
    process.env.WEBHOOK_SECRET = 'test-secret';
  });
  afterEach(() => {
    if (ORIGINAL_SECRET === undefined) delete process.env.WEBHOOK_SECRET;
    else process.env.WEBHOOK_SECRET = ORIGINAL_SECRET;
  });

  it('rejects with 401 on wrong secret before touching tenant lookup or inserts', async () => {
    const { handleAiPhoneLead } = await import('../../routes/api/webhooks.ai-phone-lead');
    const res = await handleAiPhoneLead(
      makeJsonRequest(
        'http://x/api/webhooks/ai-phone-lead',
        { provider_assistant_id: 'a1' },
        { 'x-webhook-secret': 'wrong' },
      ),
    );
    expect(res.status).toBe(401);
    expect(rpcCalls).toHaveLength(0);
    expect(inserts).toHaveLength(0);
    expect(outboundWebhooks).toHaveLength(0);
  });

  it('rejects with 503 when WEBHOOK_SECRET is not configured (fail closed)', async () => {
    delete process.env.WEBHOOK_SECRET;
    const { handleAiPhoneLead } = await import('../../routes/api/webhooks.ai-phone-lead');
    const res = await handleAiPhoneLead(
      makeJsonRequest('http://x/api/webhooks/ai-phone-lead', { provider_assistant_id: 'a1' }),
    );
    expect(res.status).toBe(503);
    expect(inserts).toHaveLength(0);
  });

  it('rejects with 404 when no trusted tenant mapping matches (no default/Richmond fallback)', async () => {
    resolveAiTenantResult = null; // Provider identifiers do not map anywhere.
    providerMappingLookup = () => null;
    const { handleAiPhoneLead } = await import('../../routes/api/webhooks.ai-phone-lead');
    const res = await handleAiPhoneLead(
      makeJsonRequest(
        'http://x/api/webhooks/ai-phone-lead',
        {
          provider: 'vapi',
          provider_assistant_id: 'assistant-that-does-not-exist',
          customer_name: 'Malicious Caller',
          customer_phone: '0400000000',
        },
        { 'x-webhook-secret': 'test-secret' },
      ),
    );
    expect(res.status).toBe(404);
    const j = (await res.json()) as { error: string };
    expect(j.error).toMatch(/Unknown tenant mapping/i);
    // Critical: no lead insert, no outbound webhook, no billing side effect.
    expect(inserts.filter((i) => i.table === 'leads')).toHaveLength(0);
    expect(outboundWebhooks).toHaveLength(0);
  });

  it('rejects with 404 when integration_token supplied but hash is unknown', async () => {
    // Integration-token path in the handler queries ai_provider_mappings.
    // Our fake returns null for that select chain, so businessId stays null
    // and the handler must fall through to resolve_ai_tenant (also null) and
    // then reject — proving no assumption of "trust the caller-supplied id".
    const { handleAiPhoneLead } = await import('../../routes/api/webhooks.ai-phone-lead');
    const res = await handleAiPhoneLead(
      makeJsonRequest(
        'http://x/api/webhooks/ai-phone-lead',
        { integration_token: 'attacker-supplied-token' },
        { 'x-webhook-secret': 'test-secret' },
      ),
    );
    expect(res.status).toBe(404);
    expect(inserts.filter((i) => i.table === 'leads')).toHaveLength(0);
  });

  it('ignores client-supplied business_id / business_slug (route never reads them)', async () => {
    resolveAiTenantResult = null;
    const { handleAiPhoneLead } = await import('../../routes/api/webhooks.ai-phone-lead');
    const res = await handleAiPhoneLead(
      makeJsonRequest(
        'http://x/api/webhooks/ai-phone-lead',
        {
          // Attacker attempts to inject tenant identity.
          business_id: '00000000-0000-0000-0000-000000000001',
          business_slug: 'richmond-rapid-plumbing',
          customer_name: 'Attacker',
        },
        { 'x-webhook-secret': 'test-secret' },
      ),
    );
    expect(res.status).toBe(404);
    expect(inserts.filter((i) => i.table === 'leads')).toHaveLength(0);
    // The RPC must have been called with null identifiers — proving the
    // client-supplied business_id/slug were NOT trusted.
    const rpc = rpcCalls.find((r) => r.fn === 'resolve_ai_tenant');
    expect(rpc).toBeDefined();
    const args = rpc!.args as { _assistant_id: unknown; _phone_id: unknown; _phone_number: unknown };
    expect(args._assistant_id).toBeNull();
    expect(args._phone_id).toBeNull();
    expect(args._phone_number).toBeNull();
  });
});

describe('getOnboardingStatus pre-migration column detection', () => {
  it('flags SQLSTATE 42703 as missing onboarding_step', async () => {
    const { isMissingOnboardingStepError } = await import('../onboarding.functions');
    expect(isMissingOnboardingStepError({ code: '42703', message: 'anything' })).toBe(true);
  });
  it('flags PostgREST "column ... does not exist" text', async () => {
    const { isMissingOnboardingStepError } = await import('../onboarding.functions');
    expect(
      isMissingOnboardingStepError({ message: 'column businesses.onboarding_step does not exist' }),
    ).toBe(true);
  });
  it('flags PostgREST "could not find" schema-cache errors', async () => {
    const { isMissingOnboardingStepError } = await import('../onboarding.functions');
    expect(
      isMissingOnboardingStepError({ message: "Could not find the 'onboarding_step' column of 'businesses' in the schema cache" }),
    ).toBe(true);
  });
  it('does not mask unrelated errors', async () => {
    const { isMissingOnboardingStepError } = await import('../onboarding.functions');
    expect(isMissingOnboardingStepError({ code: '23505', message: 'duplicate key' })).toBe(false);
    expect(isMissingOnboardingStepError({ message: 'permission denied for table businesses' })).toBe(false);
    expect(isMissingOnboardingStepError(null)).toBe(false);
  });
});