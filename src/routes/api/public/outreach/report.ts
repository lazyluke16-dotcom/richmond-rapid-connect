import { createFileRoute } from "@tanstack/react-router";
import { extractBearerToken } from "@/lib/billing.server";
import {
  buildOutreachOperationsReport,
  isOutreachOperator,
  parseOutreachReportDays,
  type AcquisitionEventRow,
  type AcquisitionRedemptionRow,
  type ActivatedBusinessRow,
  type OutreachCampaignRow,
  type OutreachMessageRow,
  type OutreachRecipientRow,
  type OutreachSuppressionRow,
} from "@/lib/outreach-report";

const headers = { "Content-Type": "application/json", "Cache-Control": "no-store" };

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers });
}

export const Route = createFileRoute("/api/public/outreach/report")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const token = extractBearerToken(request);
        if (!token) return json({ error: "Unauthorized" }, 401);

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { data: auth, error: authError } = await supabaseAdmin.auth.getUser(token);
        if (authError || !auth.user) return json({ error: "Unauthorized" }, 401);
        if (!isOutreachOperator(auth.user.id, process.env.OUTREACH_OPERATOR_USER_IDS)) {
          return json({ error: "Forbidden" }, 403);
        }

        let days: number;
        try {
          days = parseOutreachReportDays(new URL(request.url).searchParams.get("days"));
        } catch (cause) {
          return json(
            { error: cause instanceof Error ? cause.message : "Invalid report window" },
            400,
          );
        }
        const since = new Date(Date.now() - days * 86_400_000).toISOString();

        const [
          eventResult,
          campaignResult,
          recipientResult,
          messageResult,
          suppressionResult,
          redemptionResult,
          businessResult,
        ] = await Promise.all([
          supabaseAdmin
            .from("acquisition_events" as never)
            .select("event_name,session_id,campaign,source,created_at")
            .gte("created_at", since),
          supabaseAdmin
            .from("outreach_campaigns" as never)
            .select("id,name,code,status,created_at")
            .order("created_at", { ascending: false }),
          supabaseAdmin
            .from("outreach_recipients" as never)
            .select("campaign_id,channel,eligibility_status"),
          supabaseAdmin
            .from("outreach_messages" as never)
            .select("campaign_id,channel,status")
            .gte("created_at", since),
          supabaseAdmin
            .from("outreach_suppressions" as never)
            .select("channel,reason,suppressed_at")
            .gte("suppressed_at", since),
          supabaseAdmin
            .from("acquisition_promo_redemptions" as never)
            .select("campaign,plan,waived_setup_fee_cents,redeemed_at")
            .gte("redeemed_at", since),
          supabaseAdmin
            .from("businesses" as never)
            .select("id,acquisition_campaign")
            .not("acquisition_session_id", "is", null)
            .gte("created_at", since),
        ]);

        const failed = [
          eventResult,
          campaignResult,
          recipientResult,
          messageResult,
          suppressionResult,
          redemptionResult,
          businessResult,
        ].find((result) => result.error);
        if (failed?.error)
          return json({ error: "Operations report is temporarily unavailable" }, 503);

        const businesses = (businessResult.data ?? []) as unknown as {
          id: string;
          acquisition_campaign: string | null;
        }[];
        const businessIds = businesses.map((row) => row.id);
        const billingResult = businessIds.length
          ? await supabaseAdmin
              .from("business_billing")
              .select("business_id,billing_status")
              .in("business_id", businessIds)
          : { data: [], error: null };
        if (billingResult.error)
          return json({ error: "Operations report is temporarily unavailable" }, 503);
        const billingByBusiness = new Map(
          (
            (billingResult.data ?? []) as { business_id: string; billing_status: string | null }[]
          ).map((row) => [row.business_id, row.billing_status]),
        );
        const activatedBusinesses: ActivatedBusinessRow[] = businesses.map((business) => ({
          campaign: business.acquisition_campaign,
          billing_status: billingByBusiness.get(business.id) ?? null,
        }));

        return json(
          buildOutreachOperationsReport({
            events: (eventResult.data ?? []) as unknown as AcquisitionEventRow[],
            campaigns: (campaignResult.data ?? []) as unknown as OutreachCampaignRow[],
            recipients: (recipientResult.data ?? []) as unknown as OutreachRecipientRow[],
            messages: (messageResult.data ?? []) as unknown as OutreachMessageRow[],
            suppressions: (suppressionResult.data ?? []) as unknown as OutreachSuppressionRow[],
            redemptions: (redemptionResult.data ?? []) as unknown as AcquisitionRedemptionRow[],
            activatedBusinesses,
            generatedAt: new Date().toISOString(),
            windowDays: days,
          }),
        );
      },
    },
  },
});
