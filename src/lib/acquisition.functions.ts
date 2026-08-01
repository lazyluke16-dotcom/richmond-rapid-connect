import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  AcquisitionPlanSchema,
  AcquisitionAttributionSchema,
  normalizePromoCode,
  type AcquisitionPlan,
} from "@/lib/acquisition";
import { resolveDemoVariant, type DemoVariant } from "@/lib/demo-variants";

export interface AuthenticatedAcquisitionContext {
  businessName: string | null;
  plan: AcquisitionPlan | null;
  promoCode: string | null;
  attribution: {
    source: string | null;
    medium: string | null;
    campaign: string | null;
    content: string | null;
    referralCode: string | null;
  };
}

function text(value: unknown, max = 120): string | null {
  if (typeof value !== "string") return null;
  const clean = value.trim().slice(0, max);
  return clean || null;
}

export function acquisitionContextFromClaims(claims: unknown): AuthenticatedAcquisitionContext {
  const metadata =
    claims && typeof claims === "object" && "user_metadata" in claims
      ? (claims as { user_metadata?: Record<string, unknown> }).user_metadata
      : undefined;
  const planResult = AcquisitionPlanSchema.safeParse(metadata?.acquisition_plan);
  return {
    businessName: text(metadata?.business_name),
    plan: planResult.success ? planResult.data : null,
    promoCode: metadata?.acquisition_promo_code
      ? normalizePromoCode(String(metadata.acquisition_promo_code))
      : null,
    attribution: AcquisitionAttributionSchema.parse({
      source: text(metadata?.acquisition_source),
      medium: text(metadata?.acquisition_medium),
      campaign: text(metadata?.acquisition_campaign),
      content: text(metadata?.acquisition_content),
      referralCode: text(metadata?.referral_code),
    }),
  };
}

export const getMyAcquisitionContext = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<AuthenticatedAcquisitionContext> =>
    acquisitionContextFromClaims(context.claims),
  );

export const redeemMyAcquisitionOffer = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (data: {
      code: string;
      plan: AcquisitionPlan;
      session_id?: string | null;
      attribution?: {
        source?: string | null;
        medium?: string | null;
        campaign?: string | null;
        content?: string | null;
      };
      demoVariant?: DemoVariant | null;
    }) => data,
  )
  .handler(async ({ data, context }) => {
    const plan = AcquisitionPlanSchema.parse(data.plan);
    const attribution = AcquisitionAttributionSchema.parse({
      ...data.attribution,
      referralCode: null,
    });
    const { data: result, error } = await context.supabase.rpc(
      "redeem_acquisition_offer" as never,
      {
        _code: normalizePromoCode(data.code),
        _plan: plan,
        _session_id: data.session_id ?? null,
        _source: attribution.source,
        _medium: attribution.medium,
        _campaign: attribution.campaign,
        _content: attribution.content,
      } as never,
    );
    if (error) throw new Error(error.message);
    // Match redeem_acquisition_offer's authoritative business selection exactly:
    // the caller's earliest membership, never an arbitrary browser-provided ID.
    const { data: membership, error: membershipError } = await context.supabase
      .from("business_users")
      .select("business_id")
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (membershipError) throw new Error(membershipError.message);
    if (!membership?.business_id) throw new Error("No business membership found");
    const { error: variantError } = await context.supabase
      .from("businesses")
      .update({ acquisition_demo_variant: resolveDemoVariant(data.demoVariant) } as never)
      .eq("id", membership.business_id);
    if (variantError) throw new Error(variantError.message);
    return result as unknown as {
      success: true;
      promotionCode: string;
      plan: AcquisitionPlan;
      setupFeeWaivedCents: number;
      offerVersion: string;
      subscriptionMonthsFree: number;
    };
  });
