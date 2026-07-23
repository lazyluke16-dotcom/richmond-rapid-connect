// Server-only Stripe SDK client. The .server.ts suffix excludes this from the
// browser bundle via vite-tanstack-config. Never import from client-side code.
import Stripe from 'stripe';

function createStripeClient(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    throw new Error('[stripe] STRIPE_SECRET_KEY is not configured — set it in Lovable Project Settings → Environment Variables');
  }
  if (key.startsWith('sk_live_')) {
    throw new Error('[stripe] Live-mode Stripe keys are not permitted in this build — use sk_test_ only');
  }
  return new Stripe(key);
}

let _stripe: Stripe | undefined;
export function getStripe(): Stripe {
  if (!_stripe) _stripe = createStripeClient();
  return _stripe;
}

export function stripeConfigured(): boolean {
  const key = process.env.STRIPE_SECRET_KEY ?? '';
  return key.startsWith('sk_test_');
}

// Returns all required Stripe price IDs from environment variables.
// Throws with a clear message listing ALL missing variables if any are absent.
// No hardcoded fallbacks — fail closed protects against cross-environment accidents
// (e.g. test IDs silently active in production, or vice versa).
export function getStripePrices(): { MCR_BASE: string; AIR_BASE: string; AIR_USAGE: string } {
  const missing: string[] = [];
  const require = (name: string): string => {
    const val = process.env[name];
    if (!val) missing.push(name);
    return val ?? '';
  };

  const prices = {
    MCR_BASE: require('STRIPE_PRICE_MCR_BASE'),
    AIR_BASE: require('STRIPE_PRICE_AIR_BASE'),
    AIR_USAGE: require('STRIPE_PRICE_AIR_USAGE'),
  };

  if (missing.length > 0) {
    throw new Error(
      `[stripe] Missing required Stripe price configuration: ${missing.join(', ')} — set these in Lovable Project Settings → Environment Variables`,
    );
  }

  return prices;
}

// Returns the union offer coupon ID from env, or null if not configured.
// The actual Stripe coupon must be pre-configured with:
//   - percent_off: 100, duration: 'once'
//   - applies_to: { products: [MCR_PRODUCT_ID, AIR_BASE_PRODUCT_ID] }
// Do not create or modify the Stripe coupon without WRITE MODE approval.
export function getUnionCouponId(): string | null {
  return process.env.STRIPE_COUPON_UNION_FIRST_PLATFORM_FEE ?? null;
}

export const STRIPE_METER_EVENT_NAME = 'ai_voice_seconds';

// Base price amounts in AUD cents — must match Stripe config exactly.
export const PLAN_BASE_PRICE_CENTS: Record<'missed_call_recovery' | 'ai_receptionist', number> = {
  missed_call_recovery: 900,  // A$9/month
  ai_receptionist: 1500,       // A$15/month
};

export type StripePlan = 'missed_call_recovery' | 'ai_receptionist';

// Server selects line items — client never provides price IDs.
// Throws if required Stripe price env vars are not configured.
export function getCheckoutLineItems(plan: StripePlan): Stripe.Checkout.SessionCreateParams.LineItem[] {
  const prices = getStripePrices();
  if (plan === 'missed_call_recovery') {
    return [{ price: prices.MCR_BASE, quantity: 1 }];
  }
  return [
    { price: prices.AIR_BASE, quantity: 1 },
    { price: prices.AIR_USAGE }, // metered — no quantity
  ];
}
