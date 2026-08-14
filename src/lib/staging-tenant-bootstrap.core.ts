// Staging-ONLY bootstrap for a Smart Answer certification tenant.
//
// This provisions a purpose-made isolated-staging tenant and its STANDARD AI
// receptionist by calling the SAME canonical provisioning core used by the
// authenticated server function (provisionAiAssistantForBusinessInternal). It
// runs with service authority, so it is hard-gated to fail closed unless every
// staging guard passes. It must never run against production and never touches
// Smart Answer SIP/enablement, Twilio, or carrier forwarding.
import {
  provisionAiAssistantForBusinessInternal,
  assertAiAccess,
} from "@/lib/ai-provisioning.core";

export const CERTIFICATION_TENANT_SLUG = "smart-answer-certification-staging";
export const CERTIFICATION_TENANT_NAME = "Smart Answer Certification";

const STAGING_ID = /^staging[-_][a-z0-9][a-z0-9_-]{2,63}$/i;
const PRODUCTION_LIKE = /(^|[-_.])(prod|production|live)([-_.]|$)/i;
const CERTIFICATION_SLUG = /^smart-answer-certification[-a-z0-9]*$/i;

export interface StagingBootstrapEnv {
  DEPLOYMENT_TARGET?: string;
  STAGING_CERTIFICATION_ENABLED?: string;
  CERTIFICATION_ENVIRONMENT_ID?: string;
  SUPABASE_URL?: string;
  EXPECTED_STAGING_SUPABASE_PROJECT_REF?: string;
}

/** Throws unless EVERY isolated-staging guard passes. Fails closed. */
export function assertStagingBootstrapAllowed(
  slug: string,
  env: StagingBootstrapEnv = process.env,
): void {
  const fail = (why: string) => {
    throw new Error(`Staging bootstrap refused: ${why}`);
  };
  if (env.DEPLOYMENT_TARGET !== "staging") fail("DEPLOYMENT_TARGET is not 'staging'");
  if (env.STAGING_CERTIFICATION_ENABLED !== "true")
    fail("STAGING_CERTIFICATION_ENABLED is not 'true'");
  const envId = (env.CERTIFICATION_ENVIRONMENT_ID ?? "").trim();
  if (!STAGING_ID.test(envId) || PRODUCTION_LIKE.test(envId))
    fail(`CERTIFICATION_ENVIRONMENT_ID '${envId}' is not a staging-only id`);
  const expectedRef = (env.EXPECTED_STAGING_SUPABASE_PROJECT_REF ?? "").trim();
  const url = env.SUPABASE_URL ?? "";
  const refMatch = url.match(/^https:\/\/([a-z0-9]+)\.supabase\.co/i);
  const actualRef = refMatch ? refMatch[1] : "";
  if (!expectedRef) fail("EXPECTED_STAGING_SUPABASE_PROJECT_REF is not configured");
  if (!actualRef) fail("SUPABASE_URL does not look like an isolated staging project URL");
  if (actualRef !== expectedRef)
    fail("SUPABASE_URL project ref does not match the expected isolated staging project");
  if (PRODUCTION_LIKE.test(slug) || !CERTIFICATION_SLUG.test(slug))
    fail(`slug '${slug}' is not an explicit certification/test slug`);
}

type WriteResult = { error: { message: string } | null };
type ReadResult = { data: Record<string, unknown> | null; error?: { message: string } | null };
interface QueryBuilder extends PromiseLike<WriteResult> {
  select: (columns: string) => QueryBuilder;
  eq: (column: string, value: string) => QueryBuilder;
  limit: (n: number) => QueryBuilder;
  update: (row: Record<string, unknown>) => QueryBuilder;
  insert: (row: Record<string, unknown>) => QueryBuilder;
  upsert: (row: Record<string, unknown>, opts?: unknown) => QueryBuilder;
  maybeSingle: () => Promise<ReadResult>;
  single: () => Promise<ReadResult>;
}
interface SupabaseAdminLike {
  from: (t: string) => QueryBuilder;
}

async function findOrCreateCertificationBusiness(
  supabaseAdmin: SupabaseAdminLike,
  slug: string,
): Promise<{ businessId: string; created: boolean }> {
  const { data: existing, error: findError } = await supabaseAdmin
    .from("businesses")
    .select("id")
    .eq("slug", slug)
    .maybeSingle();
  if (findError) throw new Error(`Lookup business failed: ${findError.message}`);
  if (existing?.id) return { businessId: existing.id as string, created: false };

  const { data: inserted, error: insertError } = await supabaseAdmin
    .from("businesses")
    .insert({
      name: CERTIFICATION_TENANT_NAME,
      slug,
      selected_plan: "ai_receptionist",
      active: true,
      // Service-role-only, staging-test billing exemption. has_ai_receptionist_access
      // grants entitlement via effective_billing_state() = 'billing_exempt_test'.
      billing_exempt: true,
    } as never)
    .select("id")
    .single();
  if (insertError) throw new Error(`Create business failed: ${insertError.message}`);
  return { businessId: (inserted as { id: string }).id, created: true };
}

async function ensureRow(
  supabaseAdmin: SupabaseAdminLike,
  table: string,
  businessId: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const { data: existing } = await supabaseAdmin
    .from(table)
    .select("business_id")
    .eq("business_id", businessId)
    .maybeSingle();
  if (existing) return;
  const { error } = await supabaseAdmin
    .from(table)
    .insert({ business_id: businessId, ...extra } as never);
  if (error) throw new Error(`Seed ${table} failed: ${error.message}`);
}

async function ensureService(supabaseAdmin: SupabaseAdminLike, businessId: string): Promise<void> {
  const { data } = await supabaseAdmin
    .from("business_services")
    .select("id")
    .eq("business_id", businessId)
    .limit(1)
    .maybeSingle();
  if (data) return;
  const { error } = await supabaseAdmin.from("business_services").insert({
    business_id: businessId,
    service_key: "general_plumbing",
    display_name: "General Plumbing",
  } as never);
  if (error) throw new Error(`Seed business_services failed: ${error.message}`);
}

async function ensureArea(supabaseAdmin: SupabaseAdminLike, businessId: string): Promise<void> {
  const { data } = await supabaseAdmin
    .from("business_service_areas")
    .select("id")
    .eq("business_id", businessId)
    .limit(1)
    .maybeSingle();
  if (data) return;
  const { error } = await supabaseAdmin.from("business_service_areas").insert({
    business_id: businessId,
    suburb: "Richmond",
    state: "VIC",
  } as never);
  if (error) throw new Error(`Seed business_service_areas failed: ${error.message}`);
}

export interface StagingBootstrapResult {
  businessId: string;
  slug: string;
  name: string;
  createdTenant: boolean;
  aiAccess: boolean;
  provisioning: "created" | "reused";
  providerAssistantId: string | null;
  assistantStatus: string | null;
  provider: string | null;
  mappingActive: boolean;
  answeringMode: string | null;
  aiReceptionistEnabled: boolean;
  smartAnswerEnabled: boolean;
  smartAnswerAssistantId: string | null;
  smartAnswerSipPhoneId: string | null;
  smartAnswerSipUri: string | null;
  forwardingSetupStatus: string | null;
}

/**
 * Bootstrap (or reuse) the isolated-staging Smart Answer certification tenant
 * and provision its STANDARD Vapi receptionist. Idempotent: an existing tenant
 * and an already-provisioned assistant are reused rather than duplicated. Does
 * NOT enable Smart Answer or provision any SIP/phone resource.
 */
export async function bootstrapSmartAnswerCertificationTenant(
  env: StagingBootstrapEnv = process.env,
): Promise<StagingBootstrapResult> {
  const slug = CERTIFICATION_TENANT_SLUG;
  assertStagingBootstrapAllowed(slug, env);

  const { supabaseAdmin: rawAdmin } = await import("@/integrations/supabase/client.server");
  const supabaseAdmin = rawAdmin as unknown as SupabaseAdminLike;

  const { businessId, created } = await findOrCreateCertificationBusiness(supabaseAdmin, slug);

  // Ensure the staging-test billing exemption even for a tenant created by an
  // earlier partial run (service role may change billing_exempt; the immutable-
  // lock trigger only blocks the 'authenticated' role).
  const { error: exemptError } = await supabaseAdmin
    .from("businesses")
    .update({ billing_exempt: true } as never)
    .eq("id", businessId);
  if (exemptError) throw new Error(`Set staging billing exemption failed: ${exemptError.message}`);

  // Minimal valid application state for standard AI receptionist provisioning.
  // AI settings and telephony rows rely on their column defaults; we only pin
  // the certification-specific values.
  await ensureRow(supabaseAdmin, "business_ai_receptionist_settings", businessId, {
    assistant_name: "Smart Answer Certification Receptionist",
  });
  await ensureRow(supabaseAdmin, "business_telephony_settings", businessId);
  await ensureService(supabaseAdmin, businessId);
  await ensureArea(supabaseAdmin, businessId);

  const aiAccess = await assertAiAccess(businessId)
    .then(() => true)
    .catch(() => false);
  if (!aiAccess) {
    throw new Error("Certification tenant does not have AI receptionist access after seeding");
  }

  // Reuse an already-provisioned standard receptionist to avoid duplicate Vapi
  // assistants on re-run.
  const { data: existingSettings } = await supabaseAdmin
    .from("business_ai_receptionist_settings")
    .select("provider_assistant_id,status")
    .eq("business_id", businessId)
    .maybeSingle();
  const existingAssistant = (
    existingSettings as { provider_assistant_id?: string; status?: string } | null
  )?.provider_assistant_id;

  let provisioning: "created" | "reused" = "reused";
  if (!existingAssistant) {
    const result = await provisionAiAssistantForBusinessInternal(businessId);
    if (!result.provisioned) {
      throw new Error(`Standard receptionist provisioning failed: ${result.reason}`);
    }
    provisioning = "created";
  }

  // Establish standard AI receptionist call-handling readiness. Smart Answer
  // stays OFF; forwarding is never falsely marked verified.
  const { error: telephonyError } = await supabaseAdmin
    .from("business_telephony_settings")
    .update({ answering_mode: "ai_receptionist", ai_receptionist_enabled: true } as never)
    .eq("business_id", businessId);
  if (telephonyError)
    throw new Error(`Set call-handling readiness failed: ${telephonyError.message}`);

  // Read back the final, sanitised state for verification.
  const [{ data: settings }, { data: telephony }, { data: mapping }] = await Promise.all([
    supabaseAdmin
      .from("business_ai_receptionist_settings")
      .select("provider_assistant_id,status,provider,smart_answer_assistant_id")
      .eq("business_id", businessId)
      .maybeSingle(),
    supabaseAdmin
      .from("business_telephony_settings")
      .select(
        "answering_mode,ai_receptionist_enabled,smart_answer_enabled,smart_answer_sip_phone_id,smart_answer_sip_uri,forwarding_setup_status",
      )
      .eq("business_id", businessId)
      .maybeSingle(),
    supabaseAdmin
      .from("ai_provider_mappings")
      .select("active")
      .eq("business_id", businessId)
      .eq("provider", "vapi")
      .maybeSingle(),
  ]);

  const s = (settings ?? {}) as Record<string, unknown>;
  const t = (telephony ?? {}) as Record<string, unknown>;
  const m = (mapping ?? {}) as Record<string, unknown>;

  return {
    businessId,
    slug,
    name: CERTIFICATION_TENANT_NAME,
    createdTenant: created,
    aiAccess,
    provisioning,
    providerAssistantId: (s.provider_assistant_id as string) ?? null,
    assistantStatus: (s.status as string) ?? null,
    provider: (s.provider as string) ?? null,
    mappingActive: m.active === true,
    answeringMode: (t.answering_mode as string) ?? null,
    aiReceptionistEnabled: t.ai_receptionist_enabled === true,
    smartAnswerEnabled: t.smart_answer_enabled === true,
    smartAnswerAssistantId: (s.smart_answer_assistant_id as string) ?? null,
    smartAnswerSipPhoneId: (t.smart_answer_sip_phone_id as string) ?? null,
    smartAnswerSipUri: (t.smart_answer_sip_uri as string) ?? null,
    forwardingSetupStatus: (t.forwarding_setup_status as string) ?? null,
  };
}
