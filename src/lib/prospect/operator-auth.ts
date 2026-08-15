/**
 * Server-side operator authorisation helper for the prospect API routes.
 *
 * Mirrors the outreach-report gate: require a bearer token, resolve it to a Supabase
 * user via the service-role client, then confirm the user is on the acquisition operator
 * allow-list. Returns the authorised user id or an opaque {@link OperatorAuthError}.
 */
import { isAcquisitionOperator } from "./operator";

export class OperatorAuthError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "OperatorAuthError";
    this.status = status;
  }
}

/** Extract a bearer token from an Authorization header. */
export function bearer(request: Request): string | null {
  const header = request.headers.get("authorization") ?? request.headers.get("Authorization");
  if (!header?.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length).trim();
  return token || null;
}

/**
 * Authorise an operator request. Throws {@link OperatorAuthError} (401/403) on failure.
 * `authClient` must expose `auth.getUser(token)` (the service-role Supabase client does).
 */
export async function authorizeOperator(
  request: Request,
  authClient: {
    auth: {
      getUser: (
        token: string,
      ) => Promise<{ data: { user: { id: string } | null }; error: unknown }>;
    };
  },
  env: { acquisition?: string; outreach?: string },
): Promise<string> {
  const token = bearer(request);
  if (!token) throw new OperatorAuthError(401, "Unauthorized");
  const { data, error } = await authClient.auth.getUser(token);
  if (error || !data.user) throw new OperatorAuthError(401, "Unauthorized");
  if (!isAcquisitionOperator(data.user.id, env)) throw new OperatorAuthError(403, "Forbidden");
  return data.user.id;
}
