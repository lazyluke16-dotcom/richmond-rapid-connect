export interface StripeCheckoutResourceReport {
  mode: "test";
  accountId: string;
  priceCount: number;
  couponScopedToBaseProducts: true;
}

export function validateStripeCheckoutResources(input: {
  account: { id: string };
  prices: Record<string, any>;
  coupon: any;
}): StripeCheckoutResourceReport;

export function verifyStripeCheckoutConfig(
  env?: NodeJS.ProcessEnv,
): Promise<StripeCheckoutResourceReport>;
