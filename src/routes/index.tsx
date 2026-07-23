import { createFileRoute } from "@tanstack/react-router";
import { Link } from "@tanstack/react-router";
import { AppShell } from "@/components/AppShell";
import heroImg from "@/assets/hero-plumber.jpg";
import { Phone, Clock, MapPin, ShieldCheck, Wrench, Droplets, Flame, ArrowRight, Star } from "lucide-react";

export const Route = createFileRoute("/")({
  component: Index,
});

function Index() {
  return (
    <AppShell>
      {/* Hero */}
      <section className="relative overflow-hidden">
        <div className="absolute inset-0">
          <img
            src={heroImg}
            alt="Local Melbourne plumber ready to help"
            width={1600}
            height={1200}
            className="h-full w-full object-cover opacity-40"
          />
          <div className="absolute inset-0" style={{ background: "linear-gradient(180deg, rgba(15,20,35,0.7) 0%, rgba(15,20,35,0.95) 100%)" }} />
        </div>
        <div className="relative mx-auto max-w-5xl px-4 pt-10 pb-16 sm:pt-16 sm:pb-24">
          <span className="inline-flex items-center gap-2 rounded-full border border-primary/40 bg-primary/10 px-3 py-1 text-xs font-bold uppercase tracking-widest text-primary">
            <span className="inline-block h-2 w-2 rounded-full bg-primary animate-pulse" /> On the tools right now
          </span>
          <p className="mt-4 text-2xl font-black uppercase tracking-wider text-primary animate-pulse sm:text-4xl">We missed your call!!</p>
          <h1 className="mt-4 text-4xl font-black leading-[1.05] sm:text-6xl">
            <span className="text-primary">Send the job in 60 seconds.</span>
            <Clock className="ml-2 inline-block h-8 w-8 text-primary align-baseline [animation:spin_0.8s_linear_infinite] sm:h-12 sm:w-12" />
          </h1>
          <p className="mt-4 max-w-xl text-base text-muted-foreground sm:text-lg">
            Local Melbourne plumbers covering Richmond, Cremorne, South Yarra, Hawthorn, Abbotsford and Prahran. Fair pricing, no BS, licensed and insured.
          </p>

          <div className="mt-6 flex flex-col gap-3 sm:flex-row">
            <Link
              to="/request"
              className="inline-flex items-center justify-center gap-2 rounded-md bg-primary px-5 py-4 text-base font-black text-primary-foreground shadow-[var(--shadow-glow)] hover:brightness-110 pulse-ring"
            >
              Start job request <ArrowRight className="h-5 w-5" />
            </Link>
            <a
              href="tel:1300000000"
              className="inline-flex items-center justify-center gap-2 rounded-md border border-border bg-card px-5 py-4 text-base font-bold text-foreground hover:bg-secondary pulse-ring"
            >
              <Phone className="h-5 w-5" /> Call 1300 000 000
            </a>
          </div>

          <div className="mt-8 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
            {[
              { icon: Clock, label: "24/7 emergency" },
              { icon: MapPin, label: "Inner-east Melb" },
              { icon: ShieldCheck, label: "Licensed & insured" },
              { icon: Star, label: "4.9 ★ Google" },
            ].map(({ icon: Icon, label }) => (
              <div key={label} className="flex items-center gap-2 rounded-md border border-border bg-card/60 px-3 py-2">
                <Icon className="h-4 w-4 text-primary shrink-0" />
                <span className="truncate">{label}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Common jobs */}
      <section className="mx-auto max-w-5xl px-4 py-12">
        <h2 className="text-2xl font-black sm:text-3xl">What's the drama?</h2>
        <p className="mt-1 text-muted-foreground">Tap the closest one — we'll ask a couple of quick questions.</p>
        <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3">
          {[
            { icon: Droplets, label: "Burst pipe / leak" },
            { icon: Wrench, label: "Blocked drain" },
            { icon: Flame, label: "No hot water" },
            { icon: Droplets, label: "Leaking tap" },
            { icon: Wrench, label: "Toilet problem" },
            { icon: Flame, label: "Gas issue" },
          ].map(({ icon: Icon, label }) => (
            <Link
              key={label}
              to="/request"
              className="group flex items-center gap-3 rounded-lg border border-border bg-card p-4 hover:border-primary hover:bg-secondary"
            >
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-md bg-primary/15 text-primary">
                <Icon className="h-5 w-5" />
              </span>
              <span className="min-w-0 flex-1 font-semibold">{label}</span>
              <ArrowRight className="h-4 w-4 text-muted-foreground group-hover:text-primary" />
            </Link>
          ))}
        </div>
      </section>

      {/* How it works */}
      <section className="border-y border-border bg-card/40">
        <div className="mx-auto max-w-5xl px-4 py-12">
          <h2 className="text-2xl font-black sm:text-3xl">How the AI receptionist works</h2>
          <p className="mt-1 max-w-2xl text-muted-foreground">
            When we're on the tools, we can't always answer. Our AI asks the same questions we would — so the plumber can assess the job before calling you back.
          </p>
          <div className="mt-6 grid gap-4 sm:grid-cols-3">
            {[
              { n: "1", t: "Tell us the job", d: "Pick the issue, suburb, urgency and property type." },
              { n: "2", t: "Chat a few details", d: "The AI asks smart follow-ups and lets you attach photos." },
              { n: "3", t: "We call you back", d: "The plumber sees your summary and rings when free." },
            ].map((s) => (
              <div key={s.n} className="rounded-lg border border-border bg-card p-5">
                <div className="grid h-9 w-9 place-items-center rounded-full bg-primary font-black text-primary-foreground">{s.n}</div>
                <div className="mt-3 font-bold">{s.t}</div>
                <p className="mt-1 text-sm text-muted-foreground">{s.d}</p>
              </div>
            ))}
          </div>
          <p className="mt-6 text-xs text-muted-foreground">
            Prices are always confirmed by the plumber — we don't promise exact quotes from the chat. It just helps us give you a fast, informed call-back.
          </p>
        </div>
      </section>

      {/* Areas + reviews teaser */}
      <section className="mx-auto max-w-5xl px-4 py-12">
        <div className="grid gap-8 sm:grid-cols-2">
          <div>
            <h2 className="text-2xl font-black">Local to the inner east</h2>
            <p className="mt-1 text-muted-foreground">Same-day service across Richmond, Cremorne, South Yarra, Hawthorn, Abbotsford and Prahran.</p>
            <Link to="/areas" className="mt-4 inline-flex items-center gap-2 text-sm font-bold text-primary hover:underline">
              See service areas & reviews <ArrowRight className="h-4 w-4" />
            </Link>
          </div>
          <blockquote className="rounded-lg border border-border bg-card p-5">
            <div className="flex text-primary">
              {Array.from({ length: 5 }).map((_, i) => (
                <Star key={i} className="h-4 w-4 fill-current" />
              ))}
            </div>
            <p className="mt-2 text-sm">
              "Rang after hours with a burst pipe — the AI thing had all my info sorted, plumber called back in 4 minutes and was here in 30. Legends."
            </p>
            <footer className="mt-2 text-xs text-muted-foreground">— Sarah N., Richmond</footer>
          </blockquote>
        </div>
      </section>
    </AppShell>
  );
}
