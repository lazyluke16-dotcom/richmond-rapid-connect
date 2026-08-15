/**
 * SharedDemoRuntime — one sandbox runtime that serves every prospect demo.
 *
 * Instead of provisioning a dedicated Twilio number / Vapi assistant / Stripe customer per
 * prospect (explicitly forbidden in V1), a single deterministic runtime loads a
 * prospect's stored {@link DemoConfig} by id and produces safe receptionist responses.
 * It creates NO provider resources and makes NO outbound provider calls.
 *
 * The text runtime is fully implemented and deterministic. A hosted VOICE demo is
 * deliberately deferred: {@link describeVoiceStub} documents the safe abstraction and
 * what a later provider-enabled slice must add, without faking production readiness.
 */
import type { DemoConfig } from "./types";
import type { DemoRecord, ProspectStore } from "./store";

export type DemoIntent =
  | "greeting"
  | "service_query"
  | "area_query"
  | "hours_query"
  | "emergency_query"
  | "price_query"
  | "booking"
  | "general";

export interface RuntimeTurn {
  intent: DemoIntent;
  reply: string;
  /** True when the reply deliberately withholds an unknown fact rather than inventing it. */
  deferredUnknown: boolean;
}

const PRICE_RE = /\b(price|cost|quote|how much|charge|fee|rate|expensive)\b/i;
const HOURS_RE = /\b(hours?|open|opening|closing|when.*(open|available)|what time)\b/i;
const EMERGENCY_RE = /\b(emergency|urgent|after hours|right now|asap|24)\b/i;
const AREA_RE = /\b(area|suburb|come to|service.*(area)|do you (cover|service)|located|where)\b/i;
const BOOKING_RE = /\b(book|appointment|schedule|callback|call me|send someone|come out)\b/i;

/** Classify a visitor message into a demo intent (deterministic keyword routing). */
export function classifyIntent(message: string): DemoIntent {
  const text = (message ?? "").trim();
  if (!text) return "greeting";
  if (EMERGENCY_RE.test(text)) return "emergency_query";
  if (PRICE_RE.test(text)) return "price_query";
  if (HOURS_RE.test(text)) return "hours_query";
  if (AREA_RE.test(text)) return "area_query";
  if (BOOKING_RE.test(text)) return "booking";
  if (/\b(fix|repair|install|leak|drain|water|pipe|gas|toilet|tap|blocked|hot)\b/i.test(text))
    return "service_query";
  return "general";
}

/**
 * Produce a safe receptionist reply. Emits only verified facts from the config; for any
 * unknown material fact it defers to a callback rather than inventing an answer. It never
 * quotes a price, guarantee, or availability that is not in the verified config.
 */
export function respond(config: DemoConfig, message: string): RuntimeTurn {
  const intent = classifyIntent(message);
  const name = config.businessName;

  switch (intent) {
    case "greeting":
      return { intent, reply: config.greeting, deferredUnknown: false };

    case "service_query": {
      if (config.verifiedServices.length > 0) {
        const list = config.verifiedServices.slice(0, 6).join(", ");
        return {
          intent,
          reply: `Yes — ${name} handles jobs like ${list}. Tell me what's happening and I'll take your details for a callback.`,
          deferredUnknown: false,
        };
      }
      return {
        intent,
        reply: `I can take the details of what you need and have the ${name} team confirm they can help and call you back.`,
        deferredUnknown: true,
      };
    }

    case "area_query": {
      if (config.verifiedServiceAreas.length > 0) {
        const list = config.verifiedServiceAreas.slice(0, 8).join(", ");
        return {
          intent,
          reply: `${name} services ${list}. What's your suburb and I'll pass it on?`,
          deferredUnknown: false,
        };
      }
      return {
        intent,
        reply: `Let me take your suburb and the team will confirm whether they can get to you.`,
        deferredUnknown: true,
      };
    }

    case "hours_query": {
      if (config.openingHours !== "UNKNOWN") {
        return {
          intent,
          reply: `Our published hours are: ${config.openingHours}. Would you like a callback?`,
          deferredUnknown: false,
        };
      }
      return {
        intent,
        reply: `I don't have the exact opening hours in front of me, but I can take your details and have the team get back to you.`,
        deferredUnknown: true,
      };
    }

    case "emergency_query": {
      if (config.emergencyService === "yes") {
        return {
          intent,
          reply: `${name} does handle emergency work. Let me take your name, number and what's happening so we can prioritise a callback.`,
          deferredUnknown: false,
        };
      }
      return {
        intent,
        reply: `Let me take your details and flag this as urgent so the team can call you back as soon as possible.`,
        deferredUnknown: config.emergencyService === "UNKNOWN",
      };
    }

    case "price_query":
      // Never fabricate pricing. Always defer to the business.
      return {
        intent,
        reply: `I can't quote a price on this demo line, but I can take your details and have ${name} give you an accurate quote.`,
        deferredUnknown: true,
      };

    case "booking":
      return {
        intent,
        reply: `Absolutely — can I grab your name, best contact number and a quick description of the job? I'll arrange a callback from ${name}.`,
        deferredUnknown: false,
      };

    default:
      return {
        intent,
        reply: `Thanks — I'm the ${name} AI receptionist. Tell me what you need and I'll take your details for a callback.`,
        deferredUnknown: false,
      };
  }
}

export class SharedDemoRuntime {
  constructor(private readonly store: ProspectStore) {}

  /** Load the active (latest, non-revoked) demo config for a prospect. */
  async loadConfig(prospectId: string): Promise<DemoConfig | null> {
    const demo = await this.store.latestDemo(prospectId);
    if (!demo || demo.revokedAt) return null;
    return demo.config;
  }

  /** Deterministic single-turn text response for a loaded demo. */
  answer(demo: DemoRecord, message: string): RuntimeTurn {
    return respond(demo.config, message);
  }
}

/**
 * Documented safe abstraction for a future hosted-voice demo. Returned to operators so
 * the deferred work is explicit; this slice ships the text runtime only and does not
 * provision or call any voice provider.
 */
export function describeVoiceStub(): { supported: false; deferredTo: string; requires: string[] } {
  return {
    supported: false,
    deferredTo: "Slice 5 — Demo-to-customer conversion / provisioning",
    requires: [
      "A single shared demo Vapi assistant (not one per prospect) that loads prospect config at call time.",
      "A shared demo phone number pool, or WebRTC browser voice, with strict rate limits.",
      "No dedicated per-prospect provider resources and no charges.",
    ],
  };
}
