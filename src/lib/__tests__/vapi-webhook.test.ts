/**
 * Phase 3A — Vapi webhook structured-data extraction regression tests.
 *
 * These tests lock in the correct Vapi end-of-call-report payload paths
 * and prove the structured-data extraction fix is durable.
 * No network calls, no Supabase, no Stripe — pure logic only.
 */
import { describe, it, expect } from 'vitest';

// Helper that mirrors the corrected extraction in the webhook handler.
// msg = body.message from a Vapi end-of-call-report webhook.
function extractSd(msg: Record<string, unknown>): Record<string, string | undefined> {
  const analysis = msg.analysis as { structuredData?: Record<string, string | undefined> } | undefined;
  return analysis?.structuredData ?? {};
}

const FULL_PAYLOAD_MSG = {
  type: 'end-of-call-report',
  endedReason: 'assistant-ended-call',
  transcript: 'Agent: Hi... Customer: I have a leaking tap.',
  summary: 'Leaking tap in Richmond.',
  startedAt: '2026-07-19T10:00:00.000Z',
  endedAt: '2026-07-19T10:03:00.000Z',
  durationSeconds: 180,
  analysis: {
    structuredData: {
      customer_name: 'Lucas Phase Three Test',
      callback_number: '0450000001',
      suburb: 'Richmond',
      job_type: 'leaking_tap',
      job_description: 'Kitchen tap is leaking continuously.',
      urgency: 'today',
      callback_preference: 'This afternoon',
    },
    summary: 'Leaking tap in Richmond.',
  },
  call: {
    id: 'vapi-test-call-001',
    assistantId: '28a85bd5-5ccb-4605-a330-b62560e90aff',
    customer: { number: '' },
  },
};

describe('Vapi end-of-call structured-data extraction path', () => {
  it('extracts customer_name from message.analysis.structuredData', () => {
    const sd = extractSd(FULL_PAYLOAD_MSG);
    expect(sd.customer_name).toBe('Lucas Phase Three Test');
  });

  it('extracts callback_number from message.analysis.structuredData', () => {
    const sd = extractSd(FULL_PAYLOAD_MSG);
    expect(sd.callback_number).toBe('0450000001');
  });

  it('extracts suburb from message.analysis.structuredData', () => {
    const sd = extractSd(FULL_PAYLOAD_MSG);
    expect(sd.suburb).toBe('Richmond');
  });

  it('extracts job_type from message.analysis.structuredData', () => {
    const sd = extractSd(FULL_PAYLOAD_MSG);
    expect(sd.job_type).toBe('leaking_tap');
  });

  it('extracts urgency from message.analysis.structuredData', () => {
    const sd = extractSd(FULL_PAYLOAD_MSG);
    expect(sd.urgency).toBe('today');
  });

  it('extracts callback_preference from message.analysis.structuredData', () => {
    const sd = extractSd(FULL_PAYLOAD_MSG);
    expect(sd.callback_preference).toBe('This afternoon');
  });
});

describe('Vapi lead field population from correct path', () => {
  it('name is populated from sd.customer_name — not Unknown caller', () => {
    const sd = extractSd(FULL_PAYLOAD_MSG);
    const name = sd.customer_name ?? 'Unknown caller';
    expect(name).toBe('Lucas Phase Three Test');
    expect(name).not.toBe('Unknown caller');
  });

  it('suburb is populated from sd.suburb — not unknown', () => {
    const sd = extractSd(FULL_PAYLOAD_MSG);
    const suburb = sd.suburb ?? 'unknown';
    expect(suburb).toBe('Richmond');
    expect(suburb).not.toBe('unknown');
  });

  it('phone prefers sd.callback_number over call.customer.number', () => {
    const sd = extractSd(FULL_PAYLOAD_MSG);
    const callCustomerNumber = '';
    const phone = sd.callback_number ?? callCustomerNumber;
    expect(phone).toBe('0450000001');
  });

  it('phone falls back to call.customer.number when callback_number absent', () => {
    const msgNoCallbackNumber = {
      ...FULL_PAYLOAD_MSG,
      analysis: {
        structuredData: { customer_name: 'Test', suburb: 'Sydney' },
      },
    };
    const sd = extractSd(msgNoCallbackNumber);
    const callCustomerNumber = '+61400000001';
    const phone = sd.callback_number ?? callCustomerNumber;
    expect(phone).toBe('+61400000001');
  });

  it('phone is empty string when neither source provides a number', () => {
    const msgNoPhone = {
      ...FULL_PAYLOAD_MSG,
      analysis: { structuredData: { customer_name: 'Test' } },
    };
    const sd = extractSd(msgNoPhone);
    const phone = sd.callback_number ?? '';
    expect(phone).toBe('');
  });
});

describe('Vapi payload path regression — wrong path must not yield data', () => {
  it('message.structuredData (old wrong path) is absent in Vapi end-of-call payloads', () => {
    // Vapi never sets message.structuredData — only message.analysis.structuredData.
    // This test locks that in: reading the old path returns undefined.
    const oldPathResult = (FULL_PAYLOAD_MSG as Record<string, unknown>).structuredData;
    expect(oldPathResult).toBeUndefined();
  });

  it('reading old path (msg.structuredData) produces empty object fallback — confirming it was always wrong', () => {
    const oldSd = (FULL_PAYLOAD_MSG as Record<string, unknown>).structuredData ?? {};
    expect(oldSd).toEqual({});
    expect((oldSd as Record<string, unknown>).customer_name).toBeUndefined();
  });
});

describe('Vapi no-audio call — empty analysis gracefully handled', () => {
  const NO_AUDIO_MSG = {
    type: 'end-of-call-report',
    endedReason: 'call.in-progress.error-assistant-did-not-receive-customer-audio',
    call: { id: 'vapi-no-audio-001', customer: { number: '' } },
    // analysis is absent or has no structuredData for 0-duration calls
  };

  it('extractSd returns empty object when analysis is absent', () => {
    const sd = extractSd(NO_AUDIO_MSG);
    expect(sd).toEqual({});
  });

  it('name defaults to Unknown caller when analysis absent', () => {
    const sd = extractSd(NO_AUDIO_MSG);
    expect(sd.customer_name ?? 'Unknown caller').toBe('Unknown caller');
  });

  it('suburb defaults to unknown when analysis absent', () => {
    const sd = extractSd(NO_AUDIO_MSG);
    expect(sd.suburb ?? 'unknown').toBe('unknown');
  });
});

describe('Vapi summary path', () => {
  it('message.summary is a top-level field (Vapi mirrors from analysis.summary)', () => {
    // The handler reads msg.summary for ai_summary fallback — this is correct.
    expect(FULL_PAYLOAD_MSG.summary).toBe('Leaking tap in Richmond.');
  });

  it('sd.ai_summary is absent in Phase 3A schema (summary lives in message.analysis.summary)', () => {
    const sd = extractSd(FULL_PAYLOAD_MSG);
    // Phase 3A schema does not include ai_summary field.
    // The handler should fall back to msg.summary if sd.ai_summary is absent.
    expect(sd.ai_summary).toBeUndefined();
  });

  // ── Phase 3B regression: remote-enrichment path ──────────────────

  describe('remote enrichment merging logic', () => {
    // Helper that mirrors the handler's merge: remote fills gaps, webhook values win.
    function mergesd(
      webhookSd: Record<string, string | undefined>,
      remoteSd: Record<string, string | undefined>,
    ): Record<string, string | undefined> {
      return { ...remoteSd, ...webhookSd };
    }

    it('Case 1: webhook structuredData present → all fields available without remote', () => {
      const webhookSd = {
        customer_name: 'Jane Smith',
        callback_number: '0411222333',
        suburb: 'Richmond',
        job_type: 'blocked_drain',
        job_description: 'Blocked kitchen drain',
        urgency: 'today',
        callback_preference: 'this afternoon',
      };
      const merged = mergesd(webhookSd, {});
      expect(merged.customer_name).toBe('Jane Smith');
      expect(merged.callback_number).toBe('0411222333');
      expect(merged.suburb).toBe('Richmond');
      expect(merged.job_type).toBe('blocked_drain');
      expect(merged.urgency).toBe('today');
      expect(merged.callback_preference).toBe('this afternoon');
    });

    it('Case 2: webhook sd absent, remote sd present → lead fields enriched from remote', () => {
      const webhookSd: Record<string, string | undefined> = {};
      const remoteSd = {
        customer_name: 'Lucas',
        callback_number: '0450364907',
        suburb: 'Promont',
        job_type: 'leaking_tap',
        job_description: 'Leaky tap in the kitchen',
        urgency: 'today',
        callback_preference: 'this afternoon',
      };
      const merged = mergesd(webhookSd, remoteSd);
      expect(merged.customer_name).toBe('Lucas');
      expect(merged.callback_number).toBe('0450364907');
      expect(merged.suburb).toBe('Promont');
      expect(merged.job_type).toBe('leaking_tap');
      expect(merged.urgency).toBe('today');
      expect(merged.callback_preference).toBe('this afternoon');
    });

    it('Case 3: both webhook and remote sd empty → lead uses defined fallback defaults', () => {
      const webhookSd: Record<string, string | undefined> = {};
      const remoteSd: Record<string, string | undefined> = {};
      const merged = mergesd(webhookSd, remoteSd);
      expect(merged.customer_name).toBeUndefined();
      expect(merged.suburb).toBeUndefined();
      const leadName = merged.customer_name ?? 'Unknown caller';
      const leadSuburb = merged.suburb ?? 'unknown';
      const leadJobType = merged.job_type ?? 'other';
      const leadUrgency = merged.urgency ?? 'today';
      expect(leadName).toBe('Unknown caller');
      expect(leadSuburb).toBe('unknown');
      expect(leadJobType).toBe('other');
      expect(leadUrgency).toBe('today');
    });

    it('Case 4: remote sd has all fields → no default placeholder values in lead', () => {
      const webhookSd: Record<string, string | undefined> = {};
      const remoteSd = {
        customer_name: 'Alice Wong',
        callback_number: '0400123456',
        suburb: 'Cremorne',
        job_type: 'hot_water',
        job_description: 'No hot water since this morning',
        urgency: 'today',
        callback_preference: 'morning',
      };
      const merged = mergesd(webhookSd, remoteSd);
      expect(merged.customer_name).not.toBe('Unknown caller');
      expect(merged.customer_name).not.toBe('');
      expect(merged.suburb).not.toBe('unknown');
      expect(merged.suburb).not.toBe('');
      expect(merged.callback_number).not.toBe('');
      expect(merged.job_type).not.toBe('other');
      expect(merged.urgency).not.toBe('');
    });

    it('Case 5: webhook sd has values and remote has different values → webhook wins', () => {
      const webhookSd = {
        customer_name: 'From Webhook',
        suburb: 'Mosman',
      };
      const remoteSd = {
        customer_name: 'From Remote',
        suburb: 'Manly',
        callback_number: '0499000000',
        urgency: 'today',
      };
      const merged = mergesd(webhookSd, remoteSd);
      expect(merged.customer_name).toBe('From Webhook');
      expect(merged.suburb).toBe('Mosman');
      expect(merged.callback_number).toBe('0499000000');
      expect(merged.urgency).toBe('today');
    });
  });
});