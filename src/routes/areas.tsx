import { createFileRoute, Link } from "@tanstack/react-router";
import { AppShell } from "@/components/AppShell";
import { MapPin, Star, ArrowRight } from "lucide-react";

export const Route = createFileRoute("/areas")({
  head: () => ({
    meta: [
      { title: "Service areas & reviews — Richmond Rapid Plumbing" },
      { name: "description", content: "Local plumbers serving Richmond, Cremorne, South Yarra, Hawthorn, Abbotsford and Prahran. Read reviews from real jobs." },
      { property: "og:title", content: "Service areas & reviews — Richmond Rapid Plumbing" },
      { property: "og:description", content: "Fast, local plumbing across Melbourne's inner east." },
    ],
  }),
  component: AreasPage,
});

const AREAS = [
  { name: "Richmond", blurb: "Our home base — most jobs within 20 minutes." },
  { name: "Cremorne", blurb: "Warehouse conversions, cafés and townhouses." },
  { name: "South Yarra", blurb: "Apartments, older Victorians and hot water swaps." },
  { name: "Hawthorn", blurb: "Period homes, blocked drains and tree-root work." },
  { name: "Abbotsford", blurb: "Terraces, small businesses and gas fitting." },
  { name: "Prahran", blurb: "Apartments and shopfronts along Chapel St." },
];

const REVIEWS = [
  { name: "Sarah N.", area: "Richmond", stars: 5, text: "Rang after hours with a burst pipe — the AI thing had all my info sorted, plumber called back in 4 minutes and was here in 30. Legends." },
  { name: "Marcus O.", area: "South Yarra", stars: 5, text: "Old gas hot water died Sunday night. Sent the request, got a call-back Monday 8am, new unit in by lunch. Fair price too." },
  { name: "Priya S.", area: "Hawthorn", stars: 5, text: "Slow shower drain that everyone else quoted heaps for. Camera down the line, cleared it, showed me the footage. Honest crew." },
  { name: "Jack T.", area: "Abbotsford", stars: 5, text: "Cafe kitchen sink blocked mid-service. On site within 40 mins, back up and running. Saved our night." },
  { name: "Amelia K.", area: "Prahran", stars: 4, text: "Leaking tap that turned into a whole set of tapware. Explained the options clearly, no pressure to upgrade." },
  { name: "Dan H.", area: "Cremorne", stars: 5, text: "Warehouse fit-out plumbing done on time and to spec. Would use again." },
];

function AreasPage() {
  return (
    <AppShell>
      <section className="mx-auto max-w-5xl px-4 py-10">
        <div className="inline-flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-primary">
          <MapPin className="h-3.5 w-3.5" /> Melbourne inner east
        </div>
        <h1 className="mt-2 text-3xl font-black sm:text-4xl">Where we work</h1>
        <p className="mt-2 max-w-2xl text-muted-foreground">
          We stay local so we can get to you fast. If you're just outside these areas, still send a job request — we'll let you know if we can help.
        </p>

        <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {AREAS.map((a) => (
            <div key={a.name} className="rounded-lg border border-border bg-card p-5">
              <div className="flex items-center gap-2">
                <span className="grid h-9 w-9 place-items-center rounded-md bg-primary/15 text-primary">
                  <MapPin className="h-4 w-4" />
                </span>
                <div className="font-bold">{a.name}</div>
              </div>
              <p className="mt-2 text-sm text-muted-foreground">{a.blurb}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="border-t border-border bg-card/40">
        <div className="mx-auto max-w-5xl px-4 py-12">
          <div className="flex items-end justify-between gap-4">
            <div>
              <h2 className="text-2xl font-black sm:text-3xl">What the locals say</h2>
              <div className="mt-1 flex items-center gap-2 text-sm">
                <div className="flex text-primary">
                  {Array.from({ length: 5 }).map((_, i) => (
                    <Star key={i} className="h-4 w-4 fill-current" />
                  ))}
                </div>
                <span className="text-muted-foreground">4.9 average · 180+ reviews</span>
              </div>
            </div>
          </div>

          <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {REVIEWS.map((r, i) => (
              <div key={i} className="rounded-lg border border-border bg-card p-5">
                <div className="flex text-primary">
                  {Array.from({ length: r.stars }).map((_, j) => (
                    <Star key={j} className="h-4 w-4 fill-current" />
                  ))}
                </div>
                <p className="mt-2 text-sm">"{r.text}"</p>
                <div className="mt-3 text-xs text-muted-foreground">— {r.name}, {r.area}</div>
              </div>
            ))}
          </div>

          <div className="mt-8">
            <Link to="/request" className="inline-flex items-center justify-center gap-2 rounded-md bg-primary px-5 py-4 font-black text-primary-foreground">
              Send a job request <ArrowRight className="h-5 w-5" />
            </Link>
          </div>
        </div>
      </section>
    </AppShell>
  );
}