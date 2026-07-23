// Server-only Vapi API client. Never import from client-reachable modules at
// top level. Load inside server function handlers only.
const VAPI_BASE = process.env.VAPI_API_BASE ?? 'https://api.vapi.ai';

// Bounds each Vapi request so the processor can handle an unavailable upstream
// service and persist a retry while its calling HTTP request remains active.
// This must remain comfortably below the explicit pg_net caller timeout.
export const VAPI_REQUEST_TIMEOUT_MS = 8_000;

function vapiKey(): string {
  const k = process.env.VAPI_API_KEY ?? process.env.VAPI_PRIVATE_KEY ?? '';
  if (!k) throw new Error('VAPI_API_KEY missing — configure the Vapi private API key server-side');
  return k;
}

async function vapi<T>(path: string, init: RequestInit = {}): Promise<T> {
  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(),
    VAPI_REQUEST_TIMEOUT_MS,
  );

  try {
    const res = await fetch(`${VAPI_BASE}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${vapiKey()}`,
        'Content-Type': 'application/json',
        ...(init.headers ?? {}),
      },
    });

    const text = await res.text();

    if (!res.ok) {
      throw new Error(`Vapi ${res.status}: ${text.slice(0, 400)}`);
    }

    return text ? (JSON.parse(text) as T) : ({} as T);
  } finally {
    clearTimeout(timeoutId);
  }
}

export interface VapiAssistantConfig {
  name: string;
  firstMessage: string;
  systemPrompt: string;
  language?: string;
  serverUrl?: string;
  serverSecret?: string;
  recordingEnabled?: boolean;
  maxDurationSeconds?: number;
  structuredDataSchema?: Record<string, unknown>;
}

function buildAssistantBody(cfg: VapiAssistantConfig): Record<string, unknown> {
  const schema = cfg.structuredDataSchema ?? {
    type: 'object',
    properties: {
      customer_name: { type: 'string' },
      customer_phone: { type: 'string' },
      suburb: { type: 'string' },
      job_type: { type: 'string' },
      job_description: { type: 'string' },
      urgency: { type: 'string', enum: ['now', 'today', 'few-days', 'flexible'] },
      callback_preference: { type: 'string' },
      ai_summary: { type: 'string' },
    },
    required: ['customer_name', 'suburb', 'job_description', 'urgency'],
  };

  return {
    name: cfg.name,
    firstMessage: cfg.firstMessage,
    model: {
      provider: 'openai',
      model: 'gpt-4o-mini',
      messages: [{ role: 'system', content: cfg.systemPrompt }],
    },
    voice: { provider: '11labs', voiceId: 'sarah' },
    transcriber: { provider: 'deepgram', model: 'nova-2', language: 'en-AU' },
    endCallFunctionEnabled: true,
    recordingEnabled: cfg.recordingEnabled ?? false,
    maxDurationSeconds: cfg.maxDurationSeconds ?? 300,
    serverUrl: cfg.serverUrl,
    serverUrlSecret: cfg.serverSecret,
    analysisPlan: {
      structuredDataSchema: schema,
      summaryPrompt: 'Summarise the plumbing enquiry in 1-2 sentences.',
    },
  };
}

export async function createVapiAssistant(cfg: VapiAssistantConfig): Promise<{ id: string }> {
  return vapi('/assistant', { method: 'POST', body: JSON.stringify(buildAssistantBody(cfg)) });
}

export async function updateVapiAssistant(id: string, cfg: VapiAssistantConfig): Promise<{ id: string }> {
  return vapi(`/assistant/${id}`, { method: 'PATCH', body: JSON.stringify(buildAssistantBody(cfg)) });
}

export async function getVapiAssistant(id: string): Promise<Record<string, unknown>> {
  return vapi(`/assistant/${id}`, { method: 'GET' });
}

export async function deleteVapiAssistant(id: string): Promise<void> {
  await vapi(`/assistant/${id}`, { method: 'DELETE' });
}

/**
 * Fetch the authoritative call record from Vapi. Used as a fallback when the
 * end-of-call webhook payload does not include a trustworthy duration.
 * Server-only.
 */
export async function getVapiCall(id: string): Promise<Record<string, unknown>> {
  return vapi(`/call/${id}`, { method: 'GET' });
}

export function vapiCredentialsAvailable(): boolean {
  return Boolean(process.env.VAPI_API_KEY ?? process.env.VAPI_PRIVATE_KEY);
}