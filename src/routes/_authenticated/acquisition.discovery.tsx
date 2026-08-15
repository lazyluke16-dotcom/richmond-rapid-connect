/**
 * Internal operator view — /acquisition/discovery (authenticated + operator-gated).
 *
 * Lets an authorised operator create a bounded discovery mission from an operator-curated
 * list of businesses (the lawful 'import' source), start/pause/cancel it, advance it in
 * bounded steps, and inspect disposition counts + explainable per-candidate outcomes. No
 * outreach is sent. Live discovery providers are an external dependency.
 */
import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { Loader2, Radar } from "lucide-react";
import { AppShell } from "@/components/AppShell";
import { useMyTenantBrand } from "@/hooks/use-my-tenant-brand";
import { supabase } from "@/integrations/supabase/client";
import type { MissionDetail, MissionSummary } from "@/lib/discovery/mission-operator";

export const Route = createFileRoute("/_authenticated/acquisition/discovery")({
  head: () => ({ meta: [{ title: "Autonomous discovery — Rapid Connect" }] }),
  component: DiscoveryPage,
});

async function authedFetch(path: string, init?: RequestInit): Promise<Response> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("Your session has expired. Please sign in again.");
  return fetch(path, { ...init, headers: { ...init?.headers, Authorization: `Bearer ${token}` } });
}

/** Parse a "Name | website | locality" line list into import candidates. */
function parseImportLines(text: string) {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [businessName, website, locality] = line.split("|").map((p) => p.trim());
      return {
        businessName: businessName || null,
        website: website || null,
        locality: locality || null,
        vertical: "plumbing",
      };
    });
}

function DiscoveryPage() {
  const tenant = useMyTenantBrand();
  const [missions, setMissions] = useState<MissionSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [geography, setGeography] = useState("Richmond, VIC");
  const [target, setTarget] = useState(10);
  const [businesses, setBusinesses] = useState("");
  const [source, setSource] = useState<"import" | "google_places">("import");
  const [spendCeilingDollars, setSpendCeilingDollars] = useState(2);
  const [busy, setBusy] = useState(false);
  const [detail, setDetail] = useState<MissionDetail | null>(null);

  const loadMissions = useCallback(async () => {
    setError(null);
    try {
      const res = await authedFetch("/api/public/discovery/missions");
      const payload = (await res.json().catch(() => ({}))) as {
        missions?: MissionSummary[];
        error?: string;
      };
      if (!res.ok) throw new Error(payload.error ?? "Could not load missions");
      setMissions(payload.missions ?? []);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load missions");
    }
  }, []);

  useEffect(() => {
    void loadMissions();
  }, [loadMissions]);

  async function createMission(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const body =
        source === "google_places"
          ? {
              geography,
              targetCount: target,
              sources: ["google_places"],
              costCeilingCents: Math.max(1, Math.round(spendCeilingDollars * 100)),
            }
          : {
              geography,
              targetCount: target,
              sources: ["import"],
              importCandidates: parseImportLines(businesses),
            };
      const res = await authedFetch("/api/public/discovery/missions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(payload.error ?? "Mission creation failed");
      setBusinesses("");
      await loadMissions();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Mission creation failed");
    } finally {
      setBusy(false);
    }
  }

  async function control(missionId: string, action: string) {
    try {
      const res = await authedFetch("/api/public/discovery/control", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ missionId, action }),
      });
      const payload = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(payload.error ?? "Action failed");
      await loadMissions();
      if (detail?.id === missionId) await openDetail(missionId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Action failed");
    }
  }

  async function runToCompletion(missionId: string) {
    setBusy(true);
    try {
      for (let i = 0; i < 250; i++) {
        const res = await authedFetch("/api/public/discovery/advance", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ missionId, maxSteps: 10 }),
        });
        const payload = (await res.json().catch(() => ({}))) as { done?: boolean; error?: string };
        if (!res.ok) throw new Error(payload.error ?? "Advance failed");
        await loadMissions();
        if (detail?.id === missionId) await openDetail(missionId);
        if (payload.done) break;
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Advance failed");
    } finally {
      setBusy(false);
    }
  }

  async function openDetail(missionId: string) {
    try {
      const res = await authedFetch(
        `/api/public/discovery/detail?id=${encodeURIComponent(missionId)}`,
      );
      const payload = (await res.json().catch(() => ({}))) as {
        detail?: MissionDetail;
        error?: string;
      };
      if (!res.ok || !payload.detail) throw new Error(payload.error ?? "Could not load mission");
      setDetail(payload.detail);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load mission");
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
            <h1 className="text-3xl font-black">Autonomous discovery</h1>
            <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
              Create a bounded mission from a curated business list (import) or the live Google
              Places provider. The engine deduplicates, qualifies and builds private demos via the
              Slice-1 pipeline. No outreach is sent and no provider resources are provisioned.
            </p>
          </div>
          <Link to="/acquisition/prospects" className="text-sm text-muted-foreground underline">
            → Prospects
          </Link>
        </div>

        <form onSubmit={createMission} className="mt-6 rounded-lg border border-border bg-card p-5">
          <div className="mb-3 flex flex-wrap gap-4 text-sm">
            <label>
              Source
              <select
                value={source}
                onChange={(e) => setSource(e.target.value as "import" | "google_places")}
                className="mt-1 block rounded-md border border-border bg-input px-3 py-2 text-sm"
              >
                <option value="import">Import (curated list)</option>
                <option value="google_places">Google Places (live, metered)</option>
              </select>
            </label>
            {source === "google_places" && (
              <label>
                Spend ceiling (A$)
                <input
                  type="number"
                  min={0.5}
                  step={0.5}
                  value={spendCeilingDollars}
                  onChange={(e) => setSpendCeilingDollars(Number(e.target.value))}
                  className="mt-1 block w-32 rounded-md border border-border bg-input px-3 py-2 text-sm"
                />
              </label>
            )}
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <label className="text-sm">
              Geography
              <input
                value={geography}
                onChange={(e) => setGeography(e.target.value)}
                className="mt-1 w-full rounded-md border border-border bg-input px-3 py-2 text-sm"
              />
            </label>
            <label className="text-sm">
              Target count
              <input
                type="number"
                min={1}
                max={1000}
                value={target}
                onChange={(e) => setTarget(Number(e.target.value))}
                className="mt-1 w-full rounded-md border border-border bg-input px-3 py-2 text-sm"
              />
            </label>
            <div className="flex items-end">
              <button
                type="submit"
                disabled={busy}
                className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-bold text-primary-foreground disabled:opacity-60"
              >
                {busy ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Radar className="h-4 w-4" />
                )}{" "}
                Create mission
              </button>
            </div>
          </div>
          {source === "import" ? (
            <label className="mt-3 block text-sm">
              Businesses to process (one per line: <code>Name | https://website | Suburb</code>)
              <textarea
                value={businesses}
                onChange={(e) => setBusinesses(e.target.value)}
                rows={5}
                placeholder={"Example Plumbing | https://exampleplumbing.com.au | Richmond"}
                className="mt-1 w-full rounded-md border border-border bg-input px-3 py-2 font-mono text-xs"
              />
            </label>
          ) : (
            <p className="mt-3 text-xs text-muted-foreground">
              Google Places (live) discovers businesses in the geography, capped by your spend
              ceiling. Business listings via Google Maps Platform; durable demo facts still come
              from each business&apos;s own website. Requires a server-side key — creation fails
              closed if it is not configured.
            </p>
          )}
        </form>

        {error && (
          <div className="mt-6 rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
            {error}
          </div>
        )}

        {!missions && !error && (
          <div className="mt-8 flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading missions…
          </div>
        )}
        {missions && (
          <section className="mt-8 overflow-hidden rounded-lg border border-border bg-card">
            <div className="border-b border-border p-5">
              <h2 className="text-xl font-black">Missions ({missions.length})</h2>
            </div>
            {missions.length === 0 ? (
              <p className="p-5 text-sm text-muted-foreground">
                No missions yet — create one above.
              </p>
            ) : (
              <div className="divide-y divide-border">
                {missions.map((mission) => (
                  <div
                    key={mission.id}
                    className="flex flex-wrap items-center justify-between gap-3 p-4"
                  >
                    <button onClick={() => void openDetail(mission.id)} className="text-left">
                      <div className="font-bold">{mission.geography}</div>
                      <div className="text-xs text-muted-foreground">
                        {mission.sources.join("+")} · {mission.status} · target{" "}
                        {mission.targetCount} · discovered {mission.counts.discovered} · demo-ready{" "}
                        {mission.counts.demoReady} · dup {mission.counts.duplicate} · rejected{" "}
                        {mission.counts.rejected} · failed {mission.counts.failed}
                        {mission.costCents > 0
                          ? ` · est. A$${(mission.costCents / 100).toFixed(2)}`
                          : ""}
                      </div>
                    </button>
                    <div className="flex gap-2 text-xs">
                      <button
                        onClick={() => void control(mission.id, "start")}
                        className="rounded border border-border px-2 py-1"
                      >
                        Start
                      </button>
                      <button
                        onClick={() => void runToCompletion(mission.id)}
                        disabled={busy}
                        className="rounded border border-border px-2 py-1 disabled:opacity-50"
                      >
                        Run
                      </button>
                      <button
                        onClick={() => void control(mission.id, "pause")}
                        className="rounded border border-border px-2 py-1"
                      >
                        Pause
                      </button>
                      <button
                        onClick={() => void control(mission.id, "cancel")}
                        className="rounded border border-destructive/40 px-2 py-1 text-destructive"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        )}

        {detail && <MissionDetailPanel detail={detail} onClose={() => setDetail(null)} />}
      </div>
    </AppShell>
  );
}

function MissionDetailPanel({ detail, onClose }: { detail: MissionDetail; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/40" onClick={onClose}>
      <aside
        className="h-full w-full max-w-2xl overflow-y-auto bg-background p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between">
          <div>
            <h2 className="text-2xl font-black">{detail.geography}</h2>
            <p className="text-sm text-muted-foreground">
              {detail.status} · {detail.vertical} · target {detail.targetCount} / max{" "}
              {detail.maxCandidates}
            </p>
          </div>
          <button onClick={onClose} className="text-sm text-muted-foreground underline">
            Close
          </button>
        </div>

        <div className="mt-4 grid grid-cols-3 gap-2 text-center text-sm sm:grid-cols-6">
          {(
            [
              ["Discovered", detail.counts.discovered],
              ["Demo-ready", detail.counts.demoReady],
              ["Accepted", detail.counts.accepted],
              ["Duplicate", detail.counts.duplicate],
              ["Rejected", detail.counts.rejected],
              ["Failed", detail.counts.failed],
            ] as const
          ).map(([label, value]) => (
            <div key={label} className="rounded border border-border p-2">
              <div className="text-lg font-black">{value}</div>
              <div className="text-[10px] uppercase text-muted-foreground">{label}</div>
            </div>
          ))}
        </div>
        {detail.lastError && (
          <p className="mt-3 rounded border border-amber-500/40 bg-amber-500/10 p-2 text-xs text-amber-800">
            Last error: {detail.lastError}
          </p>
        )}

        <section className="mt-6">
          <h3 className="text-sm font-bold uppercase tracking-wide text-muted-foreground">
            Candidates ({detail.candidates.length})
          </h3>
          <div className="mt-2 overflow-x-auto">
            <table className="w-full min-w-[560px] text-left text-sm">
              <thead className="bg-muted/40 text-xs uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="px-3 py-2">Business</th>
                  <th className="px-3 py-2">Domain</th>
                  <th className="px-3 py-2">Disposition</th>
                  <th className="px-3 py-2">Reason</th>
                </tr>
              </thead>
              <tbody>
                {detail.candidates.map((candidate) => (
                  <tr key={candidate.id} className="border-t border-border">
                    <td className="px-3 py-2">{candidate.businessName ?? "—"}</td>
                    <td className="px-3 py-2 text-muted-foreground">
                      {candidate.canonicalDomain ?? "—"}
                    </td>
                    <td className="px-3 py-2">{candidate.disposition}</td>
                    <td className="px-3 py-2 text-muted-foreground">{candidate.reason ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </aside>
    </div>
  );
}
