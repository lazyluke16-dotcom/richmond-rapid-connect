export interface SmsResult {
  id: string;
  status: "simulated" | "sent" | "failed";
  to: string;
  body: string;
  mode: string;
  twilioSid?: string;
  errorMessage?: string;
}

export interface TwilioSmsConfiguration {
  accountSid: string;
  authToken: string;
  fromNumber: string;
}

export type TwilioSendAttempt =
  | {
      kind: "accepted";
      sid: string;
      providerStatus: string;
      fromNumber: string;
    }
  | {
      kind: "rejected";
      errorMessage: string;
      fromNumber: string;
      sid?: string;
      providerStatus?: string;
    }
  | {
      kind: "uncertain";
      errorMessage: string;
      fromNumber: string;
    };

export type TwilioReconciliation =
  | {
      kind: "found";
      sid: string;
      providerStatus: string;
    }
  | { kind: "not_found" }
  | { kind: "unavailable"; errorMessage: string };

const DEFAULT_TWILIO_TIMEOUT_MS = 3_000;

export function getTwilioSmsConfiguration(
  env: NodeJS.ProcessEnv = process.env,
): TwilioSmsConfiguration | null {
  const accountSid = env.TWILIO_ACCOUNT_SID?.trim();
  const authToken = env.TWILIO_AUTH_TOKEN?.trim();
  const fromNumber = env.TWILIO_FROM_NUMBER?.trim();
  if (!accountSid || !authToken || !fromNumber) return null;
  return { accountSid, authToken, fromNumber };
}

function twilioAuthorization(config: TwilioSmsConfiguration): string {
  return `Basic ${Buffer.from(`${config.accountSid}:${config.authToken}`).toString("base64")}`;
}

async function fetchWithTimeout(
  input: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Perform only the provider request. Durable audit/state persistence belongs
 * to the Text Link state machine, which must know whether a failure happened
 * before Twilio was called or after the outcome became uncertain.
 */
export async function sendTwilioSmsAttempt(input: {
  to: string;
  body: string;
  config: TwilioSmsConfiguration;
  timeoutMs?: number;
}): Promise<TwilioSendAttempt> {
  const url =
    `https://api.twilio.com/2010-04-01/Accounts/` +
    `${encodeURIComponent(input.config.accountSid)}/Messages.json`;
  try {
    const response = await fetchWithTimeout(
      url,
      {
        method: "POST",
        headers: {
          Authorization: twilioAuthorization(input.config),
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          To: input.to,
          From: input.config.fromNumber,
          Body: input.body,
        }).toString(),
      },
      input.timeoutMs ?? DEFAULT_TWILIO_TIMEOUT_MS,
    );
    const json = (await response.json()) as {
      sid?: string;
      status?: string;
      message?: string;
    };
    const terminalFailure = ["failed", "undelivered", "canceled"].includes(
      json.status?.toLowerCase() ?? "",
    );
    if (!response.ok || !json.sid || terminalFailure) {
      return {
        kind: "rejected",
        errorMessage: json.message ?? `Twilio rejected the message (${response.status})`,
        fromNumber: input.config.fromNumber,
        sid: json.sid,
        providerStatus: json.status,
      };
    }
    return {
      kind: "accepted",
      sid: json.sid,
      providerStatus: json.status ?? "accepted",
      fromNumber: input.config.fromNumber,
    };
  } catch (error) {
    // A timeout/network failure can happen after Twilio accepted the POST.
    // The caller must reconcile the provider log before considering a resend.
    return {
      kind: "uncertain",
      errorMessage: error instanceof Error ? error.message : "Twilio request outcome is uncertain",
      fromNumber: input.config.fromNumber,
    };
  }
}

/**
 * Reconcile an uncertain POST against Twilio's message resource. Twilio's list
 * endpoint supports To/From/date filters; the exact body and timestamps are
 * checked locally so another tenant message cannot satisfy this dispatch.
 */
export async function reconcileTwilioSms(input: {
  to: string;
  body: string;
  sentAfter: Date;
  config: TwilioSmsConfiguration;
  timeoutMs?: number;
}): Promise<TwilioReconciliation> {
  const params = new URLSearchParams({
    To: input.to,
    From: input.config.fromNumber,
    DateSent: input.sentAfter.toISOString().slice(0, 10),
    PageSize: "50",
  });
  const url =
    `https://api.twilio.com/2010-04-01/Accounts/` +
    `${encodeURIComponent(input.config.accountSid)}/Messages.json?${params.toString()}`;
  try {
    const response = await fetchWithTimeout(
      url,
      {
        method: "GET",
        headers: { Authorization: twilioAuthorization(input.config) },
      },
      input.timeoutMs ?? DEFAULT_TWILIO_TIMEOUT_MS,
    );
    const json = (await response.json()) as {
      messages?: {
        sid?: string;
        status?: string;
        to?: string;
        from?: string;
        body?: string;
        date_created?: string | null;
        date_sent?: string | null;
      }[];
      message?: string;
    };
    if (!response.ok) {
      return {
        kind: "unavailable",
        errorMessage: json.message ?? `Twilio reconciliation failed (${response.status})`,
      };
    }
    const lowerBound = input.sentAfter.getTime() - 120_000;
    const match = (json.messages ?? []).find((message) => {
      const timestamp = message.date_sent ?? message.date_created;
      const timestampMs = timestamp ? new Date(timestamp).getTime() : Number.NaN;
      return (
        typeof message.sid === "string" &&
        message.to === input.to &&
        message.from === input.config.fromNumber &&
        message.body === input.body &&
        Number.isFinite(timestampMs) &&
        timestampMs >= lowerBound
      );
    });
    if (!match?.sid) return { kind: "not_found" };
    return {
      kind: "found",
      sid: match.sid,
      providerStatus: match.status ?? "accepted",
    };
  } catch (error) {
    return {
      kind: "unavailable",
      errorMessage: error instanceof Error ? error.message : "Twilio reconciliation is unavailable",
    };
  }
}

/**
 * Send an SMS. `businessId` is required to attribute the logged
 * `sms_events` row to the correct tenant; there is no fallback. Callers
 * that don't know the tenant should not use this helper.
 */
export async function sendSms(
  to: string,
  body: string,
  businessId?: string | null,
): Promise<SmsResult> {
  const mode = process.env.SMS_MODE ?? "demo";
  const configuredFromNumber = process.env.TWILIO_FROM_NUMBER;

  if (mode === "twilio") {
    const config = getTwilioSmsConfiguration();
    if (!config) {
      console.error("[SMS] Twilio production mode is incomplete");
      const result: SmsResult = {
        id: crypto.randomUUID(),
        status: "failed",
        to,
        body,
        mode: "twilio",
        errorMessage: "Twilio production configuration is incomplete",
      };
      await logSmsEvent(
        { ...result, fromNumber: configuredFromNumber ?? "UNCONFIGURED" },
        businessId ?? null,
      );
      return result;
    }

    try {
      const attempt = await sendTwilioSmsAttempt({ to, body, config });
      const result: SmsResult = {
        id: attempt.kind === "accepted" ? attempt.sid : crypto.randomUUID(),
        status: attempt.kind === "accepted" ? "sent" : "failed",
        to,
        body,
        mode: "twilio",
        twilioSid: attempt.kind === "accepted" ? attempt.sid : undefined,
        errorMessage: attempt.kind === "accepted" ? undefined : attempt.errorMessage,
      };
      await logSmsEvent({ ...result, fromNumber: config.fromNumber }, businessId ?? null);
      return result;
    } catch {
      console.error("[SMS] Twilio send failed");
      const result: SmsResult = {
        id: crypto.randomUUID(),
        status: "failed",
        to,
        body,
        mode: "twilio",
        errorMessage: "Twilio request failed",
      };
      try {
        await logSmsEvent({ ...result, fromNumber: config.fromNumber }, businessId ?? null);
      } catch {
        console.error("[SMS] Twilio failure audit persistence failed");
      }
      return result;
    }
  }

  const result: SmsResult = {
    id: crypto.randomUUID(),
    status: "simulated",
    to,
    body,
    mode: "demo",
  };
  await logSmsEvent(
    { ...result, fromNumber: configuredFromNumber ?? "DEMO_NUMBER" },
    businessId ?? null,
  );
  return result;
}

async function logSmsEvent(e: SmsResult & { fromNumber: string }, businessId: string | null) {
  if (!businessId) {
    // Fail-closed: without a tenant we cannot attribute the row, and
    // there is no safe default. Skip the audit row rather than writing
    // it against a wrong tenant.
    console.warn("[SMS] logSmsEvent skipped — no businessId supplied");
    return;
  }
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { error } = await supabaseAdmin.from("sms_events").insert({
    id: e.id,
    to_number: e.to,
    from_number: e.fromNumber,
    body: e.body,
    mode: e.mode,
    status: e.status,
    twilio_sid: e.twilioSid ?? null,
    error_message: e.errorMessage ?? null,
    business_id: businessId,
  } as never);
  if (error) throw new Error(`SMS audit persistence failed: ${error.message}`);
}
