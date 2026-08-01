import { createFileRoute } from "@tanstack/react-router";
import { validateTwilioSignature } from "@/lib/twilio-webhook";
import { dispatchTextLinkRecovery, markForwardingVerified } from "@/lib/call-handling.server";

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

  const calledNumber = (params.get("To") ?? "").trim();
  const [{ data: telephony }, { data: textLinkAccess }] = await Promise.all([
    supabaseAdmin
      .from("business_telephony_settings")
      .select("missed_call_recovery_enabled,inbound_number")
      .eq("business_id", business.id)
      .maybeSingle(),
    supabaseAdmin.rpc("has_missed_call_access", { _business_id: business.id } as never),
  ]);
  const routing = telephony as {
    missed_call_recovery_enabled?: boolean;
    inbound_number?: string | null;
  } | null;
  if (
    !textLinkAccess ||
    routing?.missed_call_recovery_enabled !== true ||
    !calledNumber ||
    routing.inbound_number !== calledNumber
  ) {
    return Response.json({ ok: true, ignored: true, reason: "text_link_routing_inactive" });
  }

  const { data: settings, error: settingsError } = await supabaseAdmin
    .from("business_missed_call_settings")
    .select("enabled,recovery_sms_enabled,sms_template,mode")
    .eq("business_id", business.id)
    .maybeSingle();
  if (settingsError) return Response.json({ error: "Database error" }, { status: 500 });
  if (!settings?.enabled || !settings.recovery_sms_enabled || settings.mode !== "live") {
    return Response.json({ ok: true, ignored: true, reason: "recovery_disabled" });
  }

  const result = await dispatchTextLinkRecovery({
    tenant: {
      businessId: business.id,
      mode: "text_link",
      forwardingStatus: "verified",
      businessName: business.name,
      businessSlug: business.slug,
      publicPhone: business.public_phone,
      assistantId: null,
      smsTemplate: settings.sms_template,
      textLinkEntitled: true,
      aiReceptionistEntitled: false,
    },
    provider: "twilio",
    providerEventId: callSid,
    callerPhone,
    publicBaseUrl: publicBase,
  });
  if (result.outcome === "failed") {
    return Response.json(
      { error: "SMS delivery failed", missedCallId: result.missedCallId },
      { status: 502 },
    );
  }
  await markForwardingVerified(business.id, callSid);

  return Response.json(
    {
      ok: true,
      pending: result.outcome === "pending",
      deduped: result.deduped,
      missedCallId: result.missedCallId,
    },
    { status: result.outcome === "pending" ? 202 : 200 },
  );
}

export const Route = createFileRoute("/api/public/webhooks/twilio-missed-call/$slug")({
  server: {
    handlers: {
      POST: ({ request, params }) => handleTwilioMissedCall(request, params.slug),
    },
  },
});
