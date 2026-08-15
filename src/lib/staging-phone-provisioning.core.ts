// Staging-ONLY: purchase (or reuse) ONE Australian mobile Voice number in the
// isolated Twilio subaccount and allocate it to the Smart Answer Certification
// tenant, replicating the canonical reserve_my_platform_phone() effect with
// service authority. Hard-gated: refuses unless staging guards pass AND the
// authenticated Twilio account is exactly the staging subaccount. Never marks
// forwarding verified, never changes answering_mode, never touches production.
import {
  assertStagingBootstrapAllowed,
  CERTIFICATION_TENANT_SLUG,
} from "@/lib/staging-tenant-bootstrap.core";

export const EXPECTED_TWILIO_ACCOUNT_NAME = "Richmond Rapid Connect Hosted Staging";
export const CERTIFICATION_BUSINESS_ID = "7e08963d-2b6f-47c4-9e52-09fb4503c27d";
export const NUMBER_FRIENDLY_NAME = "Smart Answer Staging Certification";
// ACMA-reserved fictitious mobile (0491 570 xxx) — safe non-dialable placeholder
// for the tenant's "business phone" (the forwarding target is never actually called).
export const STAGING_PLACEHOLDER_FORWARDING = "+61491570156";

const TWILIO_BASE = "https://api.twilio.com/2010-04-01";
const TWILIO_NUMBERS_BASE = "https://numbers.twilio.com";
const TWILIO_PRICING_BASE = "https://pricing.twilio.com";

// The approved AU Mobile - Business regulatory bundle for the staging subaccount. This is a
// resource identifier (not an auth secret) so it may be pinned; an env override is honoured.
export const DEFAULT_STAGING_BUNDLE_SID = "BU1c43633a6ef6580e07204d4b73cf8cd7";
// Hard recurring-cost cap for the staging number (USD/month).
export const MAX_MONTHLY_PRICE_USD = 10;

type Json = Record<string, unknown>;
type TwilioError = Error & { twilioCode?: number | null; httpStatus?: number };

interface TwilioNumber {
  phone_number: string;
  sid: string;
  friendly_name: string | null;
  voice_url: string | null;
  voice_method: string | null;
  account_sid?: string;
}

interface WriteResult {
  error: { message: string } | null;
}
interface ReadResult {
  data: Record<string, unknown> | null;
  error?: { message: string } | null;
}
interface QueryBuilder extends PromiseLike<WriteResult> {
  select: (columns: string) => QueryBuilder;
  eq: (column: string, value: string) => QueryBuilder;
  update: (row: Record<string, unknown>) => QueryBuilder;
  insert: (row: Record<string, unknown>) => QueryBuilder;
  maybeSingle: () => Promise<ReadResult>;
  single: () => Promise<ReadResult>;
}
interface SupabaseAdminLike {
  from: (table: string) => QueryBuilder;
}

function authHeader(sid: string, token: string): string {
  return "Basic " + Buffer.from(`${sid}:${token}`).toString("base64");
}

async function twilioGet(sid: string, token: string, path: string): Promise<Json> {
  const res = await fetch(`${TWILIO_BASE}${path}`, {
    headers: { Authorization: authHeader(sid, token) },
  });
  const text = await res.text();
  const body: Json = text ? (JSON.parse(text) as Json) : {};
  if (!res.ok) {
    const e = new Error(
      `Twilio GET ${path} -> ${res.status}: ${String(body.message ?? text.slice(0, 200))}`,
    ) as TwilioError;
    e.twilioCode = (body.code as number) ?? null;
    e.httpStatus = res.status;
    throw e;
  }
  return body;
}

async function twilioGetAbsolute(sid: string, token: string, url: string): Promise<Json> {
  const res = await fetch(url, { headers: { Authorization: authHeader(sid, token) } });
  const text = await res.text();
  const body: Json = text ? (JSON.parse(text) as Json) : {};
  if (!res.ok) {
    const e = new Error(
      `Twilio GET ${url} -> ${res.status}: ${String(body.message ?? text.slice(0, 200))}`,
    ) as TwilioError;
    e.twilioCode = (body.code as number) ?? null;
    e.httpStatus = res.status;
    throw e;
  }
  return body;
}

/**
 * Prove the pinned regulatory bundle is APPROVED and is the correct AU / mobile / business
 * bundle. Fails closed (never purchases) on any mismatch — wrong SID, not approved, or wrong
 * country/number-type/end-user context.
 */
async function verifyApprovedBundle(
  sid: string,
  token: string,
  expectedBundleSid: string,
): Promise<{ bundleSid: string; status: string; regulationSid: string }> {
  const bundle = await twilioGetAbsolute(
    sid,
    token,
    `${TWILIO_NUMBERS_BASE}/v2/RegulatoryCompliance/Bundles/${encodeURIComponent(expectedBundleSid)}`,
  );
  const bundleSid = String(bundle.sid ?? "");
  if (bundleSid !== expectedBundleSid) {
    throw new Error(
      `Refused: regulatory bundle SID mismatch ('${bundleSid}' != '${expectedBundleSid}')`,
    );
  }
  const status = String(bundle.status ?? "");
  if (status !== "twilio-approved") {
    throw new Error(
      `Refused: regulatory bundle ${bundleSid} status is '${status}', not 'twilio-approved'`,
    );
  }
  const regulationSid = String(bundle.regulation_sid ?? "");
  if (!regulationSid) throw new Error(`Refused: bundle ${bundleSid} has no associated regulation`);
  const regulation = await twilioGetAbsolute(
    sid,
    token,
    `${TWILIO_NUMBERS_BASE}/v2/RegulatoryCompliance/Regulations/${encodeURIComponent(regulationSid)}`,
  );
  const iso = String(regulation.iso_country ?? "").toUpperCase();
  const numberType = String(regulation.number_type ?? "").toLowerCase();
  const endUser = String(regulation.end_user_type ?? "").toLowerCase();
  if (iso !== "AU" || numberType !== "mobile" || endUser !== "business") {
    throw new Error(
      `Refused: bundle ${bundleSid} regulation is ${iso}/${numberType}/${endUser}, expected AU/mobile/business`,
    );
  }
  return { bundleSid, status, regulationSid };
}

/** Discover the approved AU Address resource created for the bundle. Fails closed if absent. */
async function findApprovedAuAddress(sid: string, token: string): Promise<string> {
  const body = await twilioGet(
    sid,
    token,
    `/Accounts/${encodeURIComponent(sid)}/Addresses.json?PageSize=50`,
  );
  const addresses = (body.addresses as Json[] | undefined) ?? [];
  const au = addresses.find((a) => String(a.iso_country ?? "").toUpperCase() === "AU");
  const addressSid = au ? String(au.sid ?? "") : "";
  if (!addressSid) {
    throw new Error(
      "Refused: no AU Address resource found on the staging subaccount for the approved bundle",
    );
  }
  return addressSid;
}

/** Verify the AU mobile recurring price is USD and within the cap. Fails closed otherwise. */
async function assertAffordableAuMobile(sid: string, token: string): Promise<number> {
  const pricing = await twilioGetAbsolute(
    sid,
    token,
    `${TWILIO_PRICING_BASE}/v1/PhoneNumbers/Countries/AU`,
  );
  const unit = String(pricing.price_unit ?? "").toLowerCase();
  const prices = (pricing.phone_number_prices as Json[] | undefined) ?? [];
  const mobile = prices.find((p) => String(p.number_type ?? "").toLowerCase() === "mobile");
  const price = mobile ? Number(mobile.current_price ?? mobile.base_price) : Number.NaN;
  if (unit !== "usd" || !Number.isFinite(price)) {
    throw new Error(`Refused: could not determine AU mobile USD price (unit='${unit}')`);
  }
  if (price > MAX_MONTHLY_PRICE_USD) {
    throw new Error(
      `Refused: AU mobile recurring price $${price} exceeds the $${MAX_MONTHLY_PRICE_USD}/mo cap`,
    );
  }
  return price;
}

async function twilioPostForm(
  sid: string,
  token: string,
  path: string,
  form: Record<string, string>,
): Promise<Json> {
  const res = await fetch(`${TWILIO_BASE}${path}`, {
    method: "POST",
    headers: {
      Authorization: authHeader(sid, token),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(form).toString(),
  });
  const text = await res.text();
  const body: Json = text ? (JSON.parse(text) as Json) : {};
  if (!res.ok) {
    const e = new Error(
      `Twilio POST ${path} -> ${res.status}: ${String(body.message ?? text.slice(0, 200))}`,
    ) as TwilioError;
    e.twilioCode = (body.code as number) ?? null;
    e.httpStatus = res.status;
    throw e;
  }
  return body;
}

function asNumber(body: Json): TwilioNumber {
  return {
    phone_number: String(body.phone_number ?? ""),
    sid: String(body.sid ?? ""),
    friendly_name: (body.friendly_name as string) ?? null,
    voice_url: (body.voice_url as string) ?? null,
    voice_method: (body.voice_method as string) ?? null,
    account_sid: (body.account_sid as string) ?? undefined,
  };
}

// Twilio error codes that indicate a missing Address / Regulatory Bundle.
const ADDRESS_REGULATORY_CODES = new Set([21649, 21631, 21669, 21625, 22102, 21650]);

export interface StagingPhoneResult {
  action: "purchased" | "reused-existing" | "already-allocated";
  accountName: string;
  phoneNumber: string;
  phoneSid: string;
  friendlyName: string | null;
  voiceUrl: string | null;
  voiceMethod: string | null;
  inventoryId: string | null;
  inventoryStatus: string | null;
  reservedBusinessId: string | null;
  telephonyInventoryPhoneId: string | null;
  telephonyInboundNumber: string | null;
  forwardingSetupStatus: string | null;
  answeringMode: string | null;
  smartAnswerEnabled: boolean;
  smartAnswerSipPhoneId: string | null;
  tenantResolvesToCertBusiness: boolean;
  /** Regulatory bundle associated with a newly purchased number (null when reusing). */
  regulatoryBundleSid: string | null;
  /** Address resource associated with a newly purchased number (null when reusing). */
  addressSid: string | null;
  smsCapable: boolean;
  /** Verified AU-mobile recurring price in USD/month at purchase time (null when reusing). */
  monthlyPriceUsd: number | null;
}

/**
 * Purchase/reuse ONE AU mobile Voice number in the staging subaccount and
 * allocate it to the certification tenant. Idempotent across the purchase
 * boundary: an existing number named NUMBER_FRIENDLY_NAME is reused rather than
 * buying again.
 */
export async function provisionStagingCertificationPhone(
  env: NodeJS.ProcessEnv = process.env,
): Promise<StagingPhoneResult> {
  assertStagingBootstrapAllowed(CERTIFICATION_TENANT_SLUG, env);

  const sid = (env.TWILIO_ACCOUNT_SID ?? "").trim();
  const token = (env.TWILIO_AUTH_TOKEN ?? "").trim();
  if (!sid || !token) throw new Error("TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN not configured");

  // GUARD: the authenticated Twilio account MUST be the staging subaccount.
  const account = await twilioGet(sid, token, `/Accounts/${encodeURIComponent(sid)}.json`);
  const accountName = String(account.friendly_name ?? "");
  if (accountName !== EXPECTED_TWILIO_ACCOUNT_NAME) {
    throw new Error(
      `Refused: authenticated Twilio account is '${accountName}', not the staging subaccount '${EXPECTED_TWILIO_ACCOUNT_NAME}'`,
    );
  }

  const base = (env.CERTIFICATION_BASE_URL ?? env.PUBLIC_JOB_REQUEST_URL ?? "").replace(/\/$/, "");
  if (!base) throw new Error("CERTIFICATION_BASE_URL is required for the Voice webhook");
  const voiceUrl = `${base}/api/public/webhooks/twilio-smart-answer`;

  const { supabaseAdmin: rawAdmin } = await import("@/integrations/supabase/client.server");
  const supabaseAdmin = rawAdmin as unknown as SupabaseAdminLike;

  const { data: existingTel } = await supabaseAdmin
    .from("business_telephony_settings")
    .select("inventory_phone_id")
    .eq("business_id", CERTIFICATION_BUSINESS_ID)
    .maybeSingle();
  const alreadyAllocated = Boolean(
    (existingTel as { inventory_phone_id?: string } | null)?.inventory_phone_id,
  );

  // Find (idempotent) or purchase the staging number.
  let number: TwilioNumber;
  let action: StagingPhoneResult["action"];
  let regulatoryBundleSid: string | null = null;
  let addressSid: string | null = null;
  let monthlyPriceUsd: number | null = null;
  let smsCapable = true;

  const owned = await twilioGet(
    sid,
    token,
    `/Accounts/${encodeURIComponent(sid)}/IncomingPhoneNumbers.json?FriendlyName=${encodeURIComponent(NUMBER_FRIENDLY_NAME)}&PageSize=5`,
  );
  const ownedList = (owned.incoming_phone_numbers as Json[] | undefined) ?? [];
  const existingOwned = ownedList.find((n) => n.friendly_name === NUMBER_FRIENDLY_NAME);

  if (existingOwned) {
    number = asNumber(existingOwned);
    action = alreadyAllocated ? "already-allocated" : "reused-existing";
    if (number.voice_url !== voiceUrl || number.voice_method !== "POST") {
      const updated = await twilioPostForm(
        sid,
        token,
        `/Accounts/${encodeURIComponent(sid)}/IncomingPhoneNumbers/${number.sid}.json`,
        { VoiceUrl: voiceUrl, VoiceMethod: "POST", FriendlyName: NUMBER_FRIENDLY_NAME },
      );
      number = asNumber(updated);
    }
  } else {
    // Prove compliance BEFORE spending: the pinned bundle is approved (AU/mobile/business), a
    // matching AU Address exists, and the price is within the cap. Any failure stops here.
    const expectedBundleSid =
      (env.TWILIO_STAGING_BUNDLE_SID ?? "").trim() || DEFAULT_STAGING_BUNDLE_SID;
    const bundle = await verifyApprovedBundle(sid, token, expectedBundleSid);
    regulatoryBundleSid = bundle.bundleSid;
    addressSid = await findApprovedAuAddress(sid, token);
    monthlyPriceUsd = await assertAffordableAuMobile(sid, token);

    // Voice REQUIRED; SMS preferred (fall back to Voice-only if no SMS-capable number exists).
    let availBody = await twilioGet(
      sid,
      token,
      `/Accounts/${encodeURIComponent(sid)}/AvailablePhoneNumbers/AU/Mobile.json?VoiceEnabled=true&SmsEnabled=true&PageSize=5`,
    );
    let candidates = (availBody.available_phone_numbers as Json[] | undefined) ?? [];
    if (candidates.length === 0) {
      availBody = await twilioGet(
        sid,
        token,
        `/Accounts/${encodeURIComponent(sid)}/AvailablePhoneNumbers/AU/Mobile.json?VoiceEnabled=true&PageSize=5`,
      );
      candidates = (availBody.available_phone_numbers as Json[] | undefined) ?? [];
      smsCapable = false;
    }
    const candidate = candidates[0];
    if (!candidate) throw new Error("No available AU mobile Voice number found to purchase");
    const caps = (candidate.capabilities as Record<string, unknown> | undefined) ?? {};
    smsCapable = smsCapable && caps.SMS !== false;
    try {
      // Associate the approved regulatory Bundle + Address with the new number (fixes 21631).
      const bought = await twilioPostForm(
        sid,
        token,
        `/Accounts/${encodeURIComponent(sid)}/IncomingPhoneNumbers.json`,
        {
          PhoneNumber: String(candidate.phone_number),
          FriendlyName: NUMBER_FRIENDLY_NAME,
          VoiceUrl: voiceUrl,
          VoiceMethod: "POST",
          BundleSid: regulatoryBundleSid,
          AddressSid: addressSid,
        },
      );
      number = asNumber(bought);
    } catch (e) {
      const te = e as TwilioError;
      if (te && te.twilioCode != null && ADDRESS_REGULATORY_CODES.has(te.twilioCode)) {
        const err = new Error(
          `ADDRESS_OR_REGULATORY_REQUIRED: Twilio requires an Address/Regulatory Bundle on the staging subaccount before purchasing an AU number (code ${te.twilioCode}). Provide the required AU address/compliance details in the Twilio Console for subaccount '${EXPECTED_TWILIO_ACCOUNT_NAME}', then re-run.`,
        ) as TwilioError;
        err.twilioCode = te.twilioCode;
        throw err;
      }
      throw e;
    }
    action = "purchased";
  }

  if (number.account_sid && number.account_sid !== sid) {
    throw new Error("Purchased/owned number is not in the authenticated staging subaccount");
  }

  // --- Allocate to the certification tenant (replicate reserve_my_platform_phone) ---
  await supabaseAdmin
    .from("businesses")
    .update({ public_phone: STAGING_PLACEHOLDER_FORWARDING } as unknown as Record<string, unknown>)
    .eq("id", CERTIFICATION_BUSINESS_ID);

  const { data: invExisting } = await supabaseAdmin
    .from("platform_phone_inventory")
    .select("id,status")
    .eq("provider_phone_id", number.sid)
    .maybeSingle();
  let inventoryId: string;
  const invExistingId = (invExisting as { id?: string } | null)?.id;
  if (invExistingId) {
    inventoryId = invExistingId;
  } else {
    const { data: invNew, error: invErr } = await supabaseAdmin
      .from("platform_phone_inventory")
      .insert({
        provider: "twilio",
        provider_phone_id: number.sid,
        phone_number: number.phone_number,
        voice_capable: true,
        sms_capable: smsCapable,
        status: "available",
      })
      .select("id")
      .single();
    if (invErr) throw new Error(`Inventory insert failed: ${invErr.message}`);
    inventoryId = String((invNew as { id: string }).id);
  }

  const nowIso = new Date().toISOString();
  const expIso = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const { error: reserveErr } = await supabaseAdmin
    .from("platform_phone_inventory")
    .update({
      status: "reserved",
      reserved_business_id: CERTIFICATION_BUSINESS_ID,
      reserved_at: nowIso,
      reservation_expires_at: expIso,
      assigned_business_id: null,
    })
    .eq("id", inventoryId);
  if (reserveErr) throw new Error(`Inventory reserve failed: ${reserveErr.message}`);

  const { error: telErr } = await supabaseAdmin
    .from("business_telephony_settings")
    .update({
      inventory_phone_id: inventoryId,
      inbound_number: number.phone_number,
      forwarding_number: STAGING_PLACEHOLDER_FORWARDING,
      customer_phone_e164: STAGING_PLACEHOLDER_FORWARDING,
      provider: "twilio",
      provider_phone_id: number.sid,
      live_status: "pending",
      forwarding_setup_status: "reserved",
    })
    .eq("business_id", CERTIFICATION_BUSINESS_ID);
  if (telErr) throw new Error(`Telephony update failed: ${telErr.message}`);

  const [{ data: invFinal }, { data: telFinal }] = await Promise.all([
    supabaseAdmin
      .from("platform_phone_inventory")
      .select("id,status,reserved_business_id,assigned_business_id")
      .eq("id", inventoryId)
      .maybeSingle(),
    supabaseAdmin
      .from("business_telephony_settings")
      .select(
        "inventory_phone_id,inbound_number,forwarding_setup_status,answering_mode,smart_answer_enabled,smart_answer_sip_phone_id",
      )
      .eq("business_id", CERTIFICATION_BUSINESS_ID)
      .maybeSingle(),
  ]);
  const inv = (invFinal ?? {}) as Record<string, unknown>;
  const tel = (telFinal ?? {}) as Record<string, unknown>;
  const tenantResolvesToCertBusiness =
    inv.reserved_business_id === CERTIFICATION_BUSINESS_ID &&
    tel.inventory_phone_id === inventoryId &&
    tel.inbound_number === number.phone_number;

  return {
    action,
    accountName,
    phoneNumber: number.phone_number,
    phoneSid: number.sid,
    friendlyName: number.friendly_name ?? NUMBER_FRIENDLY_NAME,
    voiceUrl: number.voice_url ?? voiceUrl,
    voiceMethod: number.voice_method ?? "POST",
    inventoryId,
    inventoryStatus: (inv.status as string) ?? null,
    reservedBusinessId: (inv.reserved_business_id as string) ?? null,
    telephonyInventoryPhoneId: (tel.inventory_phone_id as string) ?? null,
    telephonyInboundNumber: (tel.inbound_number as string) ?? null,
    forwardingSetupStatus: (tel.forwarding_setup_status as string) ?? null,
    answeringMode: (tel.answering_mode as string) ?? null,
    smartAnswerEnabled: tel.smart_answer_enabled === true,
    smartAnswerSipPhoneId: (tel.smart_answer_sip_phone_id as string) ?? null,
    tenantResolvesToCertBusiness,
    regulatoryBundleSid,
    addressSid,
    smsCapable,
    monthlyPriceUsd,
  };
}
