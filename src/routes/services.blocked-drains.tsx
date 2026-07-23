import { createFileRoute, Link } from "@tanstack/react-router";
import { AppShell } from "@/components/AppShell";
import { ArrowRight, Waves, Camera, Wrench } from "lucide-react";

export const Route = createFileRoute("/services/blocked-drains")({
  head: () => ({
    meta: [
      { title: "Blocked Drain Plumbers Melbourne — Richmond Rapid Plumbing" },
      { name: "description", content: "Blocked sinks, showers, toilets and sewer drains. Camera inspection, high-pressure jetting, up-front on-site estimates." },
      { property: "og:title", content: "Blocked Drain Plumbers — Richmond Rapid Plumbing" },
      { property: "og:description", content: "Fast blocked drain clearing across Richmond and Melbourne's inner east." },
    ],
  }),
  component: BlockedPage,
});

function BlockedPage() {
  return (
    <AppShell>
      <section className="border-b border-border">
        <div className="mx-auto max-w-4xl px-4 py-12">
          <div className="inline-flex items-center gap-2 rounded-full bg-primary/15 px-3 py-1 text-xs font-bold uppercase tracking-widest text-primary">
            <Waves className="h-3.5 w-3.5" /> Blocked drains
          </div>
          <h1 className="mt-3 text-4xl font-black sm:text-5xl">Slow drain? Backing up? Sorted.</h1>
          <p className="mt-3 max-w-2xl text-muted-foreground">
            From a slow shower to a full sewer blockage, we clear the lot. Camera inspection and high-pressure jetting for the tough ones — with a straight-up on-site estimate before we start.
          </p>
          <div className="mt-6 flex flex-col gap-3 sm:flex-row">
            <Link to="/request" className="inline-flex items-center justify-center gap-2 rounded-md bg-primary px-5 py-4 font-black text-primary-foreground">
              Start job request <ArrowRight className="h-5 w-5" />
            </Link>
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-4xl px-4 py-12">
        <h2 className="text-2xl font-black">Drains we clear every week</h2>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          {[
            ["Kitchen sink", "Fats and food scraps clogging the P-trap or stack"],
            ["Shower & basin", "Hair and soap build-up"],
            ["Toilet", "Wipes, paper build-up or vent issues"],
            ["Sewer & stormwater", "Tree roots, collapsed pipes, big blockages"],
          ].map(([t, d]) => (
            <div key={t} className="rounded-md border border-border bg-card p-4">
              <div className="font-bold">{t}</div>
              <div className="text-sm text-muted-foreground">{d}</div>
            </div>
          ))}
        </div>

        <h2 className="mt-10 text-2xl font-black">How we work</h2>
        <div className="mt-4 grid gap-4 sm:grid-cols-3">
          {[
            { icon: Wrench, t: "Diagnose", d: "Machine or camera down the line to find the actual cause." },
            { icon: Waves, t: "Clear", d: "Electric eel or high-pressure jetter depending on the blockage." },
            { icon: Camera, t: "Show you", d: "Camera footage so you can see what caused it and what's next." },
          ].map(({ icon: Icon, t, d }) => (
            <div key={t} className="rounded-lg border border-border bg-card p-5">
              <Icon className="h-5 w-5 text-primary" />
              <div className="mt-2 font-bold">{t}</div>
              <p className="mt-1 text-sm text-muted-foreground">{d}</p>
            </div>
          ))}
        </div>

        <p className="mt-8 text-xs text-muted-foreground">
          Every drain is different. We give an on-site estimate before starting — no surprise bills. Ongoing tree-root or collapsed-pipe issues might need a separate quote for repairs.
        </p>
      </section>
    </AppShell>
  );
}