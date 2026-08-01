import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import {
  Bot,
  CheckCircle2,
  CircleOff,
  Loader2,
  MessageSquareText,
  PhoneCall,
  Save,
  Send,
  ShieldCheck,
} from "lucide-react";
import { AppShell } from "@/components/AppShell";
import { useMyTenantBrand } from "@/hooks/use-my-tenant-brand";
import {
  getMyCallHandlingContext,
  reserveMyForwardingNumber,
  setMyOperationalService,
  startMyForwardingVerification,
  updateMyCustomerPhone,
  type CallHandlingContext,
} from "@/lib/call-handling.functions";
import { createMyTestJob } from "@/lib/db-leads";

export const Route = createFileRoute("/_authenticated/call-handling")({
  head: () => ({
    meta: [
      { title: "Services — Rapid Connect" },
      { name: "description", content: "Switch your purchased plumber services on or off." },
    ],
  }),
  component: ServicesPage,
});

type ServiceKey = "missed_call_recovery" | "ai_receptionist";

function ServicesPage() {
  const tenant = useMyTenantBrand();
  const [context, setContext] = useState<CallHandlingContext | null>(null);
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = async () => {
    const next = await getMyCallHandlingContext();
    setContext(next);
    setPhone(next.business.publicPhone ?? "");
  };

  useEffect(() => {
    void load().catch((cause) =>
      setError(cause instanceof Error ? cause.message : "Could not load your services"),
    );
  }, []);

  const run = async (key: string, operation: () => Promise<void>) => {
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      await operation();
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The change could not be saved");
    } finally {
      setBusy(null);
    }
  };

  const services = useMemo(() => {
    if (!context) return [];
    return [
      {
        key: "missed_call_recovery" as const,
        name: "Missed-Call Recovery",
        purpose:
          "After you miss a call, immediately text the customer and capture the job in Missed Jobs.",
        icon: MessageSquareText,
        purchased: context.entitlements.textLink,
        enabled: context.operational.missedCallRecovery,
        ready:
          context.forwarding.status === "verified" &&
          Boolean(context.forwarding.number) &&
          context.provider.smsReady,
        missing:
          context.forwarding.status !== "verified"
            ? "Verify call forwarding"
            : !context.provider.smsReady
              ? "SMS service is temporarily unavailable"
              : null,
      },
      {
        key: "ai_receptionist" as const,
        name: "AI Receptionist",
        purpose:
          "Answer the call, speak with the customer, collect the job details and alert you—24/7.",
        icon: Bot,
        purchased: context.entitlements.aiReceptionist,
        enabled: context.operational.aiReceptionist,
        ready:
          context.forwarding.status === "verified" &&
          Boolean(context.forwarding.number) &&
          context.provider.aiReady,
        missing:
          context.forwarding.status !== "verified"
            ? "Verify call forwarding"
            : !context.provider.aiReady
              ? "Finish AI conversation setup"
              : null,
      },
    ];
  }, [context]);

  if (!context) {
    return (
      <AppShell showCallBar={false} tenant={tenant} hidePublicNav>
        <div className="mx-auto flex max-w-5xl items-center gap-2 px-5 py-12 text-sm text-muted-foreground">
          {!error && <Loader2 className="h-4 w-4 animate-spin" />}
          {error ?? "Loading your services…"}
        </div>
      </AppShell>
    );
  }

  const activeServices = services.filter((service) => service.enabled && service.ready);

  return (
    <AppShell showCallBar={false} tenant={tenant} hidePublicNav>
      <div className="mx-auto max-w-5xl space-y-7 px-4 py-7 sm:px-6">
        <header>
          <div className="text-xs font-black uppercase tracking-[.18em] text-primary">
            Your two controls
          </div>
          <h1 className="mt-1 text-3xl font-black tracking-tight">Services</h1>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
            Subscription controls what you have purchased. These switches control what is operating.
            Switching a service off does not cancel its subscription.
          </p>
        </header>

        {error && (
          <div
            role="alert"
            className="rounded-xl border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive"
          >
            {error}
          </div>
        )}
        {notice && (
          <div
            role="status"
            className="rounded-xl border border-emerald-500/35 bg-emerald-500/10 p-4 text-sm font-bold text-emerald-700 dark:text-emerald-300"
          >
            {notice}
          </div>
        )}

        <section className="grid gap-5 lg:grid-cols-2" aria-label="Operational services">
          {services.map(({ key, ...service }) => (
            <ServiceControlCard
              key={key}
              {...service}
              busy={busy === `service:${key}`}
              canManage={context.canManage}
              onToggle={() => {
                if (!service.purchased) return;
                if (!service.ready && !service.enabled) {
                  document.getElementById("phone-setup")?.scrollIntoView({ behavior: "smooth" });
                  return;
                }
                void run(`service:${key}`, async () => {
                  await setMyOperationalService({
                    data: { service: key, enabled: !service.enabled },
                  });
                  setNotice(
                    service.enabled
                      ? `${service.name} is off. You can switch it back on whenever you are ready.`
                      : `${service.name} is on and operating.`,
                  );
                });
              }}
            />
          ))}
        </section>

        <section
          id="phone-setup"
          className="overflow-hidden rounded-2xl border border-border bg-card"
        >
          <div className="border-b border-border bg-muted/30 px-5 py-4">
            <div className="flex items-center gap-2 font-black">
              <PhoneCall className="h-5 w-5 text-primary" /> One-time phone setup
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              Keep your existing number. Forwarding must be verified before either service can be
              switched on.
            </p>
          </div>
          <div className="grid gap-5 p-5 md:grid-cols-2">
            <label className="block">
              <span className="text-xs font-bold uppercase tracking-widest text-muted-foreground">
                Your business number
              </span>
              <div className="mt-2 flex gap-2">
                <input
                  value={phone}
                  onChange={(event) => setPhone(event.target.value)}
                  inputMode="tel"
                  disabled={!context.canManage || Boolean(busy)}
                  className="min-w-0 flex-1 rounded-lg border border-border bg-input px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-primary"
                />
                <button
                  type="button"
                  disabled={!context.canManage || Boolean(busy)}
                  onClick={() =>
                    void run("phone", async () => {
                      const result = await updateMyCustomerPhone({ data: { phone } });
                      setNotice(`Business number saved as ${result.phone}.`);
                    })
                  }
                  className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-border px-3 text-sm font-bold disabled:opacity-40"
                >
                  {busy === "phone" ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Save className="h-4 w-4" />
                  )}
                  Save
                </button>
              </div>
            </label>

            <div>
              <div className="text-xs font-bold uppercase tracking-widest text-muted-foreground">
                Forwarding status
              </div>
              {context.forwarding.number ? (
                <div className="mt-2 rounded-xl border border-primary/35 bg-primary/5 p-4">
                  <div className="font-mono text-lg font-black">{context.forwarding.number}</div>
                  <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                    <ShieldCheck className="h-4 w-4 text-primary" />
                    {context.forwarding.status === "verified"
                      ? "Verified and ready"
                      : "Forward unanswered calls here, then start verification"}
                  </div>
                  {context.forwarding.status !== "verified" && (
                    <button
                      type="button"
                      disabled={!context.canManage || Boolean(busy)}
                      onClick={() =>
                        void run("verify", async () => {
                          await startMyForwardingVerification();
                          setNotice(
                            "Verification is open for 15 minutes. Make the forwarded test call now.",
                          );
                        })
                      }
                      className="mt-3 min-h-11 rounded-lg border border-primary/50 px-4 text-sm font-black text-primary disabled:opacity-40"
                    >
                      Start verification
                    </button>
                  )}
                </div>
              ) : (
                <button
                  type="button"
                  disabled={!context.canManage || !phone || Boolean(busy)}
                  onClick={() =>
                    void run("allocate", async () => {
                      await reserveMyForwardingNumber();
                      setNotice(
                        "Your forwarding number is reserved. Follow the next on-screen step.",
                      );
                    })
                  }
                  className="mt-2 min-h-11 rounded-lg bg-primary px-4 text-sm font-black text-primary-foreground disabled:opacity-40"
                >
                  Reserve my forwarding number
                </button>
              )}
            </div>
          </div>
          {context.forwarding.number && context.forwarding.status !== "verified" && (
            <div className="border-t border-border bg-muted/20 px-5 py-4 text-sm">
              Set no-answer forwarding with your phone carrier to{" "}
              <b className="font-mono">{context.forwarding.number}</b>. Call your business number
              from another phone and let it forward. The inbound call verifies setup automatically.
            </div>
          )}
        </section>

        <section className="rounded-2xl border border-primary/35 bg-primary/8 p-5 sm:p-6">
          <div className="flex flex-col justify-between gap-5 sm:flex-row sm:items-center">
            <div>
              <div className="flex items-center gap-2 font-black">
                {activeServices.length > 0 ? (
                  <CheckCircle2 className="h-5 w-5 text-emerald-500" />
                ) : (
                  <CircleOff className="h-5 w-5 text-muted-foreground" />
                )}
                {activeServices.length > 0
                  ? activeServices.length === 2
                    ? "Both services are ready for a safe test"
                    : "Ready for a safe test"
                  : "Switch a ready service on first"}
              </div>
              <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
                The test uses the captured-job database path and creates a clearly marked entry. Its
                notification is simulated; no customer message, public call or charge is made.
              </p>
            </div>
            <button
              type="button"
              disabled={activeServices.length === 0 || Boolean(busy)}
              onClick={() => {
                if (activeServices.length === 0) return;
                void run("test-job", async () => {
                  const results: Array<{ leadId: string }> = [];
                  for (const service of activeServices) {
                    results.push(
                      await createMyTestJob({
                        data: { service: service.key, requestId: crypto.randomUUID() },
                      }),
                    );
                  }
                  setNotice(
                    activeServices.length === 2
                      ? "Both services are working. Opening the captured test jobs now."
                      : "Your service is working. Opening the captured test job now.",
                  );
                  window.setTimeout(() => {
                    window.location.assign(`/leads#${encodeURIComponent(results[0].leadId)}`);
                  }, 650);
                });
              }}
              className="inline-flex min-h-12 shrink-0 items-center justify-center gap-2 rounded-xl bg-primary px-5 font-black text-primary-foreground disabled:opacity-40"
            >
              {busy === "test-job" ? (
                <Loader2 className="h-5 w-5 animate-spin" />
              ) : (
                <Send className="h-5 w-5" />
              )}
              {activeServices.length === 2
                ? "Send my first test jobs"
                : "Send me my first test job"}
            </button>
          </div>
        </section>

        <div className="flex flex-wrap gap-4 text-sm">
          <Link to="/billing" className="font-bold text-primary underline">
            Manage subscription
          </Link>
          <Link to="/leads" className="font-bold text-primary underline">
            Open Missed Jobs
          </Link>
          <Link to="/setup-guide" className="font-bold text-primary underline">
            Read the setup guide
          </Link>
        </div>
      </div>
    </AppShell>
  );
}

function ServiceControlCard({
  name,
  purpose,
  icon: Icon,
  purchased,
  enabled,
  ready,
  missing,
  busy,
  canManage,
  onToggle,
}: {
  name: string;
  purpose: string;
  icon: typeof Bot;
  purchased: boolean;
  enabled: boolean;
  ready: boolean;
  missing: string | null;
  busy: boolean;
  canManage: boolean;
  onToggle: () => void;
}) {
  const state = !purchased
    ? "Not purchased"
    : !ready
      ? "Setup incomplete"
      : enabled
        ? "On and operating"
        : "Ready — switched off";
  return (
    <article
      className={`rounded-2xl border p-5 ${enabled && ready ? "border-emerald-500/45 bg-emerald-500/5" : "border-border bg-card"}`}
    >
      <div className="flex items-start justify-between gap-4">
        <span className="grid h-12 w-12 place-items-center rounded-xl bg-primary/12 text-primary">
          <Icon className="h-6 w-6" />
        </span>
        <span
          className={`rounded-full px-3 py-1 text-xs font-black ${enabled && ready ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-300" : "bg-muted text-muted-foreground"}`}
        >
          {state}
        </span>
      </div>
      <h2 className="mt-5 text-xl font-black">{name}</h2>
      <p className="mt-2 min-h-12 text-sm leading-relaxed text-muted-foreground">{purpose}</p>
      {missing && purchased && (
        <p className="mt-3 text-sm font-bold text-amber-700 dark:text-amber-300">Next: {missing}</p>
      )}
      <button
        type="button"
        role="switch"
        aria-checked={enabled && ready}
        disabled={!canManage || !purchased || busy}
        onClick={onToggle}
        className={`mt-5 flex min-h-14 w-full items-center justify-between rounded-xl px-4 font-black outline-none focus-visible:ring-4 focus-visible:ring-primary/30 disabled:opacity-45 ${enabled && ready ? "bg-emerald-500 text-slate-950" : "bg-muted text-foreground"}`}
      >
        <span>
          {!purchased
            ? "Choose a plan in Account & Billing"
            : enabled
              ? "Switch off"
              : ready
                ? "Switch on"
                : "Finish setup"}
        </span>
        {busy ? (
          <Loader2 className="h-5 w-5 animate-spin" />
        ) : (
          <span
            className={`relative h-7 w-12 rounded-full ${enabled && ready ? "bg-white/70" : "bg-slate-400/40"}`}
          >
            <span
              className={`absolute top-1 h-5 w-5 rounded-full bg-slate-950 transition-all ${enabled && ready ? "left-6" : "left-1"}`}
            />
          </span>
        )}
      </button>
      {enabled && (
        <p className="mt-3 text-xs text-muted-foreground">
          Switching off stops this operational workflow. It does not cancel billing and is
          reversible.
        </p>
      )}
    </article>
  );
}
