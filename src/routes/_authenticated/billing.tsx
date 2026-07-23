import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { CreditCard, ExternalLink, Loader2 } from "lucide-react";
import { AppShell } from "@/components/AppShell";
import { useMyTenantBrand } from "@/hooks/use-my-tenant-brand";
import { supabase } from "@/integrations/supabase/client";

type BillingSummary = {
  billing: {
    selectedPlan: "missed_call_recovery" | "ai_receptionist" | null;
    billingStatus: string;
    effectiveState: string;
    billingExempt: boolean;
    currentPeriodEnd: string | null;
    graceExpiresAt: string | null;
    hasStripeCustomer: boolean;
    hasStripeSubscription: boolean;
  };
  usage: {
    totalBillableSeconds: number;
    estimatedChargeAud: number;
    pendingMeterEvents: number;
    withinGraceCap: boolean;
  };
  platformFeeAud: number;
};

export const Route = createFileRoute("/_authenticated/billing")({
  head: () => ({ meta: [{ title: "Plan and billing — Rapid Connect" }] }),
  component: BillingPage,
});

async function authenticatedRequest(path: string, init?: RequestInit) {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("Your session has expired. Please sign in again.");
  const response = await fetch(path, {
    ...init,
    headers: { ...init?.headers, Authorization: `Bearer ${token}` },
  });
  const payload = (await response.json().catch(() => ({}))) as { error?: string; url?: string };
  if (!response.ok) throw new Error(payload.error ?? "Billing request failed");
  return payload;
}

function BillingPage() {
  const tenant = useMyTenantBrand();
  const [summary, setSummary] = useState<BillingSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"checkout" | "portal" | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const { data } = await supabase.auth.getSession();
        const token = data.session?.access_token;
        if (!token) throw new Error("Your session has expired. Please sign in again.");
        const response = await fetch("/api/public/billing/summary", {
          headers: { Authorization: `Bearer ${token}` },
        });
        const payload = (await response.json()) as BillingSummary & { error?: string };
        if (!response.ok) throw new Error(payload.error ?? "Could not load billing");
        setSummary(payload);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Could not load billing");
      }
    })();
  }, []);

  const openBilling = async (kind: "checkout" | "portal") => {
    setBusy(kind);
    setError(null);
    try {
      const payload = await authenticatedRequest(`/api/public/billing/${kind}`, { method: "POST" });
      if (!payload.url) throw new Error("Stripe did not return a secure billing link");
      window.location.assign(payload.url);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Billing request failed");
      setBusy(null);
    }
  };

  return (
    <AppShell showCallBar={false} tenant={tenant} hidePublicNav>
      <div className="mx-auto max-w-3xl px-4 py-8">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="text-xs uppercase tracking-widest text-primary">Account</div>
            <h1 className="text-3xl font-black">Plan and billing</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Manage your subscription and see current AI voice usage.
            </p>
          </div>
          <Link to="/dashboard" className="text-sm text-muted-foreground underline">
            ← Job Centre
          </Link>
        </div>

        {error && (
          <div className="mt-6 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
            {error}
          </div>
        )}
        {!summary && !error && (
          <div className="mt-8 flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading billing…
          </div>
        )}

        {summary && (
          <div className="mt-6 space-y-4">
            <section className="rounded-lg border border-border bg-card p-5">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <div className="text-xs uppercase tracking-widest text-muted-foreground">
                    Current plan
                  </div>
                  <div className="mt-1 text-xl font-black">
                    {summary.billing.selectedPlan === "ai_receptionist"
                      ? "AI Receptionist"
                      : summary.billing.selectedPlan === "missed_call_recovery"
                        ? "Missed-Call Recovery"
                        : "No plan selected"}
                  </div>
                  <div className="mt-2 text-sm">
                    Status:{" "}
                    <b className="capitalize">
                      {summary.billing.effectiveState.replaceAll("_", " ")}
                    </b>
                  </div>
                  {summary.billing.currentPeriodEnd && (
                    <div className="text-xs text-muted-foreground">
                      Current period ends{" "}
                      {new Date(summary.billing.currentPeriodEnd).toLocaleDateString()}
                    </div>
                  )}
                  {summary.billing.graceExpiresAt && (
                    <div className="mt-2 text-sm text-amber-500">
                      Payment grace ends{" "}
                      {new Date(summary.billing.graceExpiresAt).toLocaleDateString()}
                    </div>
                  )}
                </div>
                <div className="text-right">
                  <div className="text-2xl font-black">A${summary.platformFeeAud.toFixed(2)}</div>
                  <div className="text-xs text-muted-foreground">platform fee / month</div>
                </div>
              </div>

              <div className="mt-5">
                {summary.billing.hasStripeSubscription ? (
                  <button
                    onClick={() => void openBilling("portal")}
                    disabled={Boolean(busy)}
                    className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-black text-primary-foreground disabled:opacity-50"
                  >
                    <CreditCard className="h-4 w-4" />{" "}
                    {busy === "portal" ? "Opening…" : "Manage payment and subscription"}{" "}
                    <ExternalLink className="h-3.5 w-3.5" />
                  </button>
                ) : (
                  <button
                    onClick={() => void openBilling("checkout")}
                    disabled={Boolean(busy) || !summary.billing.selectedPlan}
                    className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-black text-primary-foreground disabled:opacity-50"
                  >
                    <CreditCard className="h-4 w-4" />{" "}
                    {busy === "checkout" ? "Opening…" : "Activate securely with Stripe"}
                  </button>
                )}
              </div>
            </section>

            <section className="grid gap-4 sm:grid-cols-3">
              <Metric
                label="AI voice usage"
                value={`${Math.ceil(summary.usage.totalBillableSeconds / 60)} min`}
              />
              <Metric
                label="Estimated usage"
                value={`A$${summary.usage.estimatedChargeAud.toFixed(2)}`}
              />
              <Metric
                label="Meter status"
                value={
                  summary.usage.pendingMeterEvents
                    ? `${summary.usage.pendingMeterEvents} pending`
                    : "Up to date"
                }
              />
            </section>

            <p className="text-xs text-muted-foreground">
              Subscription changes and cancellation are handled in Stripe’s secure customer portal.
              Access continues according to the displayed billing state and any stated grace period.
            </p>
          </div>
        )}
      </div>
    </AppShell>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="text-xs uppercase tracking-widest text-muted-foreground">{label}</div>
      <div className="mt-1 text-xl font-black">{value}</div>
    </div>
  );
}
