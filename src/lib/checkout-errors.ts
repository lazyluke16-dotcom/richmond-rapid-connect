export function checkoutFailureMessage(payload: {
  error?: string;
  code?: string;
  requestId?: string;
}): string {
  const reference = payload.requestId ? ` Reference: ${payload.requestId}.` : "";
  const byCode: Record<string, string> = {
    sign_in_required: "Your secure session is still being established. Sign in and try again.",
    business_setup_incomplete:
      "Your email is confirmed, but business setup is not ready yet. Try again in a moment.",
    pricing_selection_incomplete:
      "Your service price or offer still needs confirmation before Stripe can open.",
    offer_eligibility_verification_failed:
      "The founding offer could not be verified. No discounted checkout was created.",
    stripe_configuration_unavailable:
      "Secure payment setup is temporarily unavailable because its staging configuration could not be verified.",
    stripe_customer_unavailable:
      "Your secure Stripe customer record could not be prepared. No subscription was created.",
    stripe_request_rejected:
      "Stripe rejected the checkout setup. Your account is safe and no subscription was created.",
    stripe_temporarily_unavailable:
      "Stripe is temporarily unavailable. Your setup is saved; try again shortly.",
  };
  return `${
    (payload.code && byCode[payload.code]) ||
    payload.error ||
    "Secure payment setup could not open. Your setup is saved; sign in and try again."
  }${reference}`;
}
