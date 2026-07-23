import { createFileRoute, Link } from "@tanstack/react-router";
import { AppShell } from "@/components/AppShell";
import { AlertTriangle, Clock, Phone, ShieldCheck, ArrowRight } from "lucide-react";

export const Route = createFileRoute("/services/emergency")({
  head: () => ({
    meta: [
      { title: "24/7 Emergency Plumbers Melbourne — Richmond Rapid Plumbing" },
      { name: "description", content: "Burst pipes, no hot water, gas issues — 24/7 emergency plumbers across Richmond and Melbourne's inner east." },
      { property: "og:title", content: "24/7 Emergency Plumbers — Richmond Rapid Plumbing" },
      { property: "og:description", content: "Fast local response for burst pipes, blocked drains, gas leaks and no hot water." },
    ],
  }),
  component: EmergencyPage,
});

function EmergencyPage() {
  return (
    <AppShell>
      <section className="border-b border-border bg-destructive/10">
        <div className="mx-auto max-w-4xl px-4 py-12">
          <div className="inline-flex items-center gap-2 rounded-full bg-destructive/20 px-3 py-1 text-xs font-bold uppercase tracking-widest text-destructive">
            <AlertTriangle className="h-3.5 w-3.5" /> Emergency plumbing
          </div>
          <h1 className="mt-3 text-4xl font-black sm:text-5xl">Water everywhere? We're on the way.</h1>
          <p className="mt-3 max-w-2xl text-muted-foreground">
            24/7 emergency response across Richmond, Cremorne, South Yarra, Hawthorn, Abbotsford and Prahran. If it can't wait, don't wait — call us or send a job request in 60 seconds.
          </p>
          <div className="mt-6 flex flex-col gap-3 sm:flex-row">
            <a href="tel:1300000000" className="inline-flex items-center justify-center gap-2 rounded-md bg-destructive px-5 py-4 font-black text-destructive-foreground">
              <Phone className="h-5 w-5" /> Call now · 1300 000 000
            </a>
            <Link to="/request" className="inline-flex items-center justify-center gap-2 rounded-md bg-primary px-5 py-4 font-black text-primary-foreground">
              Start job request <ArrowRight className="h-5 w-5" />
            </Link>
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-4xl px-4 py-12">
        <h2 className="text-2xl font-black">What counts as an emergency?</h2>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          {[
            "Burst pipes or major water leaks",
            "No water at all to the property",
            "Sewage backing up into the house",
            "No hot water in winter",
            "Gas smell or suspected gas leak",
            "Overflowing or blocked toilets (only one on site)",
          ].map((t) => (
            <div key={t} className="rounded-md border border-border bg-card p-4 text-sm">✅ {t}</div>
          ))}
        </div>

        <h2 className="mt-10 text-2xl font-black">While you wait — quick tips</h2>
        <ol className="mt-4 space-y-3 text-sm">
          <li className="rounded-md border border-border bg-card p-4"><strong>1.</strong> Turn the water off at the mains (usually near the front tap or meter).</li>
          <li className="rounded-md border border-border bg-card p-4"><strong>2.</strong> If you smell gas, open windows, don't flick switches, and get outside if it's strong.</li>
          <li className="rounded-md border border-border bg-card p-4"><strong>3.</strong> Snap a photo or two — it helps us assess the job before we arrive.</li>
        </ol>

        <div className="mt-10 grid gap-4 sm:grid-cols-3">
          {[
            { icon: Clock, t: "Fast response", d: "Nearest van dispatched based on urgency." },
            { icon: ShieldCheck, t: "Licensed & insured", d: "Fully compliant Victorian plumbing licence." },
            { icon: Phone, t: "Call-back guaranteed", d: "Miss us? Send a request and we ring back." },
          ].map(({ icon: Icon, t, d }) => (
            <div key={t} className="rounded-lg border border-border bg-card p-5">
              <Icon className="h-5 w-5 text-primary" />
              <div className="mt-2 font-bold">{t}</div>
              <p className="mt-1 text-sm text-muted-foreground">{d}</p>
            </div>
          ))}
        </div>

        <p className="mt-8 text-xs text-muted-foreground">
          We don't give exact quotes over the phone for emergency work — the plumber confirms an estimate once they've seen the job. Call-out fees vary by time of day.
        </p>
      </section>
    </AppShell>
  );
}