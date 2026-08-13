import { createFileRoute, Link } from "@tanstack/react-router";
import {
  Bot,
  CheckCircle2,
  Clock3,
  Loader2,
  MessageSquareText,
  PhoneCall,
  Plus,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { useEffect, useState } from "react";
import {
  addMySmartAnswerBypass,
  getMyReceptionMessages,
  getMySmartAnswerContext,
  removeMySmartAnswerBypass,
  setMySmartAnswerSettings,
  type ReceptionMessage,
  type SmartAnswerContext,
} from "@/lib/smart-answer.functions";
import { provisionMySmartAnswerStack } from "@/lib/smart-answer-provisioning.functions";

// @ts-expect-error routeTree.gen.ts is regenerated from this literal route during Vite build.
export const Route = createFileRoute("/_authenticated/smart-answer")({
  head: () => ({
    meta: [
      { title: "Smart Answer — Rapid Connect" },
      {
        name: "description",
        content: "Ring-first AI overflow, protected callers and receptionist messages.",
      },
    ],
  }),
  component: SmartAnswerPage,
});

function SmartAnswerPage() {
  const [context, setContext] = useState<SmartAnswerContext | null>(null);
  const [messages, setMessages] = useState<ReceptionMessage[]>([]);
  const [ringSeconds, setRingSeconds] = useState(15);
  const [label, setLabel] = useState("");
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = async () => {
    const [nextContext, nextMessages] = await Promise.all([
      getMySmartAnswerContext(),
      getMyReceptionMessages(),
    ]);
    setContext(nextContext);
    setRingSeconds(nextContext.ringFirstSeconds);
    setMessages(nextMessages);
  };

  useEffect(() => {
    void load().catch((cause) =>
      setError(cause instanceof Error ? cause.message : "Could not load Smart Answer"),
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
      <div className="mx-auto flex max-w-5xl items-center gap-2 px-5 py-12 text-sm text-muted-foreground">
        {!error && <Loader2 className="h-4 w-4 animate-spin" />}
        {error ?? "Loading Smart Answer…"}
      </div>
    );
  }

  const readyToEnable =
    context.forwardingStatus === "verified" &&
    context.answeringMode === "ai_receptionist" &&
    context.aiOperational &&
    context.sipReady;

  return (
    <div className="mx-auto max-w-5xl space-y-7 px-4 py-7 sm:px-6">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="text-xs font-black uppercase tracking-[.18em] text-primary">
            Ring first · AI second
          </div>
          <h1 className="mt-1 text-3xl font-black tracking-tight">Smart Answer</h1>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
            Your normal phone gets the first chance to answer. Only unanswered, eligible callers are
            handed to your AI receptionist. Protected callers stay out of AI.
          </p>
        </div>
        <Link
          to="/call-handling"
          className="inline-flex min-h-11 items-center justify-center rounded-lg border border-border px-4 text-sm font-black"
        >
          Phone setup
        </Link>
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

      <section className="grid gap-4 md:grid-cols-3" aria-label="Smart Answer call rules">
        <RuleCard
          icon={PhoneCall}
          title="You answer first"
          body={`Set your carrier's no-answer forwarding delay to about ${ringSeconds} seconds. If you answer before forwarding, Rapid Connect never handles the call.`}
        />
        <RuleCard
          icon={Bot}
          title="Genuine callers get AI"
          body="Normal Australian mobile and geographic landline callers can reach the receptionist after the ring-first window."
        />
        <RuleCard
          icon={ShieldCheck}
          title="Protected calls stay human"
          body="Numbers on your protected list go to ordinary voicemail. 13, 1300 and 1800 callers are rejected before AI starts."
        />
      </section>

      <section className="overflow-hidden rounded-2xl border border-border bg-card">
        <div className="border-b border-border bg-muted/30 px-5 py-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="font-black">Smart Answer status</div>
              <p className="mt-1 text-xs text-muted-foreground">
                Secure SIP is provisioned separately so screened calls cannot bypass the routing layer.
              </p>
            </div>
            <span
              className={`rounded-full px-3 py-1 text-xs font-black ${
                context.enabled
                  ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                  : "bg-muted text-muted-foreground"
              }`}
            >
              {context.enabled ? "ON" : "OFF"}
            </span>
          </div>
        </div>
        <div className="grid gap-6 p-5 md:grid-cols-2">
          <div>
            <label className="block text-xs font-bold uppercase tracking-widest text-muted-foreground">
              Ring-first target
            </label>
            <div className="mt-2 flex items-center gap-3">
              <Clock3 className="h-5 w-5 text-primary" />
              <select
                value={ringSeconds}
                onChange={(event) => setRingSeconds(Number(event.target.value))}
                disabled={Boolean(busy)}
                className="min-h-11 rounded-lg border border-border bg-input px-3 text-sm font-bold outline-none focus-visible:ring-2 focus-visible:ring-primary"
              >
                {[10, 15, 20, 25, 30].map((seconds) => (
                  <option value={seconds} key={seconds}>
                    {seconds} seconds
                  </option>
                ))}
              </select>
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              This records your preferred delay for setup. Your mobile carrier controls the actual
              no-answer timer, so set its forwarding delay to match.
            </p>
          </div>

          <div className="space-y-2 text-sm">
            <ReadinessRow
              ready={context.forwardingStatus === "verified"}
              text="No-answer forwarding verified"
            />
            <ReadinessRow
              ready={context.answeringMode === "ai_receptionist" && context.aiOperational}
              text="AI Receptionist switched on"
            />
            <ReadinessRow ready={context.sipReady} text="Secure Smart Answer SIP ready" />
          </div>
        </div>
        <div className="flex flex-col gap-3 border-t border-border bg-muted/20 p-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="text-xs text-muted-foreground">
            {!context.sipReady
              ? "Provision the isolated Smart Answer receptionist before switching this on."
              : readyToEnable
                ? "All routing prerequisites are ready."
                : "Finish the missing phone/AI setup first."}
          </div>
          <div className="flex flex-wrap gap-2">
            {!context.sipReady && (
              <button
                type="button"
                disabled={Boolean(busy) || !context.aiOperational}
                onClick={() =>
                  void run("provision", async () => {
                    const result = await provisionMySmartAnswerStack();
                    if (!result.provisioned) {
                      throw new Error(result.reason ?? "Smart Answer provisioning is unavailable");
                    }
                    setNotice("Secure Smart Answer receptionist is ready.");
                  })
                }
                className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-primary/50 px-4 text-sm font-black text-primary disabled:opacity-40"
              >
                {busy === "provision" && <Loader2 className="h-4 w-4 animate-spin" />}
                Provision Smart Answer
              </button>
            )}
            <button
              type="button"
              disabled={Boolean(busy) || (!context.enabled && !readyToEnable)}
              onClick={() =>
                void run("toggle", async () => {
                  await setMySmartAnswerSettings({
                    data: { enabled: !context.enabled, ringFirstSeconds: ringSeconds },
                  });
                  setNotice(
                    context.enabled
                      ? "Smart Answer is off. Your existing service settings are unchanged."
                      : "Smart Answer is on. Unanswered eligible calls can now use the screened AI path.",
                  );
                })
              }
              className="inline-flex min-h-11 items-center gap-2 rounded-lg bg-primary px-4 text-sm font-black text-primary-foreground disabled:opacity-40"
            >
              {busy === "toggle" && <Loader2 className="h-4 w-4 animate-spin" />}
              {context.enabled ? "Switch Smart Answer off" : "Switch Smart Answer on"}
            </button>
          </div>
        </div>
      </section>

      <section className="overflow-hidden rounded-2xl border border-border bg-card">
        <div className="border-b border-border bg-muted/30 px-5 py-4">
          <div className="font-black">Protected callers</div>
          <p className="mt-1 text-xs text-muted-foreground">
            V1 uses this manual list. Automatic phone-contact syncing can populate the same protected
            list later without changing the call-routing system.
          </p>
        </div>
        <div className="grid gap-3 p-5 sm:grid-cols-[1fr_1fr_auto]">
          <input
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            placeholder="Name / label, e.g. Reece Richmond"
            disabled={Boolean(busy)}
            className="min-h-11 rounded-lg border border-border bg-input px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-primary"
          />
          <input
            value={phone}
            onChange={(event) => setPhone(event.target.value)}
            placeholder="0412 345 678"
            inputMode="tel"
            disabled={Boolean(busy)}
            className="min-h-11 rounded-lg border border-border bg-input px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-primary"
          />
          <button
            type="button"
            disabled={Boolean(busy) || !phone.trim()}
            onClick={() =>
              void run("add-bypass", async () => {
                await addMySmartAnswerBypass({ data: { phone, label } });
                setPhone("");
                setLabel("");
                setNotice("Protected number added. Future unanswered calls from it will avoid AI.");
              })
            }
            className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-primary px-4 text-sm font-black text-primary-foreground disabled:opacity-40"
          >
            {busy === "add-bypass" ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Plus className="h-4 w-4" />
            )}
            Protect
          </button>
        </div>
        <div className="border-t border-border">
          {context.bypassNumbers.length === 0 ? (
            <div className="px-5 py-6 text-sm text-muted-foreground">
              No manual protected numbers yet.
            </div>
          ) : (
            context.bypassNumbers.map((item) => (
              <div
                key={item.id}
                className="flex items-center justify-between gap-3 border-b border-border px-5 py-3 last:border-b-0"
              >
                <div className="min-w-0">
                  <div className="truncate text-sm font-black">{item.label || item.phone}</div>
                  <div className="text-xs text-muted-foreground">
                    {item.phone} · {item.source.replaceAll("_", " ")}
                  </div>
                </div>
                <button
                  type="button"
                  aria-label={`Remove ${item.label || item.phone} from protected callers`}
                  disabled={Boolean(busy)}
                  onClick={() =>
                    void run(`remove:${item.id}`, async () => {
                      await removeMySmartAnswerBypass({ data: { id: item.id } });
                      setNotice("Protected number removed.");
                    })
                  }
                  className="grid min-h-11 min-w-11 place-items-center rounded-lg border border-border text-muted-foreground hover:text-destructive disabled:opacity-40"
                >
                  {busy === `remove:${item.id}` ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Trash2 className="h-4 w-4" />
                  )}
                </button>
              </div>
            ))
          )}
        </div>
      </section>

      <section className="overflow-hidden rounded-2xl border border-border bg-card">
        <div className="flex items-center justify-between gap-3 border-b border-border bg-muted/30 px-5 py-4">
          <div>
            <div className="flex items-center gap-2 font-black">
              <MessageSquareText className="h-5 w-5 text-primary" /> Receptionist messages
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              Suppliers, business contacts and other non-job callers appear here instead of becoming
              plumbing leads.
            </p>
          </div>
          {context.unreadMessages > 0 && (
            <span className="rounded-full bg-primary px-2.5 py-1 text-xs font-black text-primary-foreground">
              {context.unreadMessages} unread
            </span>
          )}
        </div>
        {messages.length === 0 ? (
          <div className="px-5 py-8 text-center text-sm text-muted-foreground">
            No receptionist messages yet.
          </div>
        ) : (
          <div className="divide-y divide-border">
            {messages.map((message) => (
              <MessageRow message={message} key={message.id} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function RuleCard({
  icon: Icon,
  title,
  body,
}: {
  icon: typeof PhoneCall;
  title: string;
  body: string;
}) {
  return (
    <div className="rounded-2xl border border-border bg-card p-5">
      <span className="grid h-10 w-10 place-items-center rounded-xl bg-primary/10 text-primary">
        <Icon className="h-5 w-5" />
      </span>
      <div className="mt-4 font-black">{title}</div>
      <p className="mt-2 text-sm leading-6 text-muted-foreground">{body}</p>
    </div>
  );
}

function ReadinessRow({ ready, text }: { ready: boolean; text: string }) {
  return (
    <div className="flex items-center gap-2">
      {ready ? (
        <CheckCircle2 className="h-4 w-4 text-emerald-500" />
      ) : (
        <span className="h-4 w-4 rounded-full border-2 border-muted-foreground/40" />
      )}
      <span className={ready ? "font-bold" : "text-muted-foreground"}>{text}</span>
    </div>
  );
}

function MessageRow({ message }: { message: ReceptionMessage }) {
  const who = message.callerName || message.callerCompany || message.callerPhone || "Unknown caller";
  const when = new Date(message.createdAt).toLocaleString("en-AU", {
    dateStyle: "medium",
    timeStyle: "short",
  });
  return (
    <article className="p-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-black">{who}</span>
            {message.callerCompany && message.callerName && (
              <span className="text-xs text-muted-foreground">· {message.callerCompany}</span>
            )}
            {message.messageUrgency === "urgent" && (
              <span className="rounded-full bg-destructive/10 px-2 py-0.5 text-[11px] font-black text-destructive">
                URGENT
              </span>
            )}
          </div>
          <div className="mt-1 text-xs text-muted-foreground">
            {when} · {message.source === "voicemail" ? "ordinary voicemail" : "AI receptionist"}
          </div>
          <p className="mt-3 max-w-3xl whitespace-pre-wrap text-sm leading-6">
            {message.messageText || message.transcription || "Voice message recorded."}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          {message.callerPhone && (
            <a
              href={`tel:${message.callerPhone}`}
              className="inline-flex min-h-11 items-center gap-2 rounded-lg bg-primary px-3 text-sm font-black text-primary-foreground"
            >
              <PhoneCall className="h-4 w-4" /> Call back
            </a>
          )}
          {message.recordingUrl && (
            <a
              href={message.recordingUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex min-h-11 items-center rounded-lg border border-border px-3 text-sm font-bold"
            >
              Recording
            </a>
          )}
        </div>
      </div>
    </article>
  );
}
