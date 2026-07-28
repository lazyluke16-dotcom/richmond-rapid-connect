import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2, ShieldCheck } from "lucide-react";
import { AppShell } from "@/components/AppShell";
import { useMyTenantBrand } from "@/hooks/use-my-tenant-brand";
import { supabase } from "@/integrations/supabase/client";
import type { OutreachReport } from "@/lib/outreach-report";

export const Route = createFileRoute("/_authenticated/outreach-operations")({
  head: () => ({ meta: [{ title: "Acquisition operations — Rapid Connect" }] }),
  component: OutreachOperationsPage,
});

async function loadReport(days: number): Promise<OutreachReport> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("Your session has expired. Please sign in again.");
  const response = await fetch(`/api/public/outreach/report?days=${days}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const payload = (await response.json().catch(() => ({}))) as OutreachReport & { error?: string };
  if (!response.ok) throw new Error(payload.error ?? "Could not load acquisition operations");
  return payload;
}

function OutreachOperationsPage() {
  const tenant = useMyTenantBrand();
  const [days, setDays] = useState(30);
  const [report, setReport] = useState<OutreachReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setReport(null);
    setError(null);
    void loadReport(days)
      .then(setReport)
      .catch((cause) =>
        setError(cause instanceof Error ? cause.message : "Could not load acquisition operations"),
      );
  }, [days]);

  return (
    <AppShell showCallBar={false} tenant={tenant} hidePublicNav>
      <div className="mx-auto max-w-6xl px-4 py-8">
        <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
          <div>
            <div className="text-xs uppercase tracking-widest text-primary">
              Internal operations
            </div>
            <h1 className="text-3xl font-black">Acquisition readiness</h1>
            <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
              Aggregate conversion, consent and suppression evidence. Raw contact details are never
              returned to this page.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <select
              aria-label="Report window"
              value={days}
              onChange={(event) => setDays(Number(event.target.value))}
              className="rounded-md border border-border bg-input px-3 py-2 text-sm"
            >
              <option value={7}>Last 7 days</option>
              <option value={30}>Last 30 days</option>
              <option value={90}>Last 90 days</option>
            </select>
            <Link to="/dashboard" className="text-sm text-muted-foreground underline">
              ← Job Centre
            </Link>
          </div>
        </div>

        {!report && !error && (
          <div className="mt-8 flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading aggregate evidence…
          </div>
        )}
        {error && (
          <div className="mt-6 rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
            {error}
          </div>
        )}

        {report && (
          <div className="mt-6 space-y-6">
            <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {report.funnel.map((step) => (
                <div key={step.key} className="rounded-lg border border-border bg-card p-4">
                  <div className="text-xs uppercase tracking-widest text-muted-foreground">
                    {step.label}
                  </div>
                  <div className="mt-1 text-3xl font-black">{step.value}</div>
                  <div className="text-xs text-muted-foreground">
                    {step.fromLandingPct == null
                      ? "No landing baseline"
                      : `${step.fromLandingPct}% of landing sessions`}
                  </div>
                </div>
              ))}
            </section>

            <section className="rounded-lg border border-border bg-card p-5">
              <div className="flex items-center gap-2">
                <ShieldCheck className="h-5 w-5 text-primary" />
                <h2 className="text-xl font-black">Campaign send readiness</h2>
              </div>
              <div className="mt-4 space-y-3">
                {report.outreach.campaigns.length === 0 && (
                  <p className="text-sm text-muted-foreground">
                    No outreach campaign has been created. This report performs no sends.
                  </p>
                )}
                {report.outreach.campaigns.map((campaign) => (
                  <article key={campaign.code} className="rounded-md border border-border p-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <div className="font-black">{campaign.name}</div>
                        <div className="text-xs text-muted-foreground">
                          {campaign.code} · {campaign.status} · {campaign.recipients} recipients
                        </div>
                      </div>
                      <div
                        className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-bold ${
                          campaign.readyForControlledSend
                            ? "bg-emerald-500/15 text-emerald-600"
                            : "bg-amber-500/15 text-amber-600"
                        }`}
                      >
                        {campaign.readyForControlledSend ? (
                          <CheckCircle2 className="h-3.5 w-3.5" />
                        ) : (
                          <AlertTriangle className="h-3.5 w-3.5" />
                        )}
                        {campaign.readyForControlledSend ? "Preflight ready" : "Blocked"}
                      </div>
                    </div>
                    {campaign.blockers.length > 0 && (
                      <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-muted-foreground">
                        {campaign.blockers.map((blocker) => (
                          <li key={blocker}>{blocker}</li>
                        ))}
                      </ul>
                    )}
                  </article>
                ))}
              </div>
            </section>

            <section className="overflow-hidden rounded-lg border border-border bg-card">
              <div className="border-b border-border p-5">
                <h2 className="text-xl font-black">Campaign attribution</h2>
                <p className="text-sm text-muted-foreground">
                  Unique sessions and resulting customer milestones by campaign tag.
                </p>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[720px] text-left text-sm">
                  <thead className="bg-muted/40 text-xs uppercase tracking-wider text-muted-foreground">
                    <tr>
                      <th className="px-4 py-3">Campaign</th>
                      <th className="px-4 py-3">Visits</th>
                      <th className="px-4 py-3">Demo complete</th>
                      <th className="px-4 py-3">Signup sent</th>
                      <th className="px-4 py-3">Accounts</th>
                      <th className="px-4 py-3">Waivers</th>
                      <th className="px-4 py-3">Activated</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.campaignAttribution.map((row) => (
                      <tr key={row.campaign} className="border-t border-border">
                        <td className="px-4 py-3 font-bold">{row.campaign}</td>
                        <td className="px-4 py-3">{row.landingViews}</td>
                        <td className="px-4 py-3">{row.demoCompletions}</td>
                        <td className="px-4 py-3">{row.signupSubmissions}</td>
                        <td className="px-4 py-3">{row.accountsCreated}</td>
                        <td className="px-4 py-3">{row.redemptions}</td>
                        <td className="px-4 py-3">{row.activated}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            <div className="rounded-lg border border-border bg-card p-4 text-sm text-muted-foreground">
              <b className="text-foreground">{report.outreach.totalSuppressions}</b> suppressions
              recorded in this window · A$
              {(report.outreach.setupFeesWaivedCents / 100).toLocaleString("en-AU")} in setup fees
              waived. Generated {new Date(report.generatedAt).toLocaleString("en-AU")}. Aggregate
              only; no raw contacts or endpoint hashes returned.
            </div>
          </div>
        )}
      </div>
    </AppShell>
  );
}
