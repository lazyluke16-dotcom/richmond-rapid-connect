import { createFileRoute } from "@tanstack/react-router";
import {
  AcquisitionEventSchema,
  PromoValidationRequestSchema,
  normalizePromoCode,
} from "@/lib/acquisition";

const jsonHeaders = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: jsonHeaders });
}

export const Route = createFileRoute("/api/public/acquisition")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return json({ error: "Invalid JSON" }, 400);
        }
        if (!body || typeof body !== "object" || !("action" in body)) {
          return json({ error: "Invalid acquisition request" }, 400);
        }

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

        if ((body as { action?: unknown }).action === "validate_promo") {
          const parsed = PromoValidationRequestSchema.safeParse(body);
          if (!parsed.success)
            return json({ valid: false, error: "Invalid promotion request" }, 400);
          const code = normalizePromoCode(parsed.data.code);
          const now = new Date().toISOString();
          const { data, error } = await supabaseAdmin
            .from("acquisition_promo_codes" as never)
            .select(
              "code,active,starts_at,expires_at,max_redemptions,redemption_count,applicable_plans,text_setup_fee_cents,combined_setup_fee_cents",
            )
            .eq("code", code)
            .maybeSingle();
          if (error) return json({ valid: false, error: "Promotion validation unavailable" }, 503);
          const promo = data as unknown as {
            code: string;
            active: boolean;
            starts_at: string;
            expires_at: string | null;
            max_redemptions: number | null;
            redemption_count: number;
            applicable_plans: string[];
            text_setup_fee_cents: number;
            combined_setup_fee_cents: number;
          } | null;
          const valid =
            Boolean(promo?.active) &&
            Boolean(promo && promo.starts_at <= now) &&
            Boolean(!promo?.expires_at || promo.expires_at > now) &&
            Boolean(
              promo?.max_redemptions == null || promo.redemption_count < promo.max_redemptions,
            ) &&
            Boolean(promo?.applicable_plans.includes(parsed.data.plan));
          if (!valid || !promo) return json({ valid: false, code, error: "Code is not available" });
          const waivedSetupFeeCents =
            parsed.data.plan === "ai_receptionist"
              ? promo.combined_setup_fee_cents
              : promo.text_setup_fee_cents;
          return json({
            valid: true,
            code: promo.code,
            plan: parsed.data.plan,
            waivedSetupFeeCents,
            expiresAt: promo.expires_at,
          });
        }

        if ((body as { action?: unknown }).action === "track") {
          const parsed = AcquisitionEventSchema.safeParse(body);
          if (!parsed.success) return json({ accepted: false }, 400);
          const event = parsed.data;
          const { error } = await supabaseAdmin.from("acquisition_events" as never).upsert(
            {
              event_id: event.eventId,
              session_id: event.sessionId,
              event_name: event.eventName,
              path: event.path,
              plan: event.plan ?? null,
              promo_code: event.promoCode ? normalizePromoCode(event.promoCode) : null,
              wizard_step: event.wizardStep ?? null,
              source: event.attribution.source,
              medium: event.attribution.medium,
              campaign: event.attribution.campaign,
              content: event.attribution.content,
            } as never,
            { onConflict: "event_id", ignoreDuplicates: true } as never,
          );
          if (error) return json({ accepted: false }, 503);
          return json({ accepted: true }, 202);
        }

        return json({ error: "Unsupported acquisition action" }, 400);
      },
    },
  },
});
