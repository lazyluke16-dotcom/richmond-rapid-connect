import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { CheckCircle2, Loader2, MailX } from "lucide-react";

export const Route = createFileRoute("/unsubscribe")({
  validateSearch: (search: Record<string, unknown>) => ({
    token: typeof search.token === "string" ? search.token.slice(0, 200) : "",
  }),
  head: () => ({
    meta: [
      { title: "Unsubscribe — Rapid Connect" },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: UnsubscribePage,
});

function UnsubscribePage() {
  const { token } = Route.useSearch();
  const [state, setState] = useState<"idle" | "working" | "done" | "error">(
    token ? "idle" : "error",
  );
  const [message, setMessage] = useState(token ? "" : "This unsubscribe link is incomplete.");

  const unsubscribe = async () => {
    setState("working");
    try {
      const response = await fetch("/api/public/outreach/unsubscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const payload = (await response.json()) as { message?: string; error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Unsubscribe failed");
      setMessage(payload.message ?? "You have been unsubscribed.");
      setState("done");
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "Unsubscribe failed");
      setState("error");
    }
  };

  return (
    <main className="grid min-h-dvh place-items-center bg-[#091019] px-5 text-white">
      <section className="w-full max-w-lg rounded-3xl border border-white/10 bg-white/[0.05] p-7 text-center shadow-2xl sm:p-10">
        <span
          className={`mx-auto grid h-16 w-16 place-items-center rounded-full ${
            state === "done"
              ? "bg-emerald-400/15 text-emerald-300"
              : "bg-yellow-400/15 text-yellow-300"
          }`}
        >
          {state === "done" ? <CheckCircle2 className="h-8 w-8" /> : <MailX className="h-8 w-8" />}
        </span>
        <h1 className="mt-6 text-3xl font-black">
          {state === "done" ? "You’re unsubscribed" : "Stop marketing messages"}
        </h1>
        <p className="mt-3 text-sm leading-relaxed text-white/65">
          {state === "done"
            ? message
            : "Confirm below and Rapid Connect will suppress this address or number from future marketing campaigns. No login or additional information is required."}
        </p>
        {state !== "done" && (
          <button
            type="button"
            onClick={() => void unsubscribe()}
            disabled={!token || state === "working"}
            className="mt-7 inline-flex w-full items-center justify-center gap-2 rounded-xl bg-yellow-400 px-6 py-4 font-black text-slate-950 disabled:opacity-50"
          >
            {state === "working" && <Loader2 className="h-4 w-4 animate-spin" />}
            {state === "working" ? "Unsubscribing…" : "Unsubscribe me"}
          </button>
        )}
        {state === "error" && message && <p className="mt-4 text-sm text-red-300">{message}</p>}
        <p className="mt-6 text-xs text-white/38">
          Rapid Connect · This preference applies to future marketing messages.
        </p>
      </section>
    </main>
  );
}
