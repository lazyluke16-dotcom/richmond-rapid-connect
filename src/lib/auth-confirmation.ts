const ALLOWED_EMAIL_OTP_TYPES = new Set([
  "email",
  "signup",
  "invite",
  "magiclink",
  "recovery",
  "email_change",
]);

export type ConfirmationParameters = {
  code: string | null;
  tokenHash: string | null;
  type: string | null;
  accessToken: string | null;
  refreshToken: string | null;
  errorCode: string | null;
  errorDescription: string | null;
};

export function safeConfirmationNext(value: string | null | undefined): string {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return "/plumbers?resume=payment";
  return value;
}

export function readConfirmationParameters(url: URL): ConfirmationParameters {
  const hash = new URLSearchParams(url.hash.replace(/^#/, ""));
  const query = url.searchParams;
  return {
    code: query.get("code"),
    tokenHash: query.get("token_hash"),
    type: query.get("type"),
    accessToken: hash.get("access_token"),
    refreshToken: hash.get("refresh_token"),
    errorCode: query.get("error_code") ?? hash.get("error_code") ?? query.get("error"),
    errorDescription:
      query.get("error_description") ?? hash.get("error_description") ?? hash.get("error"),
  };
}

export function safeEmailOtpType(value: string | null): string | null {
  return value && ALLOWED_EMAIL_OTP_TYPES.has(value) ? value : null;
}

export function confirmedAcquisitionDestination(next: string): string {
  const safeNext = safeConfirmationNext(next);
  const destination = new URL(safeNext, "https://rapid-connect.invalid");
  if (destination.pathname === "/plumbers") {
    destination.searchParams.set("resume", "payment");
    destination.searchParams.set("confirmation", "verified");
  }
  return `${destination.pathname}${destination.search}${destination.hash}`;
}

export function confirmationFailureMessage(code: string | null): string {
  if (code === "otp_expired" || code === "access_denied") {
    return "That confirmation link has expired or has already been used. Request a new email or sign in to continue.";
  }
  return "We couldn’t finish confirming this email. Try the link again or sign in to continue.";
}
