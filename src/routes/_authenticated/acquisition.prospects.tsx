/**
 * Internal operator view — /acquisition/prospects (authenticated + operator-gated).
 *
 * Lets an authorised operator build a prospect demo from a website, inspect the roster
 * (score, band, status, demo readiness), and drill into a single prospect's evidence,
 * score reasons and demo metadata — with a private "view demo" link (shown once at build)
 * and a revoke action. No prospect contact values are shown in the aggregate table.
 */
import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Loader2, ShieldCheck } from "lucide-react";
import { AppShell } from "@/components/AppShell";
import { useMyTenantBrand } from "@/hooks/use-my-tenant-brand";
import { supabase } from "@/integrations/supabase/client";
import type { OperatorProspectDetail, OperatorProspectSummary } from "@/lib/prospect/operator";

export const Route = createFileRoute("/_authenticated/acquisition/prospects")({
  head: () => ({ meta: [{ title: "Prospect intelligence — Rapid Connect" }] }),
  component: ProspectsPage,
});

interface BuildResult {
  prospectId: string;
  canonicalDomain: string;
  created: boolean;
  businessName: string | null;
  score: number;
  band: string;
  demo: { slug: string; token: string; url: string; version: number; expiresAt: string | null };
  notes: string[];
}

async function authedFetch(path: string, init?: RequestInit): Promise<Response> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("Your session has expired. Please sign in again.");
  return fetch(path, { ...init, headers: { ...init?.headers, Authorization: `Bearer ${token}` } });
}

function ProspectsPage() {
  const tenant = useMyTenantBrand();
  const [prospects, setProspects] = useState<OperatorProspectSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [website, setWebsite] = useState("");
  const [building, setBuilding] = useState(false);
  const [buildResult, setBuildResult] = useState<BuildResult | null>(null);
  const [selected, setSelected] = useState<OperatorProspectDetail | null>(null);

  const loadList = useCallback(async () => {
    setError(null);
    try {
      const res = await authedFetch("/api/public/prospect/list");
      const payload = (await res.json().catch(() => ({}))) as {
        prospects?: OperatorProspectSummary[];
        error?: string;
      };
      if (!res.ok) throw new Error(payload.error ?? "Could not load prospects");
      setProspects(payload.prospects ?? []);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load prospects");
    }
  }, []);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  async function build(event: React.FormEvent) {
    event.preventDefault();
    if (!website.trim() || building) return;
    setBuilding(true);
    setError(null);
    setBuildResult(null);
    try {
      const res = await authedFetch("/api/public/prospect/build", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ website: website.trim() }),
      });
      const payload = (await res.json().catch(() => ({}))) as BuildResult & { error?: string };
      if (!res.ok) throw new Error(payload.error ?? "Demo build failed");
      setBuildResult(payload);
      setWebsite("");
      await loadList();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Demo build failed");
    } finally {
      setBuilding(false);
    }
  }

  async function openDetail(id: string) {
    setSelected(null);
    try {
      const res = await authedFetch(`/api/public/prospect/detail?id=${encodeURIComponent(id)}`);
      const payload = (await res.json().catch(() => ({}))) as {
        prospect?: OperatorProspectDetail;
        error?: string;
      };
      if (!res.ok || !payload.prospect) throw new Error(payload.error ?? "Could not load prospect");
      setSelected(payload.prospect);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load prospect");
    }
  }

  async function revoke(prospectId: string) {
    try {
      await authedFetch("/api/public/prospect/revoke", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prospectId }),
      });
      await Promise.all([loadList(), openDetail(prospectId)]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Revocation failed");
    }
  }

  return (
    <AppShell showCallBar={false} tenant={tenant} hidePublicNav>
      <div className="mx-auto max-w-6xl px-4 py-8">
        <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
          <div>
            <div className="text-xs uppercase tracking-widest text-primary">
              Internal operations
            </div>
            <h1 className="text-3xl font-black">Prospect intelligence</h1>
            <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
              Build a private, evidence-backed Rapid Connect demo from a plumbing business website.
              No outreach is sent and no provider resources are provisioned.
            </p>
          </div>
          <Link to="/dashboard" className="text-sm text-muted-foreground underline">
            ← Job Centre
          </Link>
        </div>

        {/* Build form */}
        <form onSubmit={build} className="mt-6 rounded-lg border border-border bg-card p-5">
          <label htmlFor="website" className="text-sm font-bold">
            Build a demo for a plumbing business website
          </label>
          <div className="mt-2 flex flex-col gap-2 sm:flex-row">
            <input
              id="website"
              value={website}
              onChange={(event) => setWebsite(event.target.value)}
              placeholder="https://exampleplumbing.com.au"
              className="flex-1 rounded-md border border-border bg-input px-3 py-2 text-sm"
            />
            <button
              type="submit"
              disabled={building}
              className="inline-flex items-center justify-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-bold text-primary-foreground disabled:opacity-60"
            >
              {building && <Loader2 className="h-4 w-4 animate-spin" />}
              {building ? "Researching…" : "Build demo"}
            </button>
          </div>
        </form>

        {error && (
          <div className="mt-6 rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
            {error}
          </div>
        )}

        {buildResult && (
          <div className="mt-6 rounded-lg border border-emerald-500/40 bg-emerald-500/10 p-5">
            <div className="flex items-center gap-2">
              <ShieldCheck className="h-5 w-5 text-emerald-600" />
              <h2 className="text-lg font-black">
                Demo ready for {buildResult.businessName ?? buildResult.canonicalDomain}
              </h2>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              Score {buildResult.score} ({buildResult.band}). This private link is shown once — copy
              it now.
            </p>
            <a
              href={buildResult.demo.url}
              target="_blank"
              rel="noreferrer"
              className="mt-2 block break-all text-sm font-mono text-primary underline"
            >
              {buildResult.demo.url}
            </a>
            {buildResult.notes.length > 0 && (
              <details className="mt-3 text-xs text-muted-foreground">
                <summary>Research notes ({buildResult.notes.length})</summary>
                <ul className="mt-1 list-disc pl-5">
                  {buildResult.notes.map((note, index) => (
                    <li key={index}>{note}</li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        )}

        {/* Roster */}
        {!prospects && !error && (
          <div className="mt-8 flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading prospects…
          </div>
        )}
        {prospects && (
          <section className="mt-8 overflow-hidden rounded-lg border border-border bg-card">
            <div className="border-b border-border p-5">
              <h2 className="text-xl font-black">Prospects ({prospects.length})</h2>
              <p className="text-sm text-muted-foreground">
                Sorted by score. Contact details are not shown here.
              </p>
            </div>
            {prospects.length === 0 ? (
              <p className="p-5 text-sm text-muted-foreground">
                No prospects yet — build one above.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[720px] text-left text-sm">
                  <thead className="bg-muted/40 text-xs uppercase tracking-wider text-muted-foreground">
                    <tr>
                      <th className="px-4 py-3">Business</th>
                      <th className="px-4 py-3">Domain</th>
                      <th className="px-4 py-3">Status</th>
                      <th className="px-4 py-3">Score</th>
                      <th className="px-4 py-3">Band</th>
                      <th className="px-4 py-3">Demo</th>
                    </tr>
                  </thead>
                  <tbody>
                    {prospects.map((prospect) => (
                      <tr
                        key={prospect.id}
                        onClick={() => void openDetail(prospect.id)}
                        className="cursor-pointer border-t border-border hover:bg-muted/30"
                      >
                        <td className="px-4 py-3 font-bold">{prospect.businessName ?? "—"}</td>
                        <td className="px-4 py-3 text-muted-foreground">
                          {prospect.canonicalDomain}
                        </td>
                        <td className="px-4 py-3">{prospect.status}</td>
                        <td className="px-4 py-3">{prospect.score ?? "—"}</td>
                        <td className="px-4 py-3">{prospect.scoreBand ?? "—"}</td>
                        <td className="px-4 py-3">{prospect.hasDemo ? "Ready" : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        )}

        {selected && (
          <ProspectDetailPanel
            detail={selected}
            onClose={() => setSelected(null)}
            onRevoke={revoke}
          />
        )}
      </div>
    </AppShell>
  );
}

function ProspectDetailPanel({
  detail,
  onClose,
  onRevoke,
}: {
  detail: OperatorProspectDetail;
  onClose: () => void;
  onRevoke: (prospectId: string) => void;
}) {
  const verified = detail.facts.filter((fact) => fact.status === "verified");
  const unknowns = detail.facts.filter((fact) => fact.status === "unknown");
  const conflicting = detail.facts.filter((fact) => fact.status === "conflicting");

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/40" onClick={onClose}>
      <aside
        className="h-full w-full max-w-xl overflow-y-auto bg-background p-6 shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between">
          <div>
            <h2 className="text-2xl font-black">{detail.businessName ?? detail.canonicalDomain}</h2>
            <p className="text-sm text-muted-foreground">{detail.website}</p>
          </div>
          <button onClick={onClose} className="text-sm text-muted-foreground underline">
            Close
          </button>
        </div>

        <div className="mt-4 flex flex-wrap gap-2 text-xs">
          <span className="rounded-full bg-muted px-3 py-1">Status: {detail.status}</span>
          <span className="rounded-full bg-muted px-3 py-1">
            Score: {detail.score ?? "—"} ({detail.scoreBand ?? "—"})
          </span>
          {detail.publicPhone && (
            <span className="rounded-full bg-muted px-3 py-1">
              Public phone: {detail.publicPhone}
            </span>
          )}
        </div>

        {/* Score reasons */}
        {detail.scoreDetail && (
          <section className="mt-6">
            <h3 className="text-sm font-bold uppercase tracking-wide text-muted-foreground">
              Score reasons
            </h3>
            <ul className="mt-2 space-y-1 text-sm">
              {detail.scoreDetail.factors.map((factor) => (
                <li
                  key={factor.key}
                  className="flex items-start justify-between gap-3 border-b border-border py-1"
                >
                  <span className={factor.awarded ? "text-foreground" : "text-muted-foreground"}>
                    {factor.label} — {factor.detail}
                  </span>
                  <span className={factor.points >= 0 ? "text-emerald-600" : "text-destructive"}>
                    {factor.points > 0 ? `+${factor.points}` : factor.points}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* Evidence */}
        <section className="mt-6">
          <h3 className="text-sm font-bold uppercase tracking-wide text-muted-foreground">
            Evidence ({verified.length} verified
            {conflicting.length ? `, ${conflicting.length} conflicting` : ""})
          </h3>
          <ul className="mt-2 space-y-2 text-sm">
            {verified.map((fact, index) => (
              <li key={index} className="rounded-md border border-border p-2">
                <div className="font-medium">
                  {fact.factType}: {fact.value}{" "}
                  <span className="text-xs text-muted-foreground">
                    ({Math.round(fact.confidence * 100)}%)
                  </span>
                </div>
                {fact.evidence && (
                  <a
                    href={fact.evidence.sourceUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="text-xs text-primary underline break-all"
                  >
                    {fact.evidence.sourceUrl}
                  </a>
                )}
              </li>
            ))}
            {conflicting.map((fact, index) => (
              <li
                key={`c-${index}`}
                className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-amber-800"
              >
                <AlertTriangle className="mr-1 inline h-3.5 w-3.5" />
                Conflicting {fact.factType}: {fact.value}
              </li>
            ))}
          </ul>
          {unknowns.length > 0 && (
            <p className="mt-2 text-xs text-muted-foreground">
              Unknown (not fabricated): {unknowns.map((fact) => fact.factType).join(", ")}
            </p>
          )}
        </section>

        {/* Demo metadata */}
        <section className="mt-6">
          <h3 className="text-sm font-bold uppercase tracking-wide text-muted-foreground">Demo</h3>
          {detail.demo ? (
            <div className="mt-2 text-sm">
              <p>
                Slug <code className="rounded bg-muted px-1">{detail.demo.slug}</code> · v
                {detail.demo.version} · {detail.demo.revokedAt ? "revoked" : "active"}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                The private link/token is shown only at build time. Rebuild from the form above to
                mint a fresh link.
              </p>
              {!detail.demo.revokedAt && (
                <button
                  onClick={() => onRevoke(detail.id)}
                  className="mt-2 rounded-md border border-destructive/40 px-3 py-1.5 text-sm text-destructive"
                >
                  Revoke demo
                </button>
              )}
            </div>
          ) : (
            <p className="mt-2 text-sm text-muted-foreground">No demo built yet.</p>
          )}
        </section>
      </aside>
    </div>
  );
}
