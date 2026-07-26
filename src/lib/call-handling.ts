import { z } from "zod";

export const CALL_HANDLING_MODES = ["off", "text_link", "ai_receptionist"] as const;
export const CallHandlingModeSchema = z.enum(CALL_HANDLING_MODES);
export type CallHandlingMode = z.infer<typeof CallHandlingModeSchema>;

export interface ServiceEntitlements {
  textLink: boolean;
  aiReceptionist: boolean;
}

export const TEXT_LINK_SMS_UNIT_PRICE_MINOR = 25;
export const TEXT_LINK_SMS_CURRENCY = "AUD";
export const DEFAULT_TEXT_LINK_SMS_TEMPLATE =
  "{{business_name}} missed your call. Tell us what you need: {{recovery_link}}";

const GSM_7_BASIC =
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
const GSM_7_EXTENDED = "^{}\\[~]|€";

export interface SmsEncodingAnalysis {
  encoding: "gsm-7" | "ucs-2";
  units: number;
  segments: number;
  singleSegmentLimit: number;
}

/**
 * Deterministically measure the encoded SMS payload.
 *
 * GSM-7 extension-table characters consume two septets. Messages containing
 * any other character use UCS-2 limits. The dispatcher rejects a new Text
 * Link send that would exceed one segment instead of silently truncating
 * required customer information.
 */
export function analyzeSmsEncoding(message: string): SmsEncodingAnalysis {
  let gsmUnits = 0;
  let isGsm7 = true;

  for (const character of message) {
    if (GSM_7_BASIC.includes(character)) {
      gsmUnits += 1;
    } else if (GSM_7_EXTENDED.includes(character)) {
      gsmUnits += 2;
    } else {
      isGsm7 = false;
      break;
    }
  }

  if (isGsm7) {
    return {
      encoding: "gsm-7",
      units: gsmUnits,
      segments: gsmUnits <= 160 ? 1 : Math.ceil(gsmUnits / 153),
      singleSegmentLimit: 160,
    };
  }

  const units = message.length;
  return {
    encoding: "ucs-2",
    units,
    segments: units <= 70 ? 1 : Math.ceil(units / 67),
    singleSegmentLimit: 70,
  };
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
