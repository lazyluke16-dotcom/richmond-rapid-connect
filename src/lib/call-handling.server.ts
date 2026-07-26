import { createHash } from "node:crypto";
import {
  CallHandlingModeSchema,
  selectInboundWorkflow,
  type InboundWorkflow,
} from "@/lib/call-handling";
import { renderSmsTemplate } from "@/lib/missed-call.functions";
import { getTwilioSmsConfiguration, reconcileTwilioSms, sendTwilioSmsAttempt } from "@/lib/sms";

type RpcResult = {
  data: unknown;
  error: { message: string } | null;
};

async function rpcWithDeadline(
  client: unknown,
  name: string,
  args: Record<string, unknown>,
  deadlineAt?: number,
): Promise<RpcResult> {
  const builder = (
    client as {
      rpc: (fn: string, parameters: never) => unknown;
    }
  ).rpc(name, args as never) as {
    then: PromiseLike<RpcResult>["then"];
    abortSignal?: (signal: AbortSignal) => PromiseLike<RpcResult>;
  };
  if (deadlineAt === undefined || typeof builder.abortSignal !== "function") {
    return await builder;
  }
  const remaining = deadlineAt - Date.now() - 200;
  if (remaining <= 0) throw new Error("Vapi assistant-request deadline exhausted");
  return await builder.abortSignal(AbortSignal.timeout(remaining));
}

export interface ResolvedInboundTenant {
  businessId: string;
  mode: "off" | "text_link" | "ai_receptionist";
  forwardingStatus: string;
  businessName: string;
  businessSlug: string;
  publicPhone: string | null;
  assistantId: string | null;
  smsTemplate: string;
  textLinkEntitled: boolean;
  aiReceptionistEntitled: boolean;
}

export async function resolveInboundTenant(input: {
  provider: string;
  phoneId?: string | null;
  phoneNumber?: string | null;
  deadlineAt?: number;
}): Promise<ResolvedInboundTenant | null> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data, error } = await rpcWithDeadline(
    supabaseAdmin,
    "resolve_call_handling_tenant",
    {
      _provider: input.provider,
      _phone_id: input.phoneId ?? null,
      _phone_number: input.phoneNumber ?? null,
    },
    input.deadlineAt,
  );
  if (error) throw new Error(`Call-handling tenant resolution failed: ${error.message}`);
  const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null;
  if (!row) return null;
  return {
    businessId: String(row.business_id),
    mode: CallHandlingModeSchema.parse(row.answering_mode),
    forwardingStatus: String(row.forwarding_setup_status ?? "unallocated"),
    businessName: String(row.business_name),
    businessSlug: String(row.business_slug),
    publicPhone: typeof row.public_phone === "string" ? row.public_phone : null,
    assistantId: typeof row.assistant_id === "string" ? row.assistant_id : null,
    smsTemplate: String(row.sms_template ?? ""),
    textLinkEntitled: Boolean(row.text_link_entitled),
    aiReceptionistEntitled: Boolean(row.ai_receptionist_entitled),
  };
}

export function workflowForTenant(tenant: ResolvedInboundTenant): InboundWorkflow {
  return selectInboundWorkflow({
    mode: tenant.mode,
    textLinkEntitled: tenant.textLinkEntitled,
    aiReceptionistEntitled: tenant.aiReceptionistEntitled,
    assistantId: tenant.assistantId,
  });
}

export async function markForwardingVerified(
  businessId: string,
  providerCallId: string,
  deadlineAt?: number,
): Promise<void> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { error } = await rpcWithDeadline(
    supabaseAdmin,
    "mark_forwarding_verified",
    {
      _business_id: businessId,
      _provider_call_id: providerCallId,
    },
    deadlineAt,
  );
  if (error) throw new Error(`Could not verify forwarding: ${error.message}`);
}

export interface RecoveryDispatchResult {
  outcome: "sent" | "pending" | "failed";
  deduped: boolean;
  missedCallId: string | null;
  smsEventId: string | null;
  providerMessageSid: string | null;
}

type DispatchClaim = {
  action: "send" | "reconcile" | "sent" | "busy" | "failed";
  status: string;
  claimToken: string | null;
  missedCallId: string | null;
  smsEventId: string | null;
  providerMessageSid: string | null;
  sendStartedAt: string | null;
  toNumber: string | null;
  fromNumber: string | null;
  smsBody: string | null;
};

type DispatchCompletion = {
  smsEventId: string | null;
  missedCallId: string | null;
  usageInserted: boolean;
  providerMessageSid: string | null;
};

const DISPATCH_LEASE_SECONDS = 30;
const RECONCILIATION_LEASE_SECONDS = 60;
const PROVIDER_COMPLETION_RESERVE_MS = 900;

function remainingProviderBudget(deadlineAt: number | undefined): number {
  if (deadlineAt === undefined) return 3_000;
  return Math.max(0, Math.min(3_000, deadlineAt - Date.now() - PROVIDER_COMPLETION_RESERVE_MS));
}

function smsBodyHash(body: string): string {
  return createHash("sha256").update(body).digest("hex");
}

function parseRpcData<T>(value: unknown, name: string): T {
  if (!value || typeof value !== "object") {
    throw new Error(`${name} returned an invalid state payload`);
  }
  return value as T;
}

function pendingResult(claim: DispatchClaim, deduped = true): RecoveryDispatchResult {
  return {
    outcome: "pending",
    deduped,
    missedCallId: claim.missedCallId,
    smsEventId: claim.smsEventId,
    providerMessageSid: claim.providerMessageSid,
  };
}

/**
 * Execute a bounded, durable Text Link dispatch.
 *
 * No work is left in an unawaited promise. A timed-out provider request is
 * persisted as `reconciling`; a later stale claimant queries Twilio before it
 * may send again. Terminal persistence (SMS audit, missed-call update, usage
 * ledger and provider-event state) is one database transaction.
 */
export async function dispatchTextLinkRecovery(input: {
  tenant: ResolvedInboundTenant;
  provider: string;
  providerEventId: string;
  callerPhone: string;
  publicBaseUrl: string;
  deadlineAt?: number;
}): Promise<RecoveryDispatchResult> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data: claimData, error: claimError } = await rpcWithDeadline(
    supabaseAdmin,
    "claim_text_link_dispatch",
    {
      _provider: input.provider,
      _provider_event_id: input.providerEventId,
      _business_id: input.tenant.businessId,
      _missed_call_id: crypto.randomUUID(),
      _caller_phone: input.callerPhone,
      _lease_seconds: DISPATCH_LEASE_SECONDS,
    },
    input.deadlineAt,
  );
  if (claimError) throw new Error(`Provider replay claim failed: ${claimError.message}`);
  const claim = parseRpcData<DispatchClaim>(claimData, "claim_text_link_dispatch");

  if (claim.action === "sent") {
    return {
      outcome: "sent",
      deduped: true,
      missedCallId: claim.missedCallId,
      smsEventId: claim.smsEventId,
      providerMessageSid: claim.providerMessageSid,
    };
  }
  if (claim.action === "busy") return pendingResult(claim);
  if (claim.action === "failed") {
    return {
      outcome: "failed",
      deduped: true,
      missedCallId: claim.missedCallId,
      smsEventId: claim.smsEventId,
      providerMessageSid: claim.providerMessageSid,
    };
  }
  if (!claim.claimToken || !claim.missedCallId) {
    throw new Error("Text Link dispatch claim is incomplete");
  }

  const recoveryLink = `${input.publicBaseUrl.replace(/\/+$/, "")}/b/${input.tenant.businessSlug}/request?source=missed_call&mcid=${claim.missedCallId}`;
  const renderedSmsBody = renderSmsTemplate(input.tenant.smsTemplate, {
    business_name: input.tenant.businessName,
    recovery_link: recoveryLink,
    public_phone: input.tenant.publicPhone,
  });
  const destinationPhone =
    claim.action === "reconcile" && claim.toNumber ? claim.toNumber : input.callerPhone;
  const smsBody = claim.action === "reconcile" && claim.smsBody ? claim.smsBody : renderedSmsBody;
  const config = getTwilioSmsConfiguration();
  if (!config) {
    await rpcWithDeadline(
      supabaseAdmin,
      "fail_text_link_dispatch",
      {
        _provider: input.provider,
        _provider_event_id: input.providerEventId,
        _claim_token: claim.claimToken,
        _failure_kind: "pre_send",
        _error_message: "Twilio production configuration is incomplete",
        _provider_message_sid: null,
        _provider_status: null,
        _to_number: destinationPhone,
        _from_number: process.env.TWILIO_FROM_NUMBER ?? "UNCONFIGURED",
        _sms_body: smsBody,
      },
      input.deadlineAt,
    );
    return {
      outcome: "failed",
      deduped: claim.action !== "send",
      missedCallId: claim.missedCallId,
      smsEventId: claim.smsEventId,
      providerMessageSid: null,
    };
  }
  const dispatchConfig =
    claim.action === "reconcile" && claim.fromNumber
      ? { ...config, fromNumber: claim.fromNumber }
      : config;

  const complete = async (sid: string, providerStatus: string) => {
    const { data, error } = await rpcWithDeadline(
      supabaseAdmin,
      "complete_text_link_dispatch",
      {
        _provider: input.provider,
        _provider_event_id: input.providerEventId,
        _claim_token: claim.claimToken,
        _provider_message_sid: sid,
        _provider_status: providerStatus,
      },
      input.deadlineAt,
    );
    if (error) throw new Error(`Text Link completion failed: ${error.message}`);
    return parseRpcData<DispatchCompletion>(data, "complete_text_link_dispatch");
  };

  if (claim.action === "reconcile") {
    const budget = remainingProviderBudget(input.deadlineAt);
    if (budget < 250 || !claim.sendStartedAt) return pendingResult(claim);
    const reconciliation = await reconcileTwilioSms({
      to: destinationPhone,
      body: smsBody,
      sentAfter: new Date(claim.sendStartedAt),
      config: dispatchConfig,
      timeoutMs: budget,
    });
    if (reconciliation.kind === "found") {
      if (
        ["failed", "undelivered", "canceled"].includes(reconciliation.providerStatus.toLowerCase())
      ) {
        const { error } = await rpcWithDeadline(
          supabaseAdmin,
          "fail_text_link_dispatch",
          {
            _provider: input.provider,
            _provider_event_id: input.providerEventId,
            _claim_token: claim.claimToken,
            _failure_kind: "provider_rejected",
            _error_message: `Twilio reconciled terminal status: ${reconciliation.providerStatus}`,
            _provider_message_sid: reconciliation.sid,
            _provider_status: reconciliation.providerStatus,
            _to_number: destinationPhone,
            _from_number: dispatchConfig.fromNumber,
            _sms_body: smsBody,
          },
          input.deadlineAt,
        );
        if (error) throw new Error(`Text Link failure persistence failed: ${error.message}`);
        return {
          outcome: "failed",
          deduped: true,
          missedCallId: claim.missedCallId,
          smsEventId: claim.smsEventId,
          providerMessageSid: reconciliation.sid,
        };
      }
      try {
        const completed = await complete(reconciliation.sid, reconciliation.providerStatus);
        return {
          outcome: "sent",
          deduped: true,
          missedCallId: completed.missedCallId,
          smsEventId: completed.smsEventId,
          providerMessageSid: completed.providerMessageSid,
        };
      } catch (error) {
        console.error("[text-link] reconciled SMS persistence failed", error);
        return pendingResult(claim);
      }
    }
    if (reconciliation.kind !== "not_found") return pendingResult(claim);
    const { data: retryAllowed, error: retryError } = await rpcWithDeadline(
      supabaseAdmin,
      "retry_text_link_after_reconciliation",
      {
        _provider: input.provider,
        _provider_event_id: input.providerEventId,
        _claim_token: claim.claimToken,
        _lease_seconds: DISPATCH_LEASE_SECONDS,
      },
      input.deadlineAt,
    );
    if (retryError || retryAllowed !== true) return pendingResult(claim);
  }

  const budget = remainingProviderBudget(input.deadlineAt);
  if (budget < 250) {
    await rpcWithDeadline(
      supabaseAdmin,
      "fail_text_link_dispatch",
      {
        _provider: input.provider,
        _provider_event_id: input.providerEventId,
        _claim_token: claim.claimToken,
        _failure_kind: "pre_send",
        _error_message: "Vapi response deadline left insufficient provider budget",
        _provider_message_sid: null,
        _provider_status: null,
        _to_number: destinationPhone,
        _from_number: dispatchConfig.fromNumber,
        _sms_body: smsBody,
      },
      input.deadlineAt,
    );
    return {
      outcome: "failed",
      deduped: claim.action !== "send",
      missedCallId: claim.missedCallId,
      smsEventId: claim.smsEventId,
      providerMessageSid: null,
    };
  }

  const { data: began, error: beginError } = await rpcWithDeadline(
    supabaseAdmin,
    "begin_text_link_send",
    {
      _provider: input.provider,
      _provider_event_id: input.providerEventId,
      _claim_token: claim.claimToken,
      _to_number: destinationPhone,
      _from_number: dispatchConfig.fromNumber,
      _sms_body: smsBody,
      _sms_body_hash: smsBodyHash(smsBody),
      _lease_seconds: DISPATCH_LEASE_SECONDS,
    },
    input.deadlineAt,
  );
  if (beginError) throw new Error(`Could not begin Text Link send: ${beginError.message}`);
  if (began !== true) return pendingResult(claim);

  const attempt = await sendTwilioSmsAttempt({
    to: destinationPhone,
    body: smsBody,
    config: dispatchConfig,
    timeoutMs: budget,
  });
  if (attempt.kind === "accepted") {
    try {
      const completed = await complete(attempt.sid, attempt.providerStatus);
      return {
        outcome: "sent",
        deduped: claim.action !== "send",
        missedCallId: completed.missedCallId,
        smsEventId: completed.smsEventId,
        providerMessageSid: completed.providerMessageSid,
      };
    } catch (error) {
      console.error("[text-link] provider accepted SMS but persistence failed", error);
      await rpcWithDeadline(
        supabaseAdmin,
        "mark_text_link_reconciling",
        {
          _provider: input.provider,
          _provider_event_id: input.providerEventId,
          _claim_token: claim.claimToken,
          _error_message: "provider_accepted_persistence_incomplete",
          _lease_seconds: RECONCILIATION_LEASE_SECONDS,
        },
        input.deadlineAt,
      );
      return pendingResult(claim, claim.action !== "send");
    }
  }

  if (attempt.kind === "uncertain") {
    await rpcWithDeadline(
      supabaseAdmin,
      "mark_text_link_reconciling",
      {
        _provider: input.provider,
        _provider_event_id: input.providerEventId,
        _claim_token: claim.claimToken,
        _error_message: attempt.errorMessage,
        _lease_seconds: RECONCILIATION_LEASE_SECONDS,
      },
      input.deadlineAt,
    );
    return pendingResult(claim, claim.action !== "send");
  }

  const { error: failError } = await rpcWithDeadline(
    supabaseAdmin,
    "fail_text_link_dispatch",
    {
      _provider: input.provider,
      _provider_event_id: input.providerEventId,
      _claim_token: claim.claimToken,
      _failure_kind: "provider_rejected",
      _error_message: attempt.errorMessage,
      _provider_message_sid: attempt.sid ?? null,
      _provider_status: attempt.providerStatus ?? null,
      _to_number: destinationPhone,
      _from_number: dispatchConfig.fromNumber,
      _sms_body: smsBody,
    },
    input.deadlineAt,
  );
  if (failError) throw new Error(`Text Link failure persistence failed: ${failError.message}`);
  return {
    outcome: "failed",
    deduped: claim.action !== "send",
    missedCallId: claim.missedCallId,
    smsEventId: claim.smsEventId,
    providerMessageSid: attempt.sid ?? null,
  };
}
