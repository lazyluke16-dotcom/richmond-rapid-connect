import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export interface MissedCallSettings {
  id: string;
  business_id: string;
  enabled: boolean;
  mode: "demo" | "live";
  recovery_sms_enabled: boolean;
  sms_template: string;
  plumber_alert_enabled: boolean;
  alert_method: "demo" | "sms" | "email";
  alert_phone: string | null;
  alert_email: string | null;
  callback_message: string | null;
}

export interface MissedCallContext {
  settings: MissedCallSettings;
  business: {
    id: string;
    name: string;
    slug: string;
    public_phone: string | null;
    selected_plan: string | null;
    trial_ends_at: string | null;
  };
  feature_state: string;
  has_access: boolean;
  sms_mode: "demo" | "twilio";
}

/** Return the caller's missed-call settings + gating info. RLS ensures only own row. */
export const getMyMissedCallContext = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<MissedCallContext> => {
    const { data: biz, error: bErr } = await context.supabase
      .from("businesses")
      .select("id,name,slug,public_phone,selected_plan,trial_ends_at")
      .limit(1)
      .maybeSingle();
    if (bErr) throw new Error(bErr.message);
    if (!biz) throw new Error("No business membership");

    let { data: s } = await context.supabase
      .from("business_missed_call_settings")
      .select("*")
      .eq("business_id", biz.id)
      .maybeSingle();
    if (!s) {
      // Backfill self-heal for legacy rows.
      const { data: inserted } = await context.supabase
        .from("business_missed_call_settings")
        .insert({ business_id: biz.id } as never)
        .select("*")
        .single();
      s = inserted;
    }
    const [{ data: fs }, { data: acc }] = await Promise.all([
      context.supabase.rpc("business_feature_state", { _business_id: biz.id }),
      context.supabase.rpc("has_missed_call_access", { _business_id: biz.id }),
    ]);
    return {
      settings: s as MissedCallSettings,
      business: biz as MissedCallContext["business"],
      feature_state: (fs as unknown as string) ?? "unknown",
      has_access: Boolean(acc),
      sms_mode: process.env.SMS_MODE === "twilio" ? "twilio" : "demo",
    };
  });

export type MissedCallUpdate = Partial<
  Pick<
    MissedCallSettings,
    | "enabled"
    | "mode"
    | "recovery_sms_enabled"
    | "sms_template"
    | "plumber_alert_enabled"
    | "alert_method"
    | "alert_phone"
    | "alert_email"
    | "callback_message"
  >
>;

function sanitizeTemplate(t: string): string {
  // Strip HTML tags & control chars. Keep it plain SMS text.
  return (
    t
      .replace(/<[^>]*>/g, "")
      // eslint-disable-next-line no-control-regex -- intentionally strips SMS control bytes
      .replace(/[\u0000-\u0008\u000B-\u001F]/g, "")
      .slice(0, 480)
  );
}

export const updateMyMissedCallSettings = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: MissedCallUpdate) => data)
  .handler(async ({ data, context }) => {
    const patch: Record<string, unknown> = {};
    if (data.enabled !== undefined) patch.enabled = !!data.enabled;
    if (data.mode !== undefined) patch.mode = data.mode === "live" ? "live" : "demo";
    if (data.recovery_sms_enabled !== undefined)
      patch.recovery_sms_enabled = !!data.recovery_sms_enabled;
    if (data.plumber_alert_enabled !== undefined)
      patch.plumber_alert_enabled = !!data.plumber_alert_enabled;
    if (data.alert_method !== undefined)
      patch.alert_method = ["demo", "sms", "email"].includes(data.alert_method)
        ? data.alert_method
        : "demo";
    if (data.alert_phone !== undefined)
      patch.alert_phone = data.alert_phone ? String(data.alert_phone).slice(0, 40) : null;
    if (data.alert_email !== undefined)
      patch.alert_email = data.alert_email ? String(data.alert_email).slice(0, 200) : null;
    if (data.callback_message !== undefined)
      patch.callback_message = data.callback_message
        ? sanitizeTemplate(data.callback_message)
        : null;
    if (data.sms_template !== undefined) {
      const clean = sanitizeTemplate(String(data.sms_template));
      if (clean.trim().length < 10) throw new Error("SMS template too short");
      patch.sms_template = clean;
    }
    // Plan gating for enabling
    if (patch.enabled === true) {
      const { data: biz } = await context.supabase
        .from("businesses")
        .select("id")
        .limit(1)
        .maybeSingle();
      if (!biz) throw new Error("No business");
      const { data: acc } = await context.supabase.rpc("has_missed_call_access", {
        _business_id: biz.id,
      });
      if (!acc) throw new Error("Plan does not include missed-call recovery");
    }
    // Force live -> demo if SMS_MODE isn't twilio
    if (patch.mode === "live" && process.env.SMS_MODE !== "twilio") {
      patch.mode = "demo";
    }
    const { error } = await context.supabase
      .from("business_missed_call_settings")
      .update(patch as never)
      .eq(
        "business_id",
        (await context.supabase.from("businesses").select("id").limit(1).single()).data!.id,
      );
    if (error) throw new Error(error.message);
    return { success: true };
  });

/**
 * Render a template using safe variable substitution. Only whitelisted
 * variables are replaced; anything else is left literal.
 */
export function renderSmsTemplate(
  template: string,
  vars: { business_name: string; recovery_link: string; public_phone?: string | null },
): string {
  return template
    .replace(/\{\{\s*business_name\s*\}\}/g, vars.business_name)
    .replace(/\{\{\s*recovery_link\s*\}\}/g, vars.recovery_link)
    .replace(/\{\{\s*public_phone\s*\}\}/g, vars.public_phone ?? "");
}

export interface TestMissedCallInput {
  callerPhone: string;
  baseUrl?: string;
}

export interface TestMissedCallResult {
  missedCallId: string;
  smsBody: string;
  recoveryLink: string;
  businessSlug: string;
  businessName: string;
  mode: "demo" | "live";
  simulated: boolean;
}

/**
 * Authenticated: trigger a test missed call for the caller's own tenant.
 * Business is resolved server-side from auth.uid() — never trusted from
 * client input.
 */
export const sendTestMissedCall = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: TestMissedCallInput) => data)
  .handler(async ({ data, context }): Promise<TestMissedCallResult> => {
    const callerPhone = String(data.callerPhone ?? "").trim();
    if (!callerPhone) throw new Error("callerPhone required");

    const { data: biz, error: bErr } = await context.supabase
      .from("businesses")
      .select("id,name,slug,public_phone")
      .limit(1)
      .maybeSingle();
    if (bErr) throw new Error(bErr.message);
    if (!biz) throw new Error("No business membership");

    const { data: acc } = await context.supabase.rpc("has_missed_call_access", {
      _business_id: biz.id,
    });
    if (!acc)
      throw new Error(
        "Plan does not include missed-call recovery — choose a plan or renew your trial.",
      );

    let { data: s } = await context.supabase
      .from("business_missed_call_settings")
      .select("*")
      .eq("business_id", biz.id)
      .maybeSingle();
    if (!s) {
      const { data: ins } = await context.supabase
        .from("business_missed_call_settings")
        .insert({ business_id: biz.id } as never)
        .select("*")
        .single();
      s = ins;
    }
    const settings = s as MissedCallSettings;

    const smsMode: "demo" | "twilio" = process.env.SMS_MODE === "twilio" ? "twilio" : "demo";
    const effectiveMode: "demo" | "live" =
      settings.mode === "live" && smsMode === "twilio" ? "live" : "demo";

    const mcid = crypto.randomUUID();
    const baseUrl =
      data.baseUrl && /^https?:\/\//.test(data.baseUrl)
        ? data.baseUrl.replace(/\/+$/, "")
        : (process.env.PUBLIC_JOB_REQUEST_URL ?? "");
    const link = `${baseUrl}/b/${biz.slug}/request?source=missed_call&mcid=${mcid}`;
    const smsBody = renderSmsTemplate(settings.sms_template, {
      business_name: biz.name,
      recovery_link: link,
      public_phone: biz.public_phone,
    });

    // Insert tenant-scoped rows via authenticated client (RLS enforces business_id).
    const { error: mErr } = await context.supabase.from("missed_calls").insert({
      id: mcid,
      caller_phone: callerPhone,
      sms_sent: false,
      source: "test",
      business_id: biz.id,
    } as never);
    if (mErr) throw new Error(mErr.message);

    let smsResult: { id: string; status: "simulated" | "sent" | "failed" };
    if (effectiveMode === "live") {
      const { sendSms } = await import("@/lib/sms");
      smsResult = await sendSms(callerPhone, smsBody, biz.id);
      if (smsResult.status !== "sent") throw new Error("Recovery SMS delivery failed");
    } else {
      const simulatedId = crypto.randomUUID();
      const { error: sErr } = await context.supabase.from("sms_events").insert({
        id: simulatedId,
        to_number: callerPhone,
        from_number: "DEMO_NUMBER",
        body: smsBody,
        mode: "demo",
        status: "simulated",
        event_type: "customer_recovery_sms",
        business_id: biz.id,
      } as never);
      if (sErr) throw new Error(sErr.message);
      smsResult = { id: simulatedId, status: "simulated" };
    }
    const { error: updateError } = await context.supabase
      .from("missed_calls")
      .update({ sms_sent: smsResult.status === "sent", sms_event_id: smsResult.id } as never)
      .eq("id", mcid)
      .eq("business_id", biz.id);
    if (updateError) throw new Error(updateError.message);

    return {
      missedCallId: mcid,
      smsBody,
      recoveryLink: link,
      businessSlug: biz.slug,
      businessName: biz.name,
      mode: effectiveMode,
      simulated: effectiveMode !== "live",
    };
  });
