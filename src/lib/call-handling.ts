import { z } from "zod";

export const CALL_HANDLING_MODES = ["off", "text_link", "ai_receptionist"] as const;
export const CallHandlingModeSchema = z.enum(CALL_HANDLING_MODES);
export type CallHandlingMode = z.infer<typeof CallHandlingModeSchema>;

export interface ServiceEntitlements {
  textLink: boolean;
  aiReceptionist: boolean;
}

/**
 * Normalise an Australian business number to E.164.
 *
 * Supported customer numbers are Australian mobiles/geographic numbers,
 * 13 numbers, 1300 numbers and 1800 numbers. Extensions and international
 * numbers from other countries are rejected.
 */
export function normalizeAustralianPhone(input: string): string {
  const raw = String(input ?? "").trim();
  if (!raw) throw new Error("Australian phone number is required");
  if (/[a-z]/i.test(raw)) throw new Error("Enter a valid Australian phone number");

  let digits = raw.replace(/[^\d+]/g, "");
  if ((digits.match(/\+/g) ?? []).length > 1 || (digits.includes("+") && !digits.startsWith("+"))) {
    throw new Error("Enter a valid Australian phone number");
  }

  if (digits.startsWith("+")) digits = digits.slice(1);
  if (digits.startsWith("0011")) digits = digits.slice(4);
  if (digits.startsWith("61")) {
    digits = digits.slice(2);
    if (digits.startsWith("0")) digits = digits.slice(1);
  }

  const isStandard = /^[23478]\d{8}$/.test(digits);
  const isSixDigit13 = /^13\d{4}$/.test(digits);
  const isTenDigitService = /^(?:1300|1800)\d{6}$/.test(digits);

  if (digits.startsWith("0")) {
    const local = digits.slice(1);
    if (/^[23478]\d{8}$/.test(local)) return `+61${local}`;
  }
  if (isStandard || isSixDigit13 || isTenDigitService) return `+61${digits}`;

  throw new Error("Enter a valid Australian phone number");
}

export function entitlementsForPlan(
  selectedPlan: "missed_call_recovery" | "ai_receptionist" | null,
  access: { missedCall: boolean; aiReceptionist: boolean },
): ServiceEntitlements {
  return {
    textLink:
      access.missedCall &&
      (selectedPlan === "missed_call_recovery" || selectedPlan === "ai_receptionist"),
    aiReceptionist: access.aiReceptionist && selectedPlan === "ai_receptionist",
  };
}

export function assertModeEntitled(
  mode: CallHandlingMode,
  entitlements: ServiceEntitlements,
): void {
  if (mode === "text_link" && !entitlements.textLink) {
    throw new Error("Your current subscription does not include Text Link");
  }
  if (mode === "ai_receptionist" && !entitlements.aiReceptionist) {
    throw new Error("Your current subscription does not include AI Receptionist");
  }
}

export function legacyFlagsForMode(mode: CallHandlingMode): {
  textLinkEnabled: boolean;
  textLinkLive: boolean;
  aiEnabled: boolean;
  aiLive: boolean;
} {
  return {
    textLinkEnabled: mode === "text_link",
    textLinkLive: mode === "text_link",
    aiEnabled: mode === "ai_receptionist",
    aiLive: mode === "ai_receptionist",
  };
}

export function isLegacyModeConsistent(
  mode: CallHandlingMode,
  legacy: {
    textLinkEnabled: boolean;
    textLinkMode: "demo" | "live";
    recoverySmsEnabled: boolean;
    aiEnabled: boolean;
    aiMode: "demo" | "live";
  },
): boolean {
  if (mode === "off") return !legacy.textLinkEnabled && !legacy.aiEnabled;
  if (mode === "text_link") {
    return (
      legacy.textLinkEnabled &&
      legacy.textLinkMode === "live" &&
      legacy.recoverySmsEnabled &&
      !legacy.aiEnabled
    );
  }
  return legacy.aiEnabled && legacy.aiMode === "live" && !legacy.textLinkEnabled;
}

export type InboundWorkflow =
  { kind: "off" } | { kind: "text_link" } | { kind: "ai_receptionist"; assistantId: string };

export function selectInboundWorkflow(input: {
  mode: CallHandlingMode;
  textLinkEntitled: boolean;
  aiReceptionistEntitled: boolean;
  assistantId?: string | null;
}): InboundWorkflow {
  if (input.mode === "off") return { kind: "off" };
  if (input.mode === "text_link") {
    return input.textLinkEntitled ? { kind: "text_link" } : { kind: "off" };
  }
  if (!input.aiReceptionistEntitled || !input.assistantId) return { kind: "off" };
  return { kind: "ai_receptionist", assistantId: input.assistantId };
}

export function canCreateAiEndOfCallRecords(input: {
  mode: CallHandlingMode;
  aiReceptionistEntitled: boolean;
}): boolean {
  return input.mode === "ai_receptionist" && input.aiReceptionistEntitled;
}

export function assertTenantMatch(expectedBusinessId: string, actualBusinessId: string): void {
  if (!expectedBusinessId || expectedBusinessId !== actualBusinessId) {
    throw new Error("The resource does not belong to this business");
  }
}

export const SMS_NON_BILLABLE_REASON = "sms_retail_pricing_unapproved";

export function buildNonBillableSmsUsage(input: {
  businessId: string;
  provider: string;
  providerEventId: string | null;
  externalCallId: string;
  smsEventId: string;
}) {
  return {
    business_id: input.businessId,
    usage_type: "outbound_sms" as const,
    provider: input.provider,
    provider_event_id: input.providerEventId,
    external_call_id: input.externalCallId,
    quantity: 1,
    unit: "message",
    billable: false,
    non_billable_reason: SMS_NON_BILLABLE_REASON,
    customer_rate: null,
    estimated_customer_charge: null,
    stripe_meter_event_identifier: null,
    stripe_meter_event_status: "skipped" as const,
    metadata: { sms_event_id: input.smsEventId },
  };
}
