// Server-only Vapi API client. Never import from client-reachable modules at
// top level. Load inside server function handlers only.
const VAPI_BASE = process.env.VAPI_API_BASE ?? "https://api.vapi.ai";

// Bounds each Vapi request so the processor can handle an unavailable upstream
// service and persist a retry while its calling HTTP request remains active.
// This must remain comfortably below the explicit pg_net caller timeout.
export const VAPI_REQUEST_TIMEOUT_MS = 8_000;

function vapiKey(): string {
  const k = process.env.VAPI_API_KEY ?? process.env.VAPI_PRIVATE_KEY ?? "";
  if (!k) throw new Error("VAPI_API_KEY missing — configure the Vapi private API key server-side");
  return k;
}

async function vapi<T>(path: string, init: RequestInit = {}): Promise<T> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), VAPI_REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(`${VAPI_BASE}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${vapiKey()}`,
        "Content-Type": "application/json",
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
  serverCredentialId?: string;
  recordingEnabled?: boolean;
  maxDurationSeconds?: number;
  structuredDataSchema?: Record<string, unknown>;
  tools?: Record<string, unknown>[];
  serverMessages?: string[];
}

export function buildVapiAssistantBody(cfg: VapiAssistantConfig): Record<string, unknown> {
  const schema = cfg.structuredDataSchema ?? {
    type: "object",
    properties: {
      call_disposition: {
        type: "string",
        enum: ["plumbing_enquiry", "message"],
        description:
          "Use plumbing_enquiry for a customer/prospect seeking plumbing service; otherwise use message.",
      },
      customer_name: { type: "string" },
      callback_number: { type: "string" },
      suburb: { type: "string" },
      job_type: { type: "string" },
      job_description: { type: "string" },
      urgency: { type: "string", enum: ["now", "today", "few-days", "flexible"] },
      callback_preference: { type: "string" },
      caller_company: { type: "string" },
      message_text: { type: "string" },
      callback_requested: { type: "boolean" },
      message_urgency: { type: "string", enum: ["normal", "urgent"] },
      ai_summary: { type: "string" },
    },
    required: ["call_disposition", "customer_name", "callback_number", "ai_summary"],
  };

  return {
    name: cfg.name,
    firstMessage: cfg.firstMessage,
    model: {
      provider: "openai",
      model: "gpt-4o-mini",
      messages: [{ role: "system", content: cfg.systemPrompt }],
      tools: cfg.tools?.length ? cfg.tools : undefined,
    },
    voice: { provider: "11labs", voiceId: "sarah" },
    transcriber: {
      provider: "deepgram",
      model: "nova-2",
      language: cfg.language ?? "en-AU",
    },
    endCallFunctionEnabled: true,
    recordingEnabled: cfg.recordingEnabled ?? false,
    maxDurationSeconds: cfg.maxDurationSeconds ?? 300,
    server:
      cfg.serverUrl && cfg.serverCredentialId
        ? {
            url: cfg.serverUrl,
            credentialId: cfg.serverCredentialId,
          }
        : undefined,
    serverMessages: cfg.serverMessages ?? ["end-of-call-report"],
    analysisPlan: {
      structuredDataPlan: {
        enabled: true,
        schema,
      },
      summaryPlan: {
        enabled: true,
        messages: [
          {
            role: "system",
            content:
              "Summarise the call in 1-2 sentences. For plumbing enquiries capture the job and urgency; for other callers capture who called and the message.",
          },
        ],
      },
    },
  };
}

export async function createVapiAssistant(cfg: VapiAssistantConfig): Promise<{ id: string }> {
  return vapi("/assistant", { method: "POST", body: JSON.stringify(buildVapiAssistantBody(cfg)) });
}

export async function updateVapiAssistant(
  id: string,
  cfg: VapiAssistantConfig,
): Promise<{ id: string }> {
  return vapi(`/assistant/${id}`, {
    method: "PATCH",
    body: JSON.stringify(buildVapiAssistantBody(cfg)),
  });
}

export async function getVapiAssistant(id: string): Promise<Record<string, unknown>> {
  return vapi(`/assistant/${id}`, { method: "GET" });
}

export function vapiSipHost(): string {
  return VAPI_BASE.includes("api.eu.vapi.ai") ? "sip.eu.vapi.ai" : "sip.vapi.ai";
}

export async function createVapiSipPhoneNumber(input: {
  assistantId: string;
  sipUser: string;
  name: string;
  username?: string | null;
  password?: string | null;
}): Promise<{ id: string; sipUri?: string }> {
  const host = vapiSipHost();
  const sipUri = `sip:${input.sipUser}@${host}`;
  const authentication =
    input.username && input.password
      ? {
          realm: host,
          username: input.username,
          password: input.password,
        }
      : undefined;
  return vapi("/phone-number", {
    method: "POST",
    body: JSON.stringify({
      provider: "vapi",
      sipUri,
      assistantId: input.assistantId,
      name: input.name,
      authentication,
    }),
  });
}

export async function deleteVapiPhoneNumber(id: string): Promise<void> {
  await vapi(`/phone-number/${id}`, { method: "DELETE" });
}

export async function resolveVapiServerCredentialId(
  serverUrl: string,
  currentAssistantId?: string,
): Promise<string> {
  const configured = process.env.VAPI_SERVER_CREDENTIAL_ID?.trim();
  if (configured) return configured;

  if (currentAssistantId) {
    const current = await getVapiAssistant(currentAssistantId);
    const credentialId = (
      current.server as { credentialId?: string } | undefined
    )?.credentialId?.trim();
    if (credentialId) return credentialId;
  }

  const assistants = await vapi<Record<string, unknown>[]>("/assistant", { method: "GET" });
  for (const assistant of assistants) {
    const server = assistant.server as { url?: string; credentialId?: string } | undefined;
    if (server?.url === serverUrl && server.credentialId?.trim()) {
      return server.credentialId.trim();
    }
  }

  throw new Error(
    "VAPI_SERVER_CREDENTIAL_ID missing — configure a reusable encrypted Vapi custom credential for X-Vapi-Secret",
  );
}

export async function deleteVapiAssistant(id: string): Promise<void> {
  await vapi(`/assistant/${id}`, { method: "DELETE" });
}

/**
 * Fetch the authoritative call record from Vapi. Used as a fallback when the
 * end-of-call webhook payload does not include a trustworthy duration.
 * Server-only.
 */
export async function getVapiCall(id: string): Promise<Record<string, unknown>> {
  return vapi(`/call/${id}`, { method: "GET" });
}

export function vapiCredentialsAvailable(): boolean {
  return Boolean(process.env.VAPI_API_KEY ?? process.env.VAPI_PRIVATE_KEY);
}
