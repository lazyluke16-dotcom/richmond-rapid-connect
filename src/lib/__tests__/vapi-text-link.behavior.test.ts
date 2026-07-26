import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const supabaseMock = vi.hoisted(() => ({
  rpc: vi.fn(),
  from: vi.fn(),
}));

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: supabaseMock,
}));

type Mode = "off" | "text_link" | "ai_receptionist";

type Tenant = {
  business_id: string;
  answering_mode: Mode;
  forwarding_setup_status: string;
  business_name: string;
  business_slug: string;
  public_phone: string;
  assistant_id: string | null;
  sms_template: string;
  text_link_entitled: boolean;
  ai_receptionist_entitled: boolean;
  phone_id: string;
  phone_number: string;
};

type ProviderEvent = {
  provider: string;
  providerEventId: string;
  businessId: string;
  status: "claimed" | "sending" | "reconciling" | "sent" | "failed";
  claimToken: string | null;
  claimExpiresAt: number | null;
  missedCallId: string;
  smsEventId: string;
  providerMessageSid: string | null;
  providerStatus: string | null;
  sendStartedAt: string | null;
  providerAttempted: boolean;
  toNumber: string | null;
  fromNumber: string | null;
  smsBody: string | null;
  failureKind: "pre_send" | "provider_rejected" | null;
};

type ProviderMessage = {
  sid: string;
  status: string;
  to: string;
  from: string;
  body: string;
  date_created: string;
  date_sent: string;
};

const tenants: Tenant[] = [];
const providerEvents = new Map<string, ProviderEvent>();
const missedCalls: Record<string, unknown>[] = [];
const smsEvents: Record<string, unknown>[] = [];
const usageRows: Record<string, unknown>[] = [];
const providerMessages: ProviderMessage[] = [];
const leadRows: Record<string, unknown>[] = [];
const voiceUsageRows: Record<string, unknown>[] = [];
let providerPostCount = 0;
let providerGetCount = 0;
let providerFailure: string | null = null;
let providerOutcomeUncertain = false;
let failCompletionOnce = false;
let deferredProviderResponse:
  | {
      promise: Promise<Response>;
      resolve: (response: Response) => void;
    }
  | undefined;

function eventKey(provider: string, eventId: string): string {
  return `${provider}:inbound_call:${eventId}`;
}

function responseJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function dispatchPayload(event: ProviderEvent, action: string) {
  return {
    action,
    status: event.status,
    claimToken:
      action === "busy" || action === "sent" || action === "failed" ? null : event.claimToken,
    missedCallId: event.missedCallId,
    smsEventId: event.smsEventId,
    providerMessageSid: event.providerMessageSid,
    sendStartedAt: event.sendStartedAt,
    toNumber: event.toNumber,
    fromNumber: event.fromNumber,
    smsBody: event.smsBody,
  };
}

function makeTenant(mode: Mode, suffix: string, overrides: Partial<Tenant> = {}): Tenant {
  return {
    business_id: `00000000-0000-0000-0000-0000000000${suffix}`,
    answering_mode: mode,
    forwarding_setup_status: "verified",
    business_name: `Tenant ${suffix}`,
    business_slug: `tenant-${suffix}`,
    public_phone: `+613900000${suffix}`,
    assistant_id: mode === "ai_receptionist" ? `assistant-${suffix}` : null,
    sms_template: "{{business_name}}: {{recovery_link}} ({{public_phone}})",
    text_link_entitled: true,
    ai_receptionist_entitled: true,
    phone_id: `phone-${suffix}`,
    phone_number: `+613800000${suffix}`,
    ...overrides,
  };
}

function installFakeDatabase() {
  supabaseMock.from.mockImplementation((table: string) => ({
    insert: async (row: Record<string, unknown>) => {
      if (table === "leads") leadRows.push(row);
      if (table === "billing_usage_events" && row.usage_type === "ai_voice_seconds") {
        voiceUsageRows.push(row);
      }
      return { error: null };
    },
  }));
  supabaseMock.rpc.mockImplementation(async (name: string, args: Record<string, unknown>) => {
    if (name === "resolve_call_handling_tenant") {
      const tenant = tenants.find(
        (candidate) =>
          candidate.phone_id === args._phone_id || candidate.phone_number === args._phone_number,
      );
      return { data: tenant ? [tenant] : [], error: null };
    }
    if (name === "mark_forwarding_verified") return { data: null, error: null };

    const provider = String(args._provider ?? "");
    const providerEventId = String(args._provider_event_id ?? "");
    const key = eventKey(provider, providerEventId);

    if (name === "claim_text_link_dispatch") {
      const businessId = String(args._business_id);
      let event = providerEvents.get(key);
      if (!event) {
        event = {
          provider,
          providerEventId,
          businessId,
          status: "claimed",
          claimToken: crypto.randomUUID(),
          claimExpiresAt: Date.now() + 30_000,
          missedCallId: String(args._missed_call_id),
          smsEventId: crypto.randomUUID(),
          providerMessageSid: null,
          providerStatus: null,
          sendStartedAt: null,
          providerAttempted: false,
          toNumber: String(args._caller_phone),
          fromNumber: null,
          smsBody: null,
          failureKind: null,
        };
        providerEvents.set(key, event);
        missedCalls.push({
          id: event.missedCallId,
          caller_phone: args._caller_phone,
          sms_sent: false,
          source: `${provider}:${providerEventId}`,
          business_id: businessId,
        });
        return { data: dispatchPayload(event, "send"), error: null };
      }
      if (event.businessId !== businessId) {
        return {
          data: null,
          error: { message: "Provider event belongs to another tenant" },
        };
      }
      if (event.status === "sent") {
        return { data: dispatchPayload(event, "sent"), error: null };
      }
      if (event.status === "failed" && event.failureKind === "provider_rejected") {
        return { data: dispatchPayload(event, "failed"), error: null };
      }
      if (
        event.claimExpiresAt !== null &&
        event.claimExpiresAt > Date.now() &&
        (["claimed", "sending", "reconciling"].includes(event.status) ||
          (event.status === "failed" && event.failureKind === "pre_send"))
      ) {
        return { data: dispatchPayload(event, "busy"), error: null };
      }
      event.claimToken = crypto.randomUUID();
      event.claimExpiresAt = Date.now() + 30_000;
      if (event.status === "sending" || event.status === "reconciling" || event.providerAttempted) {
        event.status = "reconciling";
        return { data: dispatchPayload(event, "reconcile"), error: null };
      }
      event.status = "claimed";
      event.failureKind = null;
      return { data: dispatchPayload(event, "send"), error: null };
    }

    const event = providerEvents.get(key);
    if (!event) return { data: null, error: { message: "event not found" } };
    if (event.claimToken !== args._claim_token) {
      return { data: false, error: null };
    }

    if (name === "begin_text_link_send") {
      if (event.status !== "claimed" || (event.claimExpiresAt ?? 0) <= Date.now()) {
        return { data: false, error: null };
      }
      event.status = "sending";
      event.providerAttempted = true;
      event.sendStartedAt = new Date().toISOString();
      event.claimExpiresAt = Date.now() + 30_000;
      event.toNumber = String(args._to_number);
      event.fromNumber = String(args._from_number);
      event.smsBody = String(args._sms_body);
      return { data: true, error: null };
    }

    if (name === "mark_text_link_reconciling") {
      event.status = "reconciling";
      event.claimExpiresAt = Date.now() + 60_000;
      return { data: true, error: null };
    }

    if (name === "retry_text_link_after_reconciliation") {
      if (event.status !== "reconciling") return { data: false, error: null };
      event.status = "claimed";
      event.providerAttempted = false;
      event.sendStartedAt = null;
      event.claimExpiresAt = Date.now() + 30_000;
      return { data: true, error: null };
    }

    if (name === "complete_text_link_dispatch") {
      if (failCompletionOnce) {
        failCompletionOnce = false;
        return { data: null, error: { message: "synthetic persistence interruption" } };
      }
      const sid = String(args._provider_message_sid);
      event.status = "sent";
      event.providerMessageSid = event.providerMessageSid ?? sid;
      event.providerStatus = String(args._provider_status);
      event.claimToken = null;
      event.claimExpiresAt = null;
      const existingSms = smsEvents.find((row) => row.id === event.smsEventId);
      if (!existingSms) {
        smsEvents.push({
          id: event.smsEventId,
          business_id: event.businessId,
          status: "sent",
          twilio_sid: event.providerMessageSid,
          to_number: event.toNumber,
          body: event.smsBody,
        });
      }
      const missedCall = missedCalls.find((row) => row.id === event.missedCallId);
      if (missedCall) {
        missedCall.sms_sent = true;
        missedCall.sms_event_id = event.smsEventId;
      }
      const usageExists = usageRows.some(
        (row) =>
          row.provider === "twilio" &&
          row.usage_type === "outbound_sms" &&
          row.external_call_id === providerEventId,
      );
      if (!usageExists) {
        usageRows.push({
          business_id: event.businessId,
          usage_type: "outbound_sms",
          provider: "twilio",
          provider_event_id: event.providerMessageSid,
          external_call_id: providerEventId,
          quantity: 1,
          billable: false,
          non_billable_reason: "sms_retail_pricing_unapproved",
          stripe_meter_event_status: "skipped",
        });
      }
      return {
        data: {
          smsEventId: event.smsEventId,
          missedCallId: event.missedCallId,
          usageInserted: !usageExists,
          providerMessageSid: event.providerMessageSid,
        },
        error: null,
      };
    }

    if (name === "fail_text_link_dispatch") {
      event.status = "failed";
      event.failureKind = String(args._failure_kind) as ProviderEvent["failureKind"];
      event.providerMessageSid =
        typeof args._provider_message_sid === "string" ? args._provider_message_sid : null;
      event.providerStatus =
        typeof args._provider_status === "string" ? args._provider_status : null;
      event.claimExpiresAt = event.failureKind === "pre_send" ? Date.now() + 5_000 : null;
      smsEvents.push({
        id: event.smsEventId,
        business_id: event.businessId,
        status: "failed",
        twilio_sid: event.providerMessageSid,
      });
      return { data: true, error: null };
    }

    return { data: null, error: null };
  });
}

function makeProviderFetch() {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "POST") {
      providerPostCount += 1;
      if (deferredProviderResponse) return deferredProviderResponse.promise;
      if (providerOutcomeUncertain) throw new TypeError("synthetic connection reset");
      if (providerFailure) return responseJson({ message: providerFailure }, 400);
      const body = new URLSearchParams(String(init.body));
      const message: ProviderMessage = {
        sid: `SM${String(providerPostCount).padStart(32, "0")}`,
        status: "queued",
        to: body.get("To") ?? "",
        from: body.get("From") ?? "",
        body: body.get("Body") ?? "",
        date_created: new Date().toISOString(),
        date_sent: new Date().toISOString(),
      };
      providerMessages.push(message);
      return responseJson({ sid: message.sid, status: message.status }, 201);
    }
    if (init?.method === "GET" && url.includes("/Messages.json?")) {
      providerGetCount += 1;
      return responseJson({ messages: providerMessages });
    }
    throw new Error(`Unexpected provider request: ${init?.method ?? "GET"} ${url}`);
  });
}

function vapiRequest(input: { phoneId: string; callId?: string; callerPhone?: string }): Request {
  return new Request("https://app.example/api/public/webhooks/vapi-inbound", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-vapi-secret": "test-vapi-secret",
    },
    body: JSON.stringify({
      message: {
        type: "assistant-request",
        call: {
          id: input.callId ?? "CA-test",
          phoneNumberId: input.phoneId,
          customer: { number: input.callerPhone ?? "+61412000000" },
        },
      },
    }),
  });
}

async function webhook(input: { phoneId: string; callId?: string; callerPhone?: string }) {
  const { handleVapiInbound } = await import("@/routes/api/public/webhooks.vapi-inbound");
  const response = await handleVapiInbound(vapiRequest(input));
  return {
    response,
    body: (await response.json()) as Record<string, unknown>,
  };
}

describe("Vapi customer call-handling behavioural boundary", () => {
  beforeEach(() => {
    tenants.length = 0;
    providerEvents.clear();
    missedCalls.length = 0;
    smsEvents.length = 0;
    usageRows.length = 0;
    providerMessages.length = 0;
    leadRows.length = 0;
    voiceUsageRows.length = 0;
    providerPostCount = 0;
    providerGetCount = 0;
    providerFailure = null;
    providerOutcomeUncertain = false;
    failCompletionOnce = false;
    deferredProviderResponse = undefined;
    supabaseMock.rpc.mockReset();
    supabaseMock.from.mockReset();
    installFakeDatabase();
    process.env.VAPI_SERVER_SECRET = "test-vapi-secret";
    process.env.SMS_MODE = "twilio";
    process.env.PUBLIC_JOB_REQUEST_URL = "https://app.example/";
    process.env.TWILIO_ACCOUNT_SID = "ACtest";
    process.env.TWILIO_AUTH_TOKEN = "test-token";
    process.env.TWILIO_FROM_NUMBER = "+61499000000";
    vi.stubGlobal("fetch", makeProviderFetch());
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    delete process.env.VAPI_SERVER_SECRET;
    delete process.env.SMS_MODE;
    delete process.env.PUBLIC_JOB_REQUEST_URL;
    delete process.env.TWILIO_ACCOUNT_SID;
    delete process.env.TWILIO_AUTH_TOKEN;
    delete process.env.TWILIO_FROM_NUMBER;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("keeps Off mode out of both customer workflows", async () => {
    const tenant = makeTenant("off", "01");
    tenants.push(tenant);
    const result = await webhook({ phoneId: tenant.phone_id });
    expect(result.body.error).toMatch(/currently off/i);
    expect(providerPostCount).toBe(0);
    expect(providerEvents.size).toBe(0);
  });

  it("routes AI mode to the trusted tenant assistant without SMS", async () => {
    const tenant = makeTenant("ai_receptionist", "02");
    tenants.push(tenant);
    const result = await webhook({ phoneId: tenant.phone_id });
    expect(result.body).toEqual({ assistantId: tenant.assistant_id });
    expect(providerPostCount).toBe(0);
    expect(providerEvents.size).toBe(0);
  });

  it("dispatches Text Link to the correct tenant questionnaire and records one non-billable usage", async () => {
    const tenant = makeTenant("text_link", "03");
    tenants.push(tenant);
    const result = await webhook({
      phoneId: tenant.phone_id,
      callId: "CA-success",
      callerPhone: "+61412345003",
    });
    expect(result.body.error).toMatch(/have sent/i);
    expect(providerPostCount).toBe(1);
    expect(providerMessages[0]?.body).toContain(
      "https://app.example/b/tenant-03/request?source=missed_call&mcid=",
    );
    expect(providerMessages[0]?.body).toContain("Tenant 03");
    expect(usageRows).toHaveLength(1);
    expect(usageRows[0]).toMatchObject({
      business_id: tenant.business_id,
      usage_type: "outbound_sms",
      quantity: 1,
      billable: false,
      non_billable_reason: "sms_retail_pricing_unapproved",
    });
    expect(leadRows).toHaveLength(0);
    expect(voiceUsageRows).toHaveLength(0);
  });

  it("deduplicates concurrent deliveries and does not tell the pending caller that SMS was sent", async () => {
    const tenant = makeTenant("text_link", "04");
    tenants.push(tenant);
    let resolveProvider!: (response: Response) => void;
    const promise = new Promise<Response>((resolve) => {
      resolveProvider = resolve;
    });
    deferredProviderResponse = { promise, resolve: resolveProvider };

    const first = webhook({ phoneId: tenant.phone_id, callId: "CA-concurrent" });
    await vi.waitFor(() => expect(providerPostCount).toBe(1));
    const duplicate = await webhook({
      phoneId: tenant.phone_id,
      callId: "CA-concurrent",
    });
    expect(duplicate.body.error).toMatch(/confirming/i);
    expect(duplicate.body.error).not.toMatch(/have sent/i);

    const providerMessage: ProviderMessage = {
      sid: "SMconcurrent000000000000000000000001",
      status: "queued",
      to: "+61412000000",
      from: "+61499000000",
      body: providerEvents.get(eventKey("vapi", "CA-concurrent"))?.smsBody ?? "",
      date_created: new Date().toISOString(),
      date_sent: new Date().toISOString(),
    };
    providerMessages.push(providerMessage);
    resolveProvider(responseJson({ sid: providerMessage.sid, status: "queued" }, 201));
    const completed = await first;
    expect(completed.body.error).toMatch(/have sent/i);
    expect(providerPostCount).toBe(1);
    expect(usageRows).toHaveLength(1);
  });

  it("recovers an expired pre-send claim without provider reconciliation", async () => {
    const tenant = makeTenant("text_link", "05");
    tenants.push(tenant);
    const key = eventKey("vapi", "CA-stale-pre-send");
    providerEvents.set(key, {
      provider: "vapi",
      providerEventId: "CA-stale-pre-send",
      businessId: tenant.business_id,
      status: "claimed",
      claimToken: crypto.randomUUID(),
      claimExpiresAt: Date.now() - 1,
      missedCallId: "mc-stale",
      smsEventId: "sms-stale",
      providerMessageSid: null,
      providerStatus: null,
      sendStartedAt: null,
      providerAttempted: false,
      toNumber: "+61412000000",
      fromNumber: null,
      smsBody: null,
      failureKind: null,
    });
    missedCalls.push({
      id: "mc-stale",
      caller_phone: "+61412000000",
      sms_sent: false,
      business_id: tenant.business_id,
    });

    const result = await webhook({
      phoneId: tenant.phone_id,
      callId: "CA-stale-pre-send",
    });
    expect(result.body.error).toMatch(/have sent/i);
    expect(providerPostCount).toBe(1);
    expect(providerGetCount).toBe(0);
  });

  it("reconciles a provider-accepted/persistence-interrupted send without blindly resending", async () => {
    const tenant = makeTenant("text_link", "06");
    tenants.push(tenant);
    failCompletionOnce = true;
    const first = await webhook({
      phoneId: tenant.phone_id,
      callId: "CA-interrupted",
    });
    expect(first.body.error).toMatch(/confirming/i);
    expect(first.body.error).not.toMatch(/have sent/i);
    expect(providerPostCount).toBe(1);
    expect(usageRows).toHaveLength(0);

    const event = providerEvents.get(eventKey("vapi", "CA-interrupted"));
    expect(event?.status).toBe("reconciling");
    if (!event) throw new Error("missing provider event");
    event.claimExpiresAt = Date.now() - 1;
    tenant.sms_template = "A changed template must not alter an in-flight provider match";

    const recovered = await webhook({
      phoneId: tenant.phone_id,
      callId: "CA-interrupted",
      callerPhone: "+61412999999",
    });
    expect(recovered.body.error).toMatch(/have sent/i);
    expect(providerGetCount).toBe(1);
    expect(providerPostCount).toBe(1);
    expect(event.providerMessageSid).toBe(providerMessages[0]?.sid);
    expect(smsEvents[0]?.twilio_sid).toBe(providerMessages[0]?.sid);
    expect(usageRows).toHaveLength(1);

    const finalDuplicate = await webhook({
      phoneId: tenant.phone_id,
      callId: "CA-interrupted",
    });
    expect(finalDuplicate.body.error).toMatch(/have sent/i);
    expect(providerPostCount).toBe(1);
    expect(usageRows).toHaveLength(1);
  });

  it("records a provider rejection as failed with no usage or spoken success", async () => {
    const tenant = makeTenant("text_link", "07");
    tenants.push(tenant);
    providerFailure = "invalid destination";
    const result = await webhook({
      phoneId: tenant.phone_id,
      callId: "CA-provider-failure",
    });
    expect(result.body.error).toMatch(/could not send/i);
    expect(result.body.error).not.toMatch(/have sent/i);
    expect(providerEvents.get(eventKey("vapi", "CA-provider-failure"))?.status).toBe("failed");
    expect(usageRows).toHaveLength(0);
  });

  it("persists an uncertain provider outcome for reconciliation before returning", async () => {
    const tenant = makeTenant("text_link", "11");
    tenants.push(tenant);
    providerOutcomeUncertain = true;
    const result = await webhook({
      phoneId: tenant.phone_id,
      callId: "CA-uncertain",
    });
    expect(result.body.error).toMatch(/confirming/i);
    expect(result.body.error).not.toMatch(/have sent/i);
    expect(providerEvents.get(eventKey("vapi", "CA-uncertain"))?.status).toBe("reconciling");
    expect(providerPostCount).toBe(1);
    expect(usageRows).toHaveLength(0);
  });

  it("rejects missing caller ID before creating dispatch state", async () => {
    const tenant = makeTenant("text_link", "08");
    tenants.push(tenant);
    const result = await webhook({
      phoneId: tenant.phone_id,
      callId: "CA-no-caller",
      callerPhone: "",
    });
    expect(result.body.error).toMatch(/identify your mobile number/i);
    expect(providerPostCount).toBe(0);
    expect(providerEvents.size).toBe(0);
  });

  it("rejects a replay resolved to another tenant", async () => {
    const firstTenant = makeTenant("text_link", "09");
    const secondTenant = makeTenant("text_link", "10");
    tenants.push(firstTenant, secondTenant);
    await webhook({ phoneId: firstTenant.phone_id, callId: "CA-cross-tenant" });
    const replay = await webhook({
      phoneId: secondTenant.phone_id,
      callId: "CA-cross-tenant",
    });
    expect(replay.body.error).toMatch(/could not send/i);
    expect(providerPostCount).toBe(1);
    expect(usageRows).toHaveLength(1);
    expect(usageRows[0]?.business_id).toBe(firstTenant.business_id);
    expect(usageRows.some((row) => row.business_id === secondTenant.business_id)).toBe(false);
  });
});
