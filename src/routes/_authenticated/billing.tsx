import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
  Bot,
  Building2,
  CheckCircle2,
  CircleDollarSign,
  CreditCard,
  ExternalLink,
  FileText,
  KeyRound,
  Loader2,
  Phone,
  ReceiptText,
  Settings,
  ShieldCheck,
} from "lucide-react";
import { AppShell } from "@/components/AppShell";
import { useMyTenantBrand } from "@/hooks/use-my-tenant-brand";
import { supabase } from "@/integrations/supabase/client";
import { TEXT_LINK_SMS_UNIT_PRICE_MINOR } from "@/lib/call-handling";

type BillingSummary = {
  account: {
    businessName: string;
    publicEmail: string | null;
    publicPhone: string | null;
  };
  billing: {
    selectedPlan: "missed_call_recovery" | "ai_receptionist" | "both" | null;
    billingStatus: string;
    effectiveState: string;
    billingExempt: boolean;
    currentPeriodEnd: string | null;
    graceExpiresAt: string | null;
    hasStripeCustomer: boolean;
    hasStripeSubscription: boolean;
    foundingPlumberBenefit: string | null;
    normalBillingStartsAt: string | null;
  };
  usage: {
    periodStart: string | null;
    totalBillableSeconds: number;
    estimatedChargeAud: number;
    smsMessages: number;
    smsBillable: true;
    pendingMeterEvents: number;
    withinGraceCap: boolean;
  };
  platformFeeAud: number;
  estimatedCurrentTotalAud: number;
  connections: {
    stripe: boolean;
    phoneNumber: string | null;
    phoneStatus: string;
    aiReceptionist: boolean;
    sms: boolean;
    missedCallRecoveryEnabled: boolean;
    aiReceptionistEnabled: boolean;
  };
};

export const Route = createFileRoute("/_authenticated/billing")({
  head: () => ({ meta: [{ title: "Plan and billing — Rapid Connect" }] }),
  component: BillingAccountPage,
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

export function BillingAccountPage({ initialSection }: { initialSection?: "usage" } = {}) {
  const tenant = useMyTenantBrand();
  const [summary, setSummary] = useState<BillingSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"checkout" | "portal" | null>(null);
  const [selectedPlan, setSelectedPlan] = useState<
    "missed_call_recovery" | "ai_receptionist" | "both"
  >("missed_call_recovery");
  const [planBusy, setPlanBusy] = useState(false);
  const [securityMessage, setSecurityMessage] = useState<string | null>(null);

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

  useEffect(() => {
    if (summary && initialSection === "usage") {
      document.getElementById("usage")?.scrollIntoView({ block: "start" });
    }
  }, [initialSection, summary]);

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

  const choosePlanAndCheckout = async () => {
    setPlanBusy(true);
    setError(null);
    try {
      await authenticatedRequest("/api/public/billing/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan: selectedPlan }),
      });
      await openBilling("checkout");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save your plan");
      setPlanBusy(false);
    }
  };

  const sendPasswordReset = async () => {
    setSecurityMessage(null);
    const { data } = await supabase.auth.getUser();
    if (!data.user?.email) {
      setSecurityMessage("No sign-in email was found.");
      return;
    }
    const { error: resetError } = await supabase.auth.resetPasswordForEmail(data.user.email, {
      redirectTo: `${window.location.origin}/reset-password`,
    });
    setSecurityMessage(
      resetError ? resetError.message : `Password reset sent to ${data.user.email}.`,
    );
  };

  return (
    <AppShell showCallBar={false} tenant={tenant} hidePublicNav>
      <div className="mx-auto max-w-6xl px-4 py-8">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="text-xs uppercase tracking-widest text-primary">
              Customer control centre
            </div>
            <h1 className="text-3xl font-black">Account &amp; billing</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Your profile, subscription, usage, payments and connected services.
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
          <div className="mt-6 space-y-6">
            <nav className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5" aria-label="Account sections">
              {(
                [
                  ["Subscription", CircleDollarSign, "#subscription"],
                  ["Usage & costs", ReceiptText, "#usage"],
                  ["Payments", CreditCard, "#payments"],
                  ["Profile", Building2, "#profile"],
                  ["Connections", Settings, "#connections"],
                ] as const
              ).map(([label, Icon, href]) => (
                <a
                  key={String(label)}
                  href={String(href)}
                  className="inline-flex items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-sm font-bold hover:border-primary"
                >
                  <Icon className="h-4 w-4 text-primary" /> {label}
                </a>
              ))}
            </nav>
            <section
              id="subscription"
              className="scroll-mt-4 rounded-lg border border-border bg-card p-5"
            >
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <div className="text-xs uppercase tracking-widest text-muted-foreground">
                    Current plan
                  </div>
                  <div className="mt-1 text-xl font-black">
                    {summary.billing.selectedPlan === "both"
                      ? "Missed-Call Recovery + AI Receptionist"
                      : summary.billing.selectedPlan === "ai_receptionist"
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
                  {summary.billing.foundingPlumberBenefit && (
                    <div className="mt-3 inline-flex rounded-full border border-primary/35 bg-primary/10 px-3 py-1 text-xs font-black text-primary">
                      FOUNDINGPLUMBER: {summary.billing.foundingPlumberBenefit}
                    </div>
                  )}
                  {summary.billing.currentPeriodEnd && (
                    <div className="text-xs text-muted-foreground">
                      Current period ends{" "}
                      {new Date(summary.billing.currentPeriodEnd).toLocaleDateString()}
                    </div>
                  )}
                  {summary.billing.normalBillingStartsAt && (
                    <div className="mt-2 text-sm font-bold text-primary">
                      Normal subscription billing begins{" "}
                      {new Date(summary.billing.normalBillingStartsAt).toLocaleDateString("en-AU", {
                        day: "numeric",
                        month: "long",
                        year: "numeric",
                      })}
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
                ) : summary.billing.selectedPlan ? (
                  <button
                    onClick={() => void openBilling("checkout")}
                    disabled={Boolean(busy) || !summary.billing.selectedPlan}
                    className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-black text-primary-foreground disabled:opacity-50"
                  >
                    <CreditCard className="h-4 w-4" />{" "}
                    {busy === "checkout" ? "Opening…" : "Activate securely with Stripe"}
                  </button>
                ) : (
                  <div className="space-y-4">
                    <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
                      Your account is ready, but it has no subscription. Choose a plan to continue.
                    </div>
                    <div className="grid gap-3 sm:grid-cols-3">
                      <PlanChoice
                        active={selectedPlan === "missed_call_recovery"}
                        title="Missed-Call Recovery"
                        price="A$9/month"
                        detail="Missed-call text recovery and lead capture."
                        onClick={() => setSelectedPlan("missed_call_recovery")}
                      />
                      <PlanChoice
                        active={selectedPlan === "ai_receptionist"}
                        title="AI Receptionist"
                        price="A$15/month"
                        detail="Answers calls and captures the job."
                        onClick={() => setSelectedPlan("ai_receptionist")}
                      />
                      <PlanChoice
                        active={selectedPlan === "both"}
                        title="Both services"
                        price="A$24/month"
                        detail="AI answering plus missed-call follow-up."
                        onClick={() => setSelectedPlan("both")}
                      />
                    </div>
                    <button
                      onClick={() => void choosePlanAndCheckout()}
                      disabled={planBusy || Boolean(busy)}
                      className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-black text-primary-foreground disabled:opacity-50"
                    >
                      <ShieldCheck className="h-4 w-4" />
                      {planBusy || busy === "checkout"
                        ? "Opening secure checkout…"
                        : "Continue to secure checkout"}
                    </button>
                  </div>
                )}
              </div>
            </section>

            <section id="usage" className="scroll-mt-4">
              <div className="mb-3 flex items-end justify-between gap-3">
                <div>
                  <h2 className="text-xl font-black">Usage &amp; current costs</h2>
                  <p className="text-sm text-muted-foreground">
                    {summary.usage.periodStart
                      ? `Since ${new Date(summary.usage.periodStart).toLocaleDateString()}`
                      : "Current account usage"}
                  </p>
                </div>
                <div className="text-right">
                  <div className="text-xs uppercase tracking-widest text-muted-foreground">
                    Estimated total
                  </div>
                  <div className="text-2xl font-black">
                    A${summary.estimatedCurrentTotalAud.toFixed(2)}
                  </div>
                </div>
              </div>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <Metric
                  label="AI voice usage"
                  value={`${Math.ceil(summary.usage.totalBillableSeconds / 60)} min`}
                />
                <Metric label="Recovery SMS" value={`${summary.usage.smsMessages} recorded`} />
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
              </div>
            </section>

            <section
              id="payments"
              className="scroll-mt-4 rounded-lg border border-border bg-card p-5"
            >
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div>
                  <h2 className="flex items-center gap-2 text-xl font-black">
                    <FileText className="h-5 w-5 text-primary" /> Payments &amp; invoices
                  </h2>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Update your card, review invoices, download receipts, or change and cancel an
                    active subscription in Stripe’s secure portal.
                  </p>
                </div>
                <button
                  onClick={() =>
                    void openBilling(summary.billing.hasStripeCustomer ? "portal" : "checkout")
                  }
                  disabled={
                    Boolean(busy) ||
                    (!summary.billing.hasStripeCustomer && !summary.billing.selectedPlan)
                  }
                  className="inline-flex items-center gap-2 rounded-md border border-primary px-4 py-2 text-sm font-black text-primary disabled:opacity-50"
                >
                  <CreditCard className="h-4 w-4" />
                  {summary.billing.hasStripeCustomer ? "Open payment portal" : "Set up payments"}
                  <ExternalLink className="h-3.5 w-3.5" />
                </button>
              </div>
            </section>

            <div className="grid gap-6 lg:grid-cols-2">
              <section
                id="profile"
                className="scroll-mt-4 rounded-lg border border-border bg-card p-5"
              >
                <h2 className="flex items-center gap-2 text-xl font-black">
                  <Building2 className="h-5 w-5 text-primary" /> Profile &amp; security
                </h2>
                <dl className="mt-4 space-y-3 text-sm">
                  <Detail label="Business" value={summary.account.businessName || "Not set"} />
                  <Detail label="Public email" value={summary.account.publicEmail || "Not set"} />
                  <Detail label="Public phone" value={summary.account.publicPhone || "Not set"} />
                </dl>
                <div className="mt-5 flex flex-wrap gap-2">
                  <Link
                    to="/settings"
                    className="rounded-md bg-primary px-4 py-2 text-sm font-black text-primary-foreground"
                  >
                    Edit business profile
                  </Link>
                  <button
                    onClick={() => void sendPasswordReset()}
                    className="inline-flex items-center gap-2 rounded-md border border-border px-4 py-2 text-sm font-bold"
                  >
                    <KeyRound className="h-4 w-4" /> Change password
                  </button>
                </div>
                {securityMessage && (
                  <p className="mt-3 text-xs text-muted-foreground">{securityMessage}</p>
                )}
              </section>

              <section
                id="connections"
                className="scroll-mt-4 rounded-lg border border-border bg-card p-5"
              >
                <h2 className="flex items-center gap-2 text-xl font-black">
                  <Settings className="h-5 w-5 text-primary" /> Connected services
                </h2>
                <div className="mt-4 space-y-3">
                  <Connection
                    icon={CreditCard}
                    label="Stripe payments"
                    ready={summary.connections.stripe}
                  />
                  <Connection
                    icon={Phone}
                    label="Platform phone"
                    ready={summary.connections.phoneStatus === "verified"}
                    detail={
                      summary.connections.phoneNumber ??
                      summary.connections.phoneStatus.replaceAll("_", " ")
                    }
                  />
                  <Connection
                    icon={Bot}
                    label="AI receptionist"
                    ready={summary.connections.aiReceptionist}
                  />
                  <Connection
                    icon={ReceiptText}
                    label="SMS delivery"
                    ready={summary.connections.sms}
                  />
                </div>
                <Link
                  to="/call-handling"
                  className="mt-5 inline-block text-sm font-bold text-primary underline"
                >
                  Manage service switches
                </Link>
              </section>
            </div>

            <p className="text-xs text-muted-foreground">
              Subscription changes and cancellation are handled in Stripe’s secure customer portal.
              Access continues according to the displayed billing state and any stated grace period.
              Each Twilio-accepted recovery SMS is A$
              {(TEXT_LINK_SMS_UNIT_PRICE_MINOR / 100).toFixed(2)} excluding GST. GST is applied by
              the invoicing and tax layer.
            </p>
          </div>
        )}
      </div>
    </AppShell>
  );
}

function PlanChoice({
  active,
  title,
  price,
  detail,
  onClick,
}: {
  active: boolean;
  title: string;
  price: string;
  detail: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-lg border p-4 text-left ${active ? "border-primary bg-primary/10" : "border-border"}`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-black">{title}</span>
        {active && <CheckCircle2 className="h-5 w-5 text-primary" />}
      </div>
      <div className="mt-1 text-lg font-black">{price}</div>
      <div className="mt-1 text-xs text-muted-foreground">{detail}</div>
    </button>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4 border-b border-border pb-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right font-bold">{value}</dd>
    </div>
  );
}

function Connection({
  icon: Icon,
  label,
  ready,
  detail,
}: {
  icon: typeof CreditCard;
  label: string;
  ready: boolean;
  detail?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-md border border-border p-3">
      <div className="flex items-center gap-2">
        <Icon className="h-4 w-4 text-primary" />
        <div>
          <div className="text-sm font-bold">{label}</div>
          {detail && <div className="text-xs capitalize text-muted-foreground">{detail}</div>}
        </div>
      </div>
      <span
        className={`text-xs font-black uppercase tracking-wider ${ready ? "text-emerald-500" : "text-amber-500"}`}
      >
        {ready ? "Connected" : "Setup needed"}
      </span>
    </div>
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
