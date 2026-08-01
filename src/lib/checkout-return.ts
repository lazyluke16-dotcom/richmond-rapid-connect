export type CheckoutReturnSearch = {
  billing?: string;
  session_id?: string;
};

export function checkoutAcknowledgementKey(sessionId: string) {
  return `rapid-connect:checkout-ack:${sessionId}`;
}

export function isCheckoutSessionId(value: unknown): value is string {
  return typeof value === "string" && /^cs_(?:test|live)_[A-Za-z0-9_]+$/.test(value);
}

export function checkoutSessionFromSearch(search: CheckoutReturnSearch) {
  if (search.billing !== "success") return null;
  const sessionId = search.session_id;
  return isCheckoutSessionId(sessionId) ? sessionId : null;
}

export function checkoutSetupRoute(plan: string | null | undefined) {
  return plan === "ai_receptionist" ? "/ai-receptionist" : "/call-handling";
}
