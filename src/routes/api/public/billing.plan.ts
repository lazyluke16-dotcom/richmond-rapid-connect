import { createFileRoute } from "@tanstack/react-router";
import { extractBearerToken, requireAuthAndBusiness } from "@/lib/billing.server";
import type { SelectedPlan } from "@/lib/billing-types";

const ALLOWED_PLANS = new Set<SelectedPlan>(["missed_call_recovery", "ai_receptionist", "both"]);

export const Route = createFileRoute("/api/public/billing/plan")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const token = extractBearerToken(request);
        if (!token) return json({ error: "Unauthorized" }, 401);

        let requested: { plan?: string };
        try {
          requested = (await request.json()) as { plan?: string };
        } catch {
          return json({ error: "Invalid request" }, 400);
        }
        if (!requested.plan || !ALLOWED_PLANS.has(requested.plan as SelectedPlan)) {
          return json({ error: "Choose a valid subscription plan" }, 400);
        }

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        let businessId: string;
        try {
          ({ businessId } = await requireAuthAndBusiness(token, supabaseAdmin));
        } catch (cause) {
          const error = cause as { status?: number; message?: string };
          return json({ error: error.message ?? "Auth failed" }, error.status ?? 401);
        }

        const { data: billing, error: lookupError } = await supabaseAdmin
          .from("business_billing")
          .select("stripe_subscription_id")
          .eq("business_id", businessId)
          .maybeSingle();
        if (lookupError || !billing) return json({ error: "Billing record not found" }, 404);
        if ((billing as { stripe_subscription_id?: string | null }).stripe_subscription_id) {
          return json(
            {
              error: "Manage an active subscription in the secure billing portal",
              code: "already_subscribed",
            },
            409,
          );
        }

        const plan = requested.plan as SelectedPlan;
        const [{ error: billingError }, { error: businessError }] = await Promise.all([
          supabaseAdmin
            .from("business_billing")
            .update({ selected_plan: plan })
            .eq("business_id", businessId),
          supabaseAdmin.from("businesses").update({ selected_plan: plan }).eq("id", businessId),
        ]);
        if (billingError || businessError) {
          return json({ error: "Could not save the selected plan" }, 500);
        }
        return json({ plan }, 200);
      },
    },
  },
});

function json(body: Record<string, unknown>, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
