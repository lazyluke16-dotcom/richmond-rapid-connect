import { createFileRoute, redirect } from "@tanstack/react-router";
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";

type OAuthClient = { name?: string | null; client_id?: string } | null;
type AuthorizationDetails = {
  client?: OAuthClient;
  redirect_url?: string | null;
  redirect_to?: string | null;
} | null;

type SupabaseOAuth = {
  getAuthorizationDetails: (id: string) => Promise<{ data: AuthorizationDetails; error: { message: string } | null }>;
  approveAuthorization: (id: string) => Promise<{ data: AuthorizationDetails; error: { message: string } | null }>;
  denyAuthorization: (id: string) => Promise<{ data: AuthorizationDetails; error: { message: string } | null }>;
};

function oauth(): SupabaseOAuth {
  return (supabase.auth as unknown as { oauth: SupabaseOAuth }).oauth;
}

export const Route = createFileRoute("/.lovable/oauth/consent")({
  ssr: false,
  validateSearch: (s: Record<string, unknown>) => ({
    authorization_id: typeof s.authorization_id === "string" ? s.authorization_id : "",
  }),
  beforeLoad: async ({ search, location }) => {
    if (!search.authorization_id) throw new Error("Missing authorization_id");
    const { data } = await supabase.auth.getSession();
    const next = location.pathname + location.searchStr;
    if (!data.session) throw redirect({ to: "/auth", search: { next } as never });
  },
  loader: async ({ location }) => {
    const authorizationId = new URLSearchParams(location.search).get("authorization_id")!;
    const { data, error } = await oauth().getAuthorizationDetails(authorizationId);
    if (error) throw error;
    const immediate = data?.redirect_url ?? data?.redirect_to;
    if (immediate && !data?.client) throw redirect({ href: immediate });
    return data;
  },
  component: Consent,
  errorComponent: ({ error }) => (
    <main className="mx-auto max-w-md p-8">
      Could not load this authorization request: {String((error as Error)?.message ?? error)}
    </main>
  ),
});

function Consent() {
  const details = Route.useLoaderData();
  const { authorization_id } = Route.useSearch();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function decide(approve: boolean) {
    setBusy(true);
    setError(null);
    const { data, error } = approve
      ? await oauth().approveAuthorization(authorization_id)
      : await oauth().denyAuthorization(authorization_id);
    if (error) { setBusy(false); setError(error.message); return; }
    const target = data?.redirect_url ?? data?.redirect_to;
    if (!target) { setBusy(false); setError("No redirect returned by the authorization server."); return; }
    window.location.href = target;
  }

  const clientName = details?.client?.name ?? "an app";

  return (
    <main className="mx-auto max-w-md px-4 py-16">
      <div className="rounded-lg border border-border bg-card p-6">
        <h1 className="text-2xl font-black">Connect {clientName} to your account</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          This lets {clientName} act as you in Your AI Trade Assistant — read your businesses, leads, and missed calls. Tenant isolation still applies; the client can only see data you can see.
        </p>
        {error && (
          <div className="mt-4 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-sm text-destructive" role="alert">
            {error}
          </div>
        )}
        <div className="mt-6 flex gap-2">
          <button
            disabled={busy}
            onClick={() => { void decide(true); }}
            className="flex-1 rounded-md bg-primary px-5 py-3 text-base font-black text-primary-foreground disabled:opacity-40"
          >
            {busy ? "Working…" : "Approve"}
          </button>
          <button
            disabled={busy}
            onClick={() => { void decide(false); }}
            className="flex-1 rounded-md border border-border bg-card px-5 py-3 text-base font-black disabled:opacity-40"
          >
            Deny
          </button>
        </div>
      </div>
    </main>
  );
}