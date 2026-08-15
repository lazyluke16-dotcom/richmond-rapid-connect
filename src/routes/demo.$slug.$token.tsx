/**
 * Private personalised prospect demo — /demo/<slug>/<token>.
 *
 * Unlisted and access-controlled: it renders only when the slug + token resolve to a
 * live demo. It is marked `noindex, nofollow`, is not linked from any public navigation,
 * and exposes no prospect directory. Every business fact shown is evidence-backed; unknown
 * facts are disclosed, never invented. A clear disclosure states this is a private,
 * publicly-sourced preview that does not imply the business uses or endorses Rapid Connect.
 */
import { createFileRoute, notFound } from "@tanstack/react-router";
import { useState } from "react";
import { loadDemoView, type DemoViewData } from "@/lib/prospect/demo.functions";

export const Route = createFileRoute("/demo/$slug/$token")({
  head: ({ loaderData }) => {
    const name = (loaderData as DemoViewData | undefined)?.businessName;
    return {
      meta: [
        { title: name ? `${name} — Rapid Connect private demo` : "Private demo" },
        { name: "robots", content: "noindex, nofollow, noarchive" },
        { name: "referrer", content: "no-referrer" },
      ],
    };
  },
  loader: async ({ params }) => {
    const result = await loadDemoView({ data: { slug: params.slug, token: params.token } });
    if (!result.ok) throw notFound();
    return result.view;
  },
  component: DemoPage,
  notFoundComponent: DemoUnavailable,
});

function DemoUnavailable() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 p-6">
      <div className="max-w-md rounded-xl border border-slate-200 bg-white p-8 text-center shadow-sm">
        <h1 className="text-lg font-semibold text-slate-900">This demo isn&apos;t available</h1>
        <p className="mt-2 text-sm text-slate-600">
          The link may have expired or been revoked. Please request a fresh preview link.
        </p>
      </div>
    </main>
  );
}

interface ChatMessage {
  role: "visitor" | "receptionist";
  text: string;
}

function DemoPage() {
  // The loader throws notFound() unless it resolves, so DemoPage only renders with data.
  const view = Route.useLoaderData() as DemoViewData;
  const { slug, token } = Route.useParams();
  const c = view.colours;

  const [messages, setMessages] = useState<ChatMessage[]>([
    { role: "receptionist", text: view.greeting },
  ]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);

  async function send(text: string) {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    setMessages((prev) => [...prev, { role: "visitor", text: trimmed }]);
    setInput("");
    setBusy(true);
    try {
      const res = await fetch("/api/public/prospect/demo-reply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug, token, message: trimmed }),
      });
      const data = (await res.json()) as { reply?: string };
      setMessages((prev) => [
        ...prev,
        { role: "receptionist", text: data.reply ?? "Sorry, I couldn't process that just now." },
      ]);
    } catch {
      setMessages((prev) => [
        ...prev,
        { role: "receptionist", text: "Sorry, the demo line is unavailable right now." },
      ]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main
      className="min-h-screen bg-slate-50"
      style={{ ["--brand" as string]: c.primary, ["--brand-accent" as string]: c.accent }}
    >
      {/* Branded header */}
      <header className="px-6 py-8 text-white" style={{ backgroundColor: c.primary }}>
        <div className="mx-auto flex max-w-3xl items-center gap-4">
          {view.logoUrl ? (
            <img
              src={view.logoUrl}
              alt={`${view.businessName} logo`}
              className="h-12 w-auto rounded bg-white/90 p-1"
            />
          ) : view.faviconUrl ? (
            <img
              src={view.faviconUrl}
              alt={`${view.businessName} icon`}
              className="h-10 w-10 rounded bg-white/90 p-1"
            />
          ) : null}
          <div>
            <p className="text-xs uppercase tracking-wide text-white/70">
              Rapid Connect private demo
            </p>
            <h1 className="text-2xl font-semibold">{view.businessName}</h1>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-3xl px-6 py-8">
        {/* Disclosure banner */}
        <div className="mb-6 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          {view.disclosure}
        </div>

        <p className="mb-6 text-slate-700">
          This is how a Rapid Connect AI receptionist could answer calls for{" "}
          <strong>{view.businessName}</strong>, configured from information published on your
          website.
        </p>

        {/* Interactive shared-runtime demo */}
        <section className="mb-8 rounded-xl border border-slate-200 bg-white shadow-sm">
          <div className="border-b border-slate-100 px-4 py-3 text-sm font-medium text-slate-700">
            Try the AI receptionist
          </div>
          <div className="flex max-h-96 flex-col gap-3 overflow-y-auto p-4">
            {messages.map((message, index) => (
              <div
                key={index}
                className={
                  message.role === "visitor" ? "self-end text-right" : "self-start text-left"
                }
              >
                <div
                  className={
                    message.role === "visitor"
                      ? "inline-block rounded-2xl bg-slate-200 px-4 py-2 text-sm text-slate-800"
                      : "inline-block rounded-2xl px-4 py-2 text-sm text-white"
                  }
                  style={
                    message.role === "receptionist" ? { backgroundColor: c.accent } : undefined
                  }
                >
                  {message.text}
                </div>
              </div>
            ))}
          </div>
          <form
            className="flex gap-2 border-t border-slate-100 p-3"
            onSubmit={(event) => {
              event.preventDefault();
              void send(input);
            }}
          >
            <input
              value={input}
              onChange={(event) => setInput(event.target.value)}
              placeholder="Ask about a blocked drain, hours, or booking…"
              className="flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-500"
              aria-label="Message the demo receptionist"
            />
            <button
              type="submit"
              disabled={busy}
              className="rounded-lg px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
              style={{ backgroundColor: c.primary }}
            >
              Send
            </button>
          </form>
          {view.exampleEnquiries.length > 0 && (
            <div className="flex flex-wrap gap-2 px-3 pb-3">
              {view.exampleEnquiries.map((example) => (
                <button
                  key={example}
                  type="button"
                  onClick={() => void send(example)}
                  className="rounded-full border border-slate-300 px-3 py-1 text-xs text-slate-600 hover:bg-slate-100"
                >
                  {example}
                </button>
              ))}
            </div>
          )}
        </section>

        {/* Verified facts */}
        <section className="grid gap-4 sm:grid-cols-2">
          <FactCard
            title="Verified services"
            values={view.verifiedServices}
            emptyLabel="Not verified from public info"
          />
          <FactCard
            title="Verified service areas"
            values={view.verifiedServiceAreas}
            emptyLabel="Not verified from public info"
          />
          <SingleFactCard title="Emergency service" value={labelEmergency(view.emergencyService)} />
          <SingleFactCard
            title="Opening hours"
            value={view.openingHours === "UNKNOWN" ? "Not published" : view.openingHours}
          />
        </section>

        <p className="mt-8 text-center text-xs text-slate-400">
          Prepared by Rapid Connect from publicly available information. No contact has been made
          with this business.
        </p>
      </div>
    </main>
  );
}

function labelEmergency(value: DemoViewData["emergencyService"]): string {
  if (value === "yes") return "Yes — sourced from the website";
  if (value === "no") return "Not offered";
  return "Not confirmed";
}

function FactCard({
  title,
  values,
  emptyLabel,
}: {
  title: string;
  values: string[];
  emptyLabel: string;
}) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <h2 className="mb-2 text-sm font-semibold text-slate-800">{title}</h2>
      {values.length > 0 ? (
        <ul className="flex flex-wrap gap-2">
          {values.map((value) => (
            <li key={value} className="rounded-full bg-slate-100 px-3 py-1 text-xs text-slate-700">
              {value}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs italic text-slate-400">{emptyLabel}</p>
      )}
    </div>
  );
}

function SingleFactCard({ title, value }: { title: string; value: string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <h2 className="mb-1 text-sm font-semibold text-slate-800">{title}</h2>
      <p className="text-sm text-slate-700">{value}</p>
    </div>
  );
}
