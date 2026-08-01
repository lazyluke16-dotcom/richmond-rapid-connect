import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowRight,
  Bot,
  Check,
  ClipboardList,
  MessageSquareText,
  PhoneCall,
  Play,
  ShieldCheck,
  Wrench,
} from "lucide-react";
import heroPlumberAvif from "@/assets/hero-plumber.avif";
import heroPlumber from "@/assets/hero-plumber.jpg";
import heroPlumberWebp from "@/assets/hero-plumber.webp";
import { DemoCommercial } from "@/components/acquisition/DemoCommercial";
import { AcquisitionWizard } from "@/components/acquisition/AcquisitionWizard";
import {
  ACQUISITION_PLANS,
  ACQUISITION_SESSION_KEY,
  ACQUISITION_STORAGE_KEY,
  DEFAULT_PROMO_CODE,
  createDefaultAcquisitionDraft,
  calculateAcquisitionRoi,
  getAcquisitionAttribution,
  moneyFromCents,
  normalizePromoCode,
  readAcquisitionDraft,
  type AcquisitionEventName,
  type AcquisitionPlan,
  type AcquisitionSignupDraft,
} from "@/lib/acquisition";

export const Route = createFileRoute("/plumbers")({
  head: () => ({
    meta: [
      { title: "Turn missed calls into plumbing jobs — Rapid Connect" },
      {
        name: "description",
        content:
          "Compare Missed-Call Recovery and AI Receptionist, see the founding offer, and set up your first captured test job.",
      },
    ],
  }),
  validateSearch: (search: Record<string, unknown>) => {
    const value = (key: string) =>
      typeof search[key] === "string" ? (search[key] as string).slice(0, 120) : undefined;
    return {
      code: value("code"),
      source: value("source"),
      medium: value("medium"),
      campaign: value("campaign"),
      content: value("content"),
      utm_source: value("utm_source"),
      utm_medium: value("utm_medium"),
      utm_campaign: value("utm_campaign"),
      utm_content: value("utm_content"),
      ref: value("ref"),
      resume: value("resume"),
    };
  },
  component: PlumberAcquisitionPage,
});

const SERVICES = ["missed_call_recovery", "ai_receptionist"] as const;

function PlumberAcquisitionPage() {
  const search = Route.useSearch();
  const attribution = useMemo(() => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(search)) if (value) params.set(key, value);
    return getAcquisitionAttribution(params);
  }, [search]);
  const fallbackDraft = useMemo(
    () =>
      createDefaultAcquisitionDraft(
        attribution,
        normalizePromoCode(search.code ?? DEFAULT_PROMO_CODE),
      ),
    [attribution, search.code],
  );

  const [draft, setDraft] = useState<AcquisitionSignupDraft>(fallbackDraft);
  const [sessionId, setSessionId] = useState("");
  const [demoOpen, setDemoOpen] = useState(false);
  const [wizardOpen, setWizardOpen] = useState(search.resume === "signup");
  const [jobValue, setJobValue] = useState(350);
  const landingTracked = useRef(false);
  const comparisonTracked = useRef(false);

  useEffect(() => {
    const existingSession = sessionStorage.getItem(ACQUISITION_SESSION_KEY);
    const id = existingSession || crypto.randomUUID();
    if (!existingSession) sessionStorage.setItem(ACQUISITION_SESSION_KEY, id);
    setSessionId(id);
    setDraft(readAcquisitionDraft(localStorage.getItem(ACQUISITION_STORAGE_KEY), fallbackDraft));
  }, [fallbackDraft]);

  const track = useCallback(
    (
      eventName: AcquisitionEventName,
      details?: { plan?: AcquisitionSignupDraft["plan"]; wizardStep?: number },
    ) => {
      if (!sessionId) return;
      void fetch("/api/public/acquisition", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "track",
          eventId: crypto.randomUUID(),
          sessionId,
          eventName,
          path: "/plumbers",
          plan: details?.plan ?? draft.plan,
          promoCode: draft.promoCode,
          wizardStep: details?.wizardStep ?? null,
          attribution,
        }),
        keepalive: true,
      }).catch(() => undefined);
    },
    [attribution, draft.plan, draft.promoCode, sessionId],
  );

  useEffect(() => {
    if (!sessionId || landingTracked.current) return;
    landingTracked.current = true;
    track("landing_viewed");
  }, [sessionId, track]);

  const persistDraft = (next: AcquisitionSignupDraft) => {
    setDraft(next);
    localStorage.setItem(ACQUISITION_STORAGE_KEY, JSON.stringify(next));
  };

  const selectPlan = (plan: AcquisitionPlan) => {
    persistDraft({ ...draft, plan });
    track("service_selected", { plan, wizardStep: 0 });
    track("package_selected", { plan, wizardStep: 0 });
  };

  const openDemo = () => {
    track("demo_started");
    setDemoOpen(true);
  };

  const openWizard = () => {
    track("signup_opened", { plan: draft.plan, wizardStep: draft.step });
    setWizardOpen(true);
  };

  const plan = ACQUISITION_PLANS[draft.plan];
  const roi = calculateAcquisitionRoi(jobValue, draft.plan);

  return (
    <main className="acquisition-experience min-h-dvh overflow-x-hidden bg-[#07111a] text-white">
      <header className="absolute inset-x-0 top-0 z-30">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-5 py-5 sm:px-8">
          <a href="/plumbers" className="flex items-center gap-3" aria-label="Rapid Connect home">
            <span className="grid h-10 w-10 place-items-center rounded-xl bg-yellow-400 text-slate-950">
              <Wrench className="h-5 w-5" aria-hidden="true" />
            </span>
            <span>
              <span className="block text-sm font-black tracking-tight">RAPID CONNECT</span>
              <span className="block text-[9px] font-bold uppercase tracking-[0.24em] text-white/50">
                Built for plumbers
              </span>
            </span>
          </a>
          <a
            href="/auth"
            className="rounded-lg px-3 py-2 text-sm font-bold text-white/75 outline-none hover:text-white focus-visible:ring-2 focus-visible:ring-yellow-300"
          >
            Log in
          </a>
        </div>
      </header>

      <section className="relative isolate min-h-dvh overflow-hidden px-5 pb-14 pt-28 sm:px-8 lg:pt-32">
        <picture className="absolute inset-0 -z-20 opacity-35">
          <source srcSet={heroPlumberAvif} type="image/avif" />
          <source srcSet={heroPlumberWebp} type="image/webp" />
          <img src={heroPlumber} alt="" className="h-full w-full object-cover object-center" />
        </picture>
        <div className="absolute inset-0 -z-10 bg-[linear-gradient(90deg,#07111a_0%,rgba(7,17,26,.96)_48%,rgba(7,17,26,.7)_100%)]" />
        <div className="mx-auto grid max-w-7xl items-center gap-10 lg:grid-cols-[1.05fr_.95fr]">
          <div className="max-w-2xl">
            <div className="inline-flex items-center gap-2 rounded-full border border-yellow-300/30 bg-yellow-300/10 px-3 py-1.5 text-xs font-black uppercase tracking-[.16em] text-yellow-300">
              <PhoneCall className="h-4 w-4" /> One simple job inbox
            </div>
            <h1 className="mt-5 text-balance text-4xl font-black leading-[.98] tracking-[-.045em] sm:text-6xl">
              Two simple ways to stop calls becoming{" "}
              <span className="text-yellow-300">lost jobs.</span>
            </h1>
            <p className="mt-5 max-w-xl text-base leading-relaxed text-white/72 sm:text-lg">
              Missed-Call Recovery follows up after you miss a call. AI Receptionist answers the
              call for you. Both put the captured opportunity in Missed Jobs.
            </p>
            <div className="mt-6 grid gap-3 sm:grid-cols-2">
              <HeroService icon={MessageSquareText} title="Missed-Call Recovery" price="A$9/mo">
                Missed call → immediate customer text
              </HeroService>
              <HeroService icon={Bot} title="AI Receptionist" price="A$15/mo">
                Incoming call → AI answers 24/7
              </HeroService>
            </div>
            <button
              type="button"
              onClick={openDemo}
              className="mt-7 inline-flex min-h-14 w-full items-center justify-center gap-3 rounded-xl bg-yellow-400 px-6 text-base font-black text-slate-950 shadow-[0_20px_60px_rgba(250,204,21,.2)] outline-none transition hover:bg-yellow-300 focus-visible:ring-4 focus-visible:ring-yellow-200/50 sm:w-auto"
            >
              <Play className="h-5 w-5 fill-current" /> See how it works
            </button>
            <p className="mt-3 text-sm font-bold text-white/65">
              No sign-on fee · First 3 subscription months free · Usage applies from day one ·
              Cancel anytime
            </p>
          </div>

          <div className="rounded-[2rem] border border-white/12 bg-slate-950/75 p-5 shadow-2xl backdrop-blur sm:p-7">
            <div className="text-xs font-black uppercase tracking-[.2em] text-yellow-300">
              What happens to the call?
            </div>
            <div className="mt-5 space-y-3">
              <CallPath
                step="1"
                title="A customer needs a plumber"
                detail="They call your business number."
              />
              <div className="ml-5 h-4 border-l border-dashed border-white/25" />
              <CallPath
                step="2"
                title="Your chosen service responds"
                detail="An immediate follow-up text after a missed call, or an AI that answers."
              />
              <div className="ml-5 h-4 border-l border-dashed border-white/25" />
              <CallPath
                step="3"
                title="A useful job lands in Missed Jobs"
                detail="Customer, suburb, job, urgency and callback details—ready for you."
                final
              />
            </div>
            <div className="mt-6 rounded-xl bg-emerald-400/12 p-4 text-sm text-emerald-100">
              <b>A typical A$350 job</b> could cover about 38 months of A$9 Missed-Call Recovery
              subscription fees, excluding variable usage.
            </div>
          </div>
        </div>
      </section>

      <section
        id="compare"
        className="bg-white px-5 py-16 text-slate-950 sm:px-8 sm:py-24"
        ref={(node) => {
          if (!node || comparisonTracked.current) return;
          const observer = new IntersectionObserver(([entry]) => {
            if (entry.isIntersecting) {
              comparisonTracked.current = true;
              track("service_comparison_viewed");
              observer.disconnect();
            }
          });
          observer.observe(node);
        }}
      >
        <div className="mx-auto max-w-6xl">
          <div className="max-w-2xl">
            <div className="text-xs font-black uppercase tracking-[.2em] text-sky-700">
              Choose by what happens to the call
            </div>
            <h2 className="mt-3 text-3xl font-black tracking-tight sm:text-5xl">
              One follows up. One answers.
            </h2>
          </div>
          <div className="mt-9 grid gap-5 lg:grid-cols-2">
            {SERVICES.map((service) => (
              <ServiceCard
                key={service}
                service={service}
                selected={draft.plan === service || draft.plan === "both"}
                onSelect={() => selectPlan(service)}
              />
            ))}
          </div>
          <button
            type="button"
            onClick={() => selectPlan("both")}
            aria-pressed={draft.plan === "both"}
            className={`mt-5 flex w-full flex-col justify-between gap-3 rounded-2xl border p-5 text-left outline-none transition focus-visible:ring-4 focus-visible:ring-yellow-300/50 sm:flex-row sm:items-center ${
              draft.plan === "both"
                ? "border-yellow-500 bg-yellow-50"
                : "border-slate-200 hover:border-yellow-500"
            }`}
          >
            <span>
              <span className="block text-lg font-black">Use both services</span>
              <span className="mt-1 block text-sm text-slate-600">
                AI answers configured calls; Missed-Call Recovery follows up calls that are still
                missed. Both feed the same inbox.
              </span>
            </span>
            <span className="shrink-0 text-xl font-black">A$24/month normally</span>
          </button>
        </div>
      </section>

      <section className="bg-[#dff3ff] px-5 py-16 text-slate-950 sm:px-8 sm:py-24">
        <div className="mx-auto grid max-w-6xl gap-9 lg:grid-cols-[.8fr_1.2fr] lg:items-center">
          <div>
            <div className="text-xs font-black uppercase tracking-[.2em] text-sky-800">
              Cost of one missed job
            </div>
            <h2 className="mt-3 text-3xl font-black tracking-tight sm:text-5xl">
              Put your own job value in.
            </h2>
            <p className="mt-4 text-slate-600">
              This is a simple comparison, not an income promise. It assumes one job would otherwise
              have been lost and excludes variable usage charges.
            </p>
          </div>
          <div className="rounded-3xl border border-sky-200 bg-white p-5 shadow-xl sm:p-7">
            <label className="block font-black" htmlFor="job-value">
              My typical plumbing job is worth
            </label>
            <div className="mt-3 flex items-center gap-3">
              <span className="text-2xl font-black">A$</span>
              <input
                id="job-value"
                type="number"
                min={50}
                max={10000}
                step={25}
                value={jobValue}
                onChange={(event) => {
                  setJobValue(Math.max(50, Number(event.currentTarget.value) || 50));
                  track("roi_calculator_used");
                }}
                className="min-w-0 flex-1 rounded-xl border border-slate-300 px-4 py-3 text-2xl font-black outline-none focus:ring-4 focus:ring-sky-200"
              />
            </div>
            <div className="mt-5 grid gap-3 sm:grid-cols-3">
              <Metric
                label="Normal monthly subscription"
                value={moneyFromCents(plan.platformFeeCents)}
              />
              <Metric
                label="Approx. ahead after one job"
                value={`A$${roi.approximateAmountAheadAud.toFixed(0)}`}
              />
              <Metric label="Months one job could cover" value={`About ${roi.monthsCovered}`} />
            </div>
            <p className="mt-5 text-sm leading-relaxed text-slate-600">
              Your typical job is worth A${jobValue}. {plan.name} normally costs{" "}
              {moneyFromCents(plan.platformFeeCents)} per month. Recovering one job that would
              otherwise have been lost could cover about {roi.monthsCovered} months of subscription
              fees. Usage charges are separate: recovery SMS is A$0.25 ex GST per accepted SMS; AI
              voice is A$0.59 per minute plus applicable SMS usage.
            </p>
          </div>
        </div>
      </section>

      <section className="px-5 py-16 sm:px-8 sm:py-24">
        <div className="mx-auto grid max-w-6xl gap-8 lg:grid-cols-2 lg:items-center">
          <div>
            <div className="text-xs font-black uppercase tracking-[.2em] text-yellow-300">
              Safe product demonstration
            </div>
            <h2 className="mt-3 text-3xl font-black tracking-tight sm:text-5xl">
              Watch the whole captured-job outcome.
            </h2>
            <p className="mt-4 text-white/68">
              This is a clearly labelled simulation. It shows the customer contact, captured
              details, plumber alert and final Missed Jobs entry. It does not contact a real
              customer or turn on a real service.
            </p>
            <button
              type="button"
              onClick={openDemo}
              className="mt-6 inline-flex min-h-12 items-center gap-2 rounded-xl border border-white/20 px-5 font-black outline-none hover:border-yellow-300 focus-visible:ring-4 focus-visible:ring-yellow-300/40"
            >
              <Play className="h-4 w-4 fill-current" /> Start the simulated demo
            </button>
          </div>
          <div className="rounded-3xl border border-yellow-300/25 bg-yellow-300/10 p-6 sm:p-8">
            <div className="flex items-center gap-3 text-yellow-300">
              <ShieldCheck className="h-7 w-7" />
              <span className="font-black uppercase tracking-widest">FOUNDINGPLUMBER</span>
            </div>
            <h3 className="mt-5 text-3xl font-black">No sign-on fee.</h3>
            <p className="mt-2 text-xl font-black">
              Your first 3 months of subscription fees are free.
            </p>
            <ul className="mt-5 space-y-3 text-sm text-white/75">
              <li className="flex gap-2">
                <Check className="h-5 w-5 text-yellow-300" /> A$499 sign-on fee becomes A$0
              </li>
              <li className="flex gap-2">
                <Check className="h-5 w-5 text-yellow-300" /> Usage charges apply from activation
              </li>
              <li className="flex gap-2">
                <Check className="h-5 w-5 text-yellow-300" /> Normal pricing is A$9, A$15 or
                A$24/month
              </li>
              <li className="flex gap-2">
                <Check className="h-5 w-5 text-yellow-300" /> Cancel anytime
              </li>
            </ul>
            <button
              type="button"
              onClick={openWizard}
              className="mt-7 inline-flex min-h-14 w-full items-center justify-center gap-2 rounded-xl bg-yellow-400 px-6 font-black text-slate-950 outline-none hover:bg-yellow-300 focus-visible:ring-4 focus-visible:ring-yellow-200/50"
            >
              Set up my service <ArrowRight className="h-5 w-5" />
            </button>
          </div>
        </div>
      </section>

      <footer className="border-t border-white/10 px-5 py-8 text-center text-xs text-white/45">
        Rapid Connect · Prices in AUD · Variable usage is disclosed before activation
      </footer>

      <DemoCommercial
        open={demoOpen}
        onClose={() => setDemoOpen(false)}
        onTrack={track}
        onSignup={() => {
          setDemoOpen(false);
          openWizard();
        }}
      />
      <AcquisitionWizard
        open={wizardOpen}
        initialDraft={draft}
        sessionId={sessionId}
        onClose={() => setWizardOpen(false)}
        onDraftChange={persistDraft}
        onTrack={track}
      />
    </main>
  );
}

function HeroService({
  icon: Icon,
  title,
  price,
  children,
}: {
  icon: typeof PhoneCall;
  title: string;
  price: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-white/12 bg-black/25 p-4 backdrop-blur">
      <div className="flex items-center justify-between gap-3">
        <Icon className="h-5 w-5 text-yellow-300" />
        <span className="font-black text-yellow-300">{price}</span>
      </div>
      <div className="mt-3 font-black">{title}</div>
      <div className="mt-1 text-xs text-white/60">{children}</div>
    </div>
  );
}

function CallPath({
  step,
  title,
  detail,
  final = false,
}: {
  step: string;
  title: string;
  detail: string;
  final?: boolean;
}) {
  return (
    <div
      className={`flex gap-4 rounded-xl border p-4 ${final ? "border-emerald-400/30 bg-emerald-400/10" : "border-white/10 bg-white/[.04]"}`}
    >
      <span
        className={`grid h-10 w-10 shrink-0 place-items-center rounded-full font-black ${final ? "bg-emerald-400 text-slate-950" : "bg-white/10"}`}
      >
        {final ? <ClipboardList className="h-5 w-5" /> : step}
      </span>
      <span>
        <span className="block font-black">{title}</span>
        <span className="mt-1 block text-sm text-white/60">{detail}</span>
      </span>
    </div>
  );
}

function ServiceCard({
  service,
  selected,
  onSelect,
}: {
  service: (typeof SERVICES)[number];
  selected: boolean;
  onSelect: () => void;
}) {
  const config = ACQUISITION_PLANS[service];
  const Icon = service === "missed_call_recovery" ? MessageSquareText : Bot;
  return (
    <article
      className={`rounded-3xl border p-6 ${selected ? "border-sky-500 bg-sky-50" : "border-slate-200"}`}
    >
      <div className="flex items-start justify-between gap-4">
        <span className="grid h-12 w-12 place-items-center rounded-xl bg-slate-950 text-yellow-300">
          <Icon className="h-6 w-6" />
        </span>
        <span className="text-2xl font-black">{moneyFromCents(config.platformFeeCents)}/mo</span>
      </div>
      <h3 className="mt-5 text-2xl font-black">{config.name}</h3>
      <p className="mt-3 leading-relaxed text-slate-600">{config.explanation}</p>
      <div className="mt-5 rounded-xl bg-slate-100 p-3 text-sm font-bold">
        {service === "missed_call_recovery"
          ? "It does not answer the original call. It follows up after the call is missed."
          : "It answers the original call and speaks with the customer."}
      </div>
      <p className="mt-4 text-xs text-slate-500">{config.usage}</p>
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={selected}
        className="mt-5 min-h-11 w-full rounded-xl border border-slate-300 px-4 font-black outline-none hover:border-sky-600 focus-visible:ring-4 focus-visible:ring-sky-200"
      >
        {selected ? "Selected" : `Choose ${config.name}`}
      </button>
    </article>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-slate-950 p-4 text-white">
      <div className="text-xs text-white/55">{label}</div>
      <div className="mt-2 text-2xl font-black text-yellow-300">{value}</div>
    </div>
  );
}
