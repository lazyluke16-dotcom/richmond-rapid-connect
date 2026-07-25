import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
  Bot,
  Check,
  CircleOff,
  Loader2,
  MessageSquareText,
  PhoneCall,
  Save,
  ShieldCheck,
} from "lucide-react";
import { AppShell } from "@/components/AppShell";
import { useMyTenantBrand } from "@/hooks/use-my-tenant-brand";
import {
  getMyCallHandlingContext,
  reserveMyForwardingNumber,
  setMyCallHandlingMode,
  startMyForwardingVerification,
  updateMyCustomerPhone,
  type CallHandlingContext,
} from "@/lib/call-handling.functions";
import type { CallHandlingMode } from "@/lib/call-handling";

export const Route = createFileRoute("/_authenticated/call-handling")({
  head: () => ({
    meta: [
      { title: "Call Handling — Your AI Trade Assistant" },
      {
        name: "description",
        content: "Choose how unanswered customer calls are handled.",
      },
    ],
  }),
  component: CallHandlingPage,
});

const OPTIONS: {
  mode: CallHandlingMode;
  label: string;
  description: string;
  icon: typeof CircleOff;
}[] = [
  {
    mode: "off",
    label: "Off",
    description: "No Text Link or AI workflow runs.",
    icon: CircleOff,
  },
  {
    mode: "text_link",
    label: "Text Link",
    description: "Send one secure job-request link when a call reaches the platform.",
    icon: MessageSquareText,
  },
  {
    mode: "ai_receptionist",
    label: "AI Receptionist",
    description: "Let your configured receptionist answer and create the job card.",
    icon: Bot,
  },
];

function CallHandlingPage() {
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
      setError(cause instanceof Error ? cause.message : "Could not load call handling"),
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

  if (!context) {
    return (
      <AppShell showCallBar={false} tenant={tenant} hidePublicNav>
        <div className="mx-auto flex max-w-4xl items-center gap-2 px-4 py-10 text-sm text-muted-foreground">
          {error ? null : <Loader2 className="h-4 w-4 animate-spin" />}
          {error ?? "Loading call handling…"}
        </div>
      </AppShell>
    );
  }

  const canUse = (mode: CallHandlingMode) => {
    if (mode === "off") return true;
    if (!context.forwarding.number || context.forwarding.status !== "verified") return false;
    if (mode === "text_link") return context.entitlements.textLink && context.provider.smsReady;
    return context.entitlements.aiReceptionist && context.provider.aiReady;
  };

  return (
    <AppShell showCallBar={false} tenant={tenant} hidePublicNav>
      <div className="mx-auto max-w-4xl space-y-6 px-4 py-7">
        <header className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
          <div>
            <div className="text-xs font-bold uppercase tracking-[0.18em] text-primary">
              Your phone line
            </div>
            <h1 className="mt-1 text-3xl font-black tracking-tight">Call Handling</h1>
            <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
              Your subscription can include both services. This switch decides which single workflow
              answers inbound calls right now.
            </p>
          </div>
          <Link to="/dashboard" className="text-sm text-muted-foreground underline">
            ← Job Centre
          </Link>
        </header>

        {error && (
          <div
            role="alert"
            className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
          >
            {error}
          </div>
        )}
        {notice && (
          <div className="rounded-md border border-primary/40 bg-primary/10 p-3 text-sm text-primary">
            {notice}
          </div>
        )}

        <section className="overflow-hidden rounded-xl border border-border bg-card">
          <div className="border-b border-border bg-muted/30 px-5 py-4">
            <div className="flex items-center gap-2 font-black">
              <PhoneCall className="h-5 w-5 text-primary" /> Where customers call
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              Keep your existing Australian number. No number is moved or disconnected.
            </p>
          </div>
          <div className="grid gap-5 p-5 md:grid-cols-[1fr_1fr]">
            <label className="block">
              <span className="text-xs font-bold uppercase tracking-widest text-muted-foreground">
                Existing business number
              </span>
              <div className="mt-2 flex gap-2">
                <input
                  value={phone}
                  onChange={(event) => setPhone(event.target.value)}
                  inputMode="tel"
                  disabled={!context.canManage || Boolean(busy)}
                  className="min-w-0 flex-1 rounded-md border border-border bg-input px-3 py-2 text-sm"
                  placeholder="e.g. 04xx xxx xxx"
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
                  className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm font-bold disabled:opacity-40"
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
                Platform forwarding number
              </div>
              {context.forwarding.number ? (
                <div className="mt-2 rounded-md border border-primary/40 bg-primary/5 px-4 py-3">
                  <div className="font-mono text-lg font-black">{context.forwarding.number}</div>
                  <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                    <ShieldCheck className="h-3.5 w-3.5 text-primary" />
                    {context.forwarding.status === "verified"
                      ? "Forwarding verified by a real inbound call"
                      : context.forwarding.status === "pending_verification"
                        ? "Verification window open — make the forwarded call now"
                        : "Reserved — start verification when forwarding is configured"}
                  </div>
                  {context.forwarding.status !== "verified" && (
                    <button
                      type="button"
                      disabled={!context.canManage || Boolean(busy)}
                      onClick={() =>
                        void run("verify", async () => {
                          const result = await startMyForwardingVerification();
                          setNotice(
                            `Verification is open until ${new Date(result.expiresAt).toLocaleTimeString()}.`,
                          );
                        })
                      }
                      className="mt-3 inline-flex items-center gap-2 rounded-md border border-primary/50 px-3 py-2 text-xs font-black text-primary disabled:opacity-40"
                    >
                      {busy === "verify" ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <ShieldCheck className="h-4 w-4" />
                      )}
                      {context.forwarding.status === "pending_verification"
                        ? "Restart 15-minute verification"
                        : "Start 15-minute verification"}
                    </button>
                  )}
                </div>
              ) : (
                <button
                  type="button"
                  disabled={!context.canManage || !phone || Boolean(busy)}
                  onClick={() =>
                    void run("allocate", async () => {
                      const result = await reserveMyForwardingNumber();
                      setNotice(`Forwarding number ${result.forwardingNumber} reserved.`);
                    })
                  }
                  className="mt-2 inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-black text-primary-foreground disabled:opacity-40"
                >
                  {busy === "allocate" ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <PhoneCall className="h-4 w-4" />
                  )}
                  Allocate an available number
                </button>
              )}
            </div>
          </div>
          {context.forwarding.number && context.forwarding.status === "pending_verification" && (
            <div className="border-t border-border bg-muted/20 px-5 py-4 text-sm">
              <b>Verify no-answer forwarding:</b> use your carrier’s no-answer forwarding setup to
              send unanswered calls to{" "}
              <span className="font-mono">{context.forwarding.number}</span>. Then call your
              existing business number from another phone and let it forward. The real inbound call
              completes verification automatically.
            </div>
          )}
        </section>

        <section className="rounded-xl border border-border bg-card p-5">
          <div className="flex items-end justify-between gap-3">
            <div>
              <h2 className="font-black">Choose the active mode</h2>
              <p className="mt-1 text-xs text-muted-foreground">
                The server applies this choice atomically; two modes cannot be active together.
              </p>
            </div>
            <div className="rounded-full border border-primary/40 bg-primary/10 px-3 py-1 text-xs font-black uppercase tracking-widest text-primary">
              {OPTIONS.find((option) => option.mode === context.mode)?.label}
            </div>
          </div>

          <div className="relative mt-5 grid gap-3 md:grid-cols-3">
            <div
              aria-hidden
              className="absolute left-[16.66%] right-[16.66%] top-7 hidden h-px bg-border md:block"
            />
            {OPTIONS.map((option) => {
              const Icon = option.icon;
              const active = option.mode === context.mode;
              const available = canUse(option.mode);
              return (
                <button
                  key={option.mode}
                  type="button"
                  disabled={!context.canManage || !available || Boolean(busy)}
                  onClick={() =>
                    void run(`mode:${option.mode}`, async () => {
                      await setMyCallHandlingMode({ data: { mode: option.mode } });
                      setNotice(`${option.label} is now the active call handling mode.`);
                    })
                  }
                  className={`relative rounded-lg border p-4 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-not-allowed disabled:opacity-45 ${
                    active
                      ? "border-primary bg-primary/10"
                      : "border-border bg-background hover:border-primary/50"
                  }`}
                >
                  <span
                    className={`relative z-10 grid h-11 w-11 place-items-center rounded-full border ${
                      active
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border bg-card"
                    }`}
                  >
                    {busy === `mode:${option.mode}` ? (
                      <Loader2 className="h-5 w-5 animate-spin" />
                    ) : active ? (
                      <Check className="h-5 w-5" />
                    ) : (
                      <Icon className="h-5 w-5" />
                    )}
                  </span>
                  <div className="mt-4 font-black">{option.label}</div>
                  <div className="mt-1 text-xs leading-relaxed text-muted-foreground">
                    {option.description}
                  </div>
                </button>
              );
            })}
          </div>
        </section>

        <div className="grid gap-4 md:grid-cols-2">
          <section className="rounded-lg border border-border bg-card p-4">
            <div className="text-xs font-bold uppercase tracking-widest text-muted-foreground">
              Included services
            </div>
            <ServiceLine label="Text Link" included={context.entitlements.textLink} />
            <ServiceLine label="AI Receptionist" included={context.entitlements.aiReceptionist} />
            <Link to="/billing" className="mt-3 inline-block text-xs text-primary underline">
              View subscription
            </Link>
          </section>
          <section className="rounded-lg border border-border bg-card p-4">
            <div className="text-xs font-bold uppercase tracking-widest text-muted-foreground">
              Usage ledger
            </div>
            <div className="mt-3 flex justify-between text-sm">
              <span>AI voice</span>
              <b>{context.usage.aiVoiceSeconds.toLocaleString()} sec</b>
            </div>
            <div className="mt-2 flex justify-between text-sm">
              <span>Recovery SMS</span>
              <b>{context.usage.smsMessages.toLocaleString()}</b>
            </div>
            <p className="mt-3 text-xs text-muted-foreground">
              SMS is recorded for visibility and remains non-billable until a customer SMS price is
              explicitly approved.
            </p>
          </section>
        </div>

        {!context.canManage && (
          <p className="text-xs text-muted-foreground">
            You can view call handling. An owner or administrator must change routing or allocate a
            number.
          </p>
        )}
      </div>
    </AppShell>
  );
}

function ServiceLine({ label, included }: { label: string; included: boolean }) {
  return (
    <div className="mt-3 flex items-center justify-between text-sm">
      <span>{label}</span>
      <span className={included ? "font-bold text-primary" : "text-muted-foreground"}>
        {included ? "Included" : "Not included"}
      </span>
    </div>
  );
}
