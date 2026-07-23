// Pure enrichment logic — no Supabase, Vapi, or HTTP dependencies at module level.
// Imported by the processor route and all unit/integration tests.
import type { JobType } from './leads';

// Maximum jobs claimed during one processor invocation.
// Shared with the processor route so its caller-timeout budget remains bounded.
export const ENRICHMENT_BATCH_LIMIT = 3;

export type EnrichmentJob = {
  id: string;
  call_id: string;
  lead_id: string;
  business_id: string;
  attempt_count: number;
  max_attempts: number;
};

export type CurrentLeadValues = {
  id: string;
  business_id: string;
  name: string;
  phone: string | null;
  suburb: string;
  job_type: string;
  urgency: string | null;
  best_time: string | null;
  ai_summary: string | null;
  external_call_id?: string | null;
};

export interface ProcessJobDeps {
  getVapiCall: (id: string) => Promise<Record<string, unknown>>;
  getLead: (leadId: string) => Promise<CurrentLeadValues | null>;
  updateLead: (leadId: string, businessId: string, updates: Record<string, unknown>) => Promise<{ error: string | null }>;
  markCompleted: (jobId: string) => Promise<void>;
  markFailed: (jobId: string, reason: string) => Promise<void>;
  scheduleRetry: (jobId: string, attempt: number, reason: string) => Promise<void>;
}

export type JobResult = {
  outcome: 'completed' | 'retry_scheduled' | 'failed';
  error?: string;
  fields?: string[];
};

const VAPI_JOB_TYPE_MAP: Record<string, JobType> = {
  burst_pipe:     'burst-pipe',
  blocked_drain:  'blocked-drain',
  hot_water:      'hot-water',
  leaking_tap:    'leaking-tap',
  'burst-pipe':   'burst-pipe',
  'blocked-drain':'blocked-drain',
  'hot-water':    'hot-water',
  'leaking-tap':  'leaking-tap',
  toilet:         'toilet',
  gas:            'gas',
  other:          'other',
  gas_leak:       'gas',
  gas_issue:      'gas',
  hot_water_system: 'hot-water',
  dripping_tap:   'leaking-tap',
  leaking_faucet: 'leaking-tap',
  faucet:         'leaking-tap',
  burst:          'burst-pipe',
  pipe_burst:     'burst-pipe',
  drain:          'blocked-drain',
  emergency:      'other',
  general:        'other',
  unknown:        'other',
};

export function normalizeVapiJobType(value: string | undefined): JobType {
  if (!value) return 'other';
  return VAPI_JOB_TYPE_MAP[value.toLowerCase().trim()] ?? 'other';
}

export function needsEnrichment(sd: Record<string, string | undefined>): boolean {
  return (
    !sd.customer_name || sd.customer_name === 'Unknown caller' ||
    !sd.callback_number ||
    !sd.suburb || sd.suburb === 'unknown' ||
    !sd.job_type ||
    !sd.urgency ||
    !sd.callback_preference
  );
}

export function needsLeadEnrichment(
  lead: Pick<CurrentLeadValues, 'name' | 'phone' | 'suburb' | 'job_type' | 'urgency' | 'best_time'>,
): boolean {
  return (
    !lead.name || lead.name === 'Unknown caller' ||
    !lead.phone ||
    !lead.suburb || lead.suburb === 'unknown' ||
    !lead.job_type || lead.job_type === 'other' ||
    !lead.urgency ||
    !lead.best_time
  );
}

export function buildLeadUpdates(
  sd: Record<string, string | undefined>,
  summary: string | undefined,
): Record<string, unknown> {
  const updates: Record<string, unknown> = {};
  if (sd.customer_name && sd.customer_name !== 'Unknown caller') updates.name = sd.customer_name;
  if (sd.callback_number) updates.phone = sd.callback_number;
  if (sd.suburb && sd.suburb !== 'unknown') updates.suburb = sd.suburb;
  if (sd.job_type) updates.job_type = normalizeVapiJobType(sd.job_type);
  if (sd.urgency) updates.urgency = sd.urgency;
  if (sd.callback_preference) updates.best_time = sd.callback_preference;
  if (summary) updates.ai_summary = summary;
  return updates;
}

export function guardExistingValues(
  updates: Record<string, unknown>,
  current: CurrentLeadValues,
): Record<string, unknown> {
  const safe = { ...updates };
  if (safe.job_type === 'other' && current.job_type !== 'other') {
    delete safe.job_type;
  }
  if (safe.urgency === 'today' && current.urgency && current.urgency !== 'today') {
    delete safe.urgency;
  }
  return safe;
}

export function retryDelaySec(attempt: number): number {
  return Math.min(60 * (attempt + 1), 300);
}

export function isValidEnrichmentTarget(leadBusinessId: string, jobBusinessId: string): boolean {
  return Boolean(leadBusinessId) && leadBusinessId === jobBusinessId;
}

function getMissingFields(sd: Record<string, string | undefined>): string[] {
  const missing: string[] = [];
  if (!sd.customer_name || sd.customer_name === 'Unknown caller') missing.push('customer_name');
  if (!sd.callback_number) missing.push('callback_number');
  if (!sd.suburb || sd.suburb === 'unknown') missing.push('suburb');
  if (!sd.job_type) missing.push('job_type');
  if (!sd.urgency) missing.push('urgency');
  if (!sd.callback_preference) missing.push('callback_preference');
  return missing;
}

export async function processJob(job: EnrichmentJob, deps: ProcessJobDeps): Promise<JobResult> {
  const lead = await deps.getLead(job.lead_id);
  if (!lead) {
    await deps.markFailed(job.id, 'lead_not_found');
    return { outcome: 'failed', error: 'lead_not_found' };
  }
  if (!isValidEnrichmentTarget(lead.business_id, job.business_id)) {
    await deps.markFailed(job.id, 'tenant_mismatch');
    return { outcome: 'failed', error: 'tenant_mismatch' };
  }
  if (lead.external_call_id && lead.external_call_id !== job.call_id) {
    await deps.markFailed(job.id, 'call_lead_mismatch');
    return { outcome: 'failed', error: 'call_lead_mismatch' };
  }

  let remoteCall: Record<string, unknown>;
  try {
    remoteCall = await deps.getVapiCall(job.call_id);
  } catch (e) {
    // Sanitized category — never propagate raw upstream error text (may contain
    // headers, tokens, response bodies, or transcript fragments).
    void e;
    const reason = 'vapi_fetch_failed';
    if (job.attempt_count + 1 >= job.max_attempts) {
      await deps.markFailed(job.id, 'vapi_fetch_failed_max_attempts');
      return { outcome: 'failed', error: 'vapi_fetch_failed' };
    }
    await deps.scheduleRetry(job.id, job.attempt_count, reason);
    return { outcome: 'retry_scheduled', error: reason };
  }

  const analysis = (remoteCall as {
    analysis?: { structuredData?: Record<string, string | undefined>; summary?: string };
  }).analysis;
  const sd = analysis?.structuredData ?? {};
  const summary = analysis?.summary;

  const rawUpdates = buildLeadUpdates(sd, summary);
  const updates = guardExistingValues(rawUpdates, lead);

  if (Object.keys(updates).length > 0) {
    const result = await deps.updateLead(job.lead_id, job.business_id, updates);
    if (result.error) {
      // Sanitized category — do not propagate raw DB error text or row content.
      void result.error;
      if (job.attempt_count + 1 >= job.max_attempts) {
        await deps.markFailed(job.id, 'lead_update_failed_max_attempts');
        return { outcome: 'failed', error: 'lead_update_failed_max_attempts' };
      }
      await deps.scheduleRetry(job.id, job.attempt_count, 'lead_update_failed');
      return { outcome: 'retry_scheduled', error: 'lead_update_failed' };
    }
  }

  if (!needsEnrichment(sd)) {
    await deps.markCompleted(job.id);
    return { outcome: 'completed', fields: Object.keys(updates) };
  }

  if (job.attempt_count + 1 >= job.max_attempts) {
    const missing = getMissingFields(sd);
    await deps.markFailed(job.id, `analysis_incomplete_max_attempts: ${missing.join(',')}`);
    return { outcome: 'failed', error: 'analysis_incomplete_max_attempts', fields: Object.keys(updates) };
  }

  // Field names only — never include structured-data values.
  const missing = getMissingFields(sd);
  const reason = `analysis_incomplete:${missing.join(',')}`;
  await deps.scheduleRetry(job.id, job.attempt_count, reason);
  return { outcome: 'retry_scheduled', fields: Object.keys(updates) };
}