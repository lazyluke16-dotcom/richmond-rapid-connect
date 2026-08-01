import { Link } from "@tanstack/react-router";
import { CheckCircle2, Loader2, RefreshCw, Sparkles } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { supabase } from "@/integrations/supabase/client";
import {
  checkoutAcknowledgementKey,
  checkoutSessionFromSearch,
  checkoutSetupRoute,
  type CheckoutReturnSearch,
} from "@/lib/checkout-return";

type VerifiedPurchase = {
  verified: true;
  status: "active";
  billingStatus: "active";
  plan: "missed_call_recovery" | "ai_receptionist" | "both";
  planName: string;
  monthlyPriceAud: number;
  foundingBenefit: string | null;
  normalBillingStartsAt: string | null;
};

type State =
  | { kind: "hidden" }
  | { kind: "checking"; attempt: number }
  | { kind: "processing"; attempt: number }
  | { kind: "active"; purchase: VerifiedPurchase }
  | { kind: "error"; message: string };

export function SubscriptionSuccess({ search }: { search: CheckoutReturnSearch }) {
  const sessionId = checkoutSessionFromSearch(search);
  const [state, setState] = useState<State>({ kind: "hidden" });

  const verify = useCallback(
    async (attempt = 0) => {
      if (!sessionId) return;
      setState(attempt === 0 ? { kind: "checking", attempt } : { kind: "processing", attempt });
      try {
        const { data } = await supabase.auth.getSession();
        const token = data.session?.access_token;
        if (!token) {
          setState({ kind: "hidden" });
          return;
        }
        const response = await fetch("/api/public/billing/checkout-status", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ sessionId }),
        });
        const payload = (await response.json().catch(() => ({}))) as Partial<VerifiedPurchase> & {
          status?: string;
          error?: string;
        };
        if (response.status === 202 && attempt < 5) {
          setState({ kind: "processing", attempt });
          window.setTimeout(() => void verify(attempt + 1), 2500);
          return;
        }
        if (response.ok && payload.verified && payload.status === "active") {
          setState({ kind: "active", purchase: payload as VerifiedPurchase });
          window.dispatchEvent(new Event("rapid-connect:billing-activated"));
          return;
        }
        setState({
          kind: "error",
          message:
            response.status === 202
              ? "Stripe accepted your order. Activation is taking a little longer than usual."
              : (payload.error ?? "We could not confirm this purchase yet."),
        });
      } catch {
        setState({ kind: "error", message: "We could not confirm this purchase yet." });
      }
    },
    [sessionId],
  );

  useEffect(() => {
    if (!sessionId) return;
    if (window.localStorage.getItem(checkoutAcknowledgementKey(sessionId)) === "1") return;
    void verify();
  }, [sessionId, verify]);

  const acknowledge = () => {
    if (sessionId) window.localStorage.setItem(checkoutAcknowledgementKey(sessionId), "1");
    window.history.replaceState({}, "", "/dashboard");
    setState({ kind: "hidden" });
  };

  if (state.kind === "hidden") return null;

  if (state.kind === "checking" || state.kind === "processing") {
    return (
      <section
        aria-live="polite"
        className="mb-6 flex items-start gap-3 rounded-xl border border-primary/35 bg-primary/10 p-4"
      >
        <Loader2 className="mt-0.5 h-5 w-5 shrink-0 animate-spin text-primary" aria-hidden="true" />
        <div>
          <h2 className="font-black">Confirming your subscription</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Stripe has returned you safely. We’re waiting for your account to switch to Active. This
            usually takes only a few seconds.
          </p>
        </div>
      </section>
    );
  }

  if (state.kind === "error") {
    return (
      <section
        aria-live="polite"
        className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-400/40 bg-amber-400/10 p-4"
      >
        <div>
          <h2 className="font-black">Your subscription is still being confirmed</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {state.message} No new payment is needed.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void verify(1)}
          className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-amber-400/50 px-4 text-sm font-black outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <RefreshCw className="h-4 w-4" aria-hidden="true" /> Check again
        </button>
      </section>
    );
  }

  const { purchase } = state;
  return (
    <Dialog open onOpenChange={(open) => !open && acknowledge()}>
      <DialogContent className="overflow-hidden border-emerald-400/45 p-0 sm:max-w-xl">
        <div className="border-b border-emerald-400/25 bg-emerald-400/10 p-6">
          <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-emerald-400 text-slate-950">
            <CheckCircle2 className="h-7 w-7" aria-hidden="true" />
          </div>
          <DialogHeader>
            <DialogTitle className="text-2xl font-black">
              You’re all set — your subscription is active.
            </DialogTitle>
            <DialogDescription className="text-base">
              Welcome aboard. Your Rapid Connect service is ready for its final setup.
            </DialogDescription>
          </DialogHeader>
        </div>
        <div className="space-y-5 px-6 pb-6">
          <dl className="grid gap-3 rounded-xl border border-border bg-card p-4 sm:grid-cols-3">
            <div>
              <dt className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
                Plan
              </dt>
              <dd className="mt-1 font-black">{purchase.planName}</dd>
            </div>
            <div>
              <dt className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
                Normal monthly
              </dt>
              <dd className="mt-1 font-black">A${purchase.monthlyPriceAud}/month</dd>
            </div>
            <div>
              <dt className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
                Status
              </dt>
              <dd className="mt-1 font-black text-emerald-400">Active</dd>
            </div>
          </dl>
          {purchase.foundingBenefit && (
            <div className="flex gap-3 rounded-lg border border-primary/30 bg-primary/10 p-3 text-sm">
              <Sparkles className="h-5 w-5 shrink-0 text-primary" aria-hidden="true" />
              <div>
                <b>FOUNDINGPLUMBER benefit:</b> {purchase.foundingBenefit}.
              </div>
            </div>
          )}
          {purchase.normalBillingStartsAt && (
            <p className="rounded-lg bg-muted p-3 text-sm">
              Your first three monthly platform fees are A$0. Usage charges apply from activation.
              Normal subscription billing begins{" "}
              <b>
                {new Date(purchase.normalBillingStartsAt).toLocaleDateString("en-AU", {
                  day: "numeric",
                  month: "long",
                  year: "numeric",
                })}
              </b>
              .
            </p>
          )}
          <div>
            <h3 className="font-black">Next: finish setup and switch your service on</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              Verify forwarding, review the sensible defaults, then send your first safe test job.
              You can refine advanced details later.
            </p>
          </div>
          <DialogFooter className="gap-2 sm:space-x-0">
            <button
              type="button"
              onClick={acknowledge}
              className="min-h-11 rounded-lg border border-border px-4 text-sm font-black outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Go to dashboard
            </button>
            <Link
              to={checkoutSetupRoute(purchase.plan) as never}
              onClick={acknowledge}
              className="inline-flex min-h-11 items-center justify-center rounded-lg bg-primary px-4 text-sm font-black text-primary-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Set up my service
            </Link>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}
