import { createFileRoute } from "@tanstack/react-router";
import { renderSmsTemplate } from "@/lib/missed-call.functions";
import { sendSms } from "@/lib/sms";
import { validateTwilioSignature } from "@/lib/twilio-webhook";

const MISSED_STATUSES = new Set(["busy", "failed", "no-answer", "canceled"]);

export async function handleTwilioMissedCall(request: Request, slug: string): Promise<Response> {
  const authToken = process.env.TWILIO_AUTH_TOKEN ?? "";
  const publicBase = (process.env.PUBLIC_JOB_REQUEST_URL ?? "").replace(/\/+$/, "");
  if (!authToken || !publicBase) {
    return Response.json({ error: "Server misconfigured" }, { status: 503 });
  }

  const rawBody = await request.text();
  const params = new URLSearchParams(rawBody);
  const signedUrl = `${publicBase}/api/public/webhooks/twilio-missed-call/${encodeURIComponent(slug)}`;
  if (
    !validateTwilioSignature(
      authToken,
      signedUrl,
      params,
      request.headers.get("x-twilio-signature") ?? "",
    )
  ) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const callStatus = params.get("CallStatus") ?? "";
  if (!MISSED_STATUSES.has(callStatus)) {
    return Response.json({ ok: true, ignored: true });
  }
  const callerPhone = (params.get("From") ?? "").trim();
  const callSid = (params.get("CallSid") ?? "").trim();
  if (!callerPhone || !callSid) {
    return Response.json({ error: "Missing Twilio call identity" }, { status: 400 });
  }

  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data: business, error: businessError } = await supabaseAdmin
    .from("businesses")
    .select("id,name,slug,public_phone,active")
    .eq("slug", slug)
    .eq("active", true)
    .maybeSingle();
  if (businessError) return Response.json({ error: "Database error" }, { status: 500 });
  if (!business) return Response.json({ error: "Unknown business" }, { status: 404 });

  const source = `twilio:${callSid}`;
  const { data: existing, error: existingError } = await supabaseAdmin
    .from("missed_calls")
    .select("id,sms_sent")
    .eq("business_id", business.id)
    .eq("source", source)
    .maybeSingle();
  if (existingError) return Response.json({ error: "Database error" }, { status: 500 });
  if (existing) return Response.json({ ok: true, deduped: true, missedCallId: existing.id });

  const missedCallId = crypto.randomUUID();
  const recoveryLink = `${publicBase}/b/${business.slug}/request?source=missed_call&mcid=${missedCallId}`;
  const { data: settings, error: settingsError } = await supabaseAdmin
    .from("business_missed_call_settings")
    .select("enabled,recovery_sms_enabled,sms_template,mode")
    .eq("business_id", business.id)
    .maybeSingle();
  if (settingsError) return Response.json({ error: "Database error" }, { status: 500 });
  if (!settings?.enabled || !settings.recovery_sms_enabled || settings.mode !== "live") {
    return Response.json({ ok: true, ignored: true, reason: "recovery_disabled" });
  }

  const smsBody = renderSmsTemplate(settings.sms_template, {
    business_name: business.name,
    recovery_link: recoveryLink,
    public_phone: business.public_phone,
  });
  const { error: insertError } = await supabaseAdmin.from("missed_calls").insert({
    id: missedCallId,
    caller_phone: callerPhone,
    sms_sent: false,
    source,
    business_id: business.id,
  });
  if (insertError) {
    if (/duplicate/i.test(insertError.message)) {
      return Response.json({ ok: true, deduped: true });
    }
    return Response.json({ error: "Database error" }, { status: 500 });
  }

  const result = await sendSms(callerPhone, smsBody, business.id);
  if (result.status !== "sent") {
    return Response.json({ error: "SMS delivery failed", missedCallId }, { status: 502 });
  }
  const { error: updateError } = await supabaseAdmin
    .from("missed_calls")
    .update({ sms_sent: true, sms_event_id: result.id })
    .eq("id", missedCallId)
    .eq("business_id", business.id);
  if (updateError)
    return Response.json({ error: "SMS sent but persistence failed" }, { status: 500 });

  return Response.json({ ok: true, missedCallId });
}

export const Route = createFileRoute("/api/public/webhooks/twilio-missed-call/$slug")({
  server: {
    handlers: {
      POST: ({ request, params }) => handleTwilioMissedCall(request, params.slug),
    },
  },
});
