import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, Check, PhoneCall, Play, ShieldCheck, Sparkles, Wrench } from "lucide-react";
import heroPlumber from "@/assets/hero-plumber.jpg";
import { DemoCommercial } from "@/components/acquisition/DemoCommercial";
import { AcquisitionWizard } from "@/components/acquisition/AcquisitionWizard";
import {
  ACQUISITION_PLANS,
  ACQUISITION_SESSION_KEY,
  ACQUISITION_STORAGE_KEY,
  DEFAULT_PROMO_CODE,
  createDefaultAcquisitionDraft,
  getAcquisitionAttribution,
  moneyFromCents,
  normalizePromoCode,
  readAcquisitionDraft,
  type AcquisitionEventName,
  type AcquisitionSignupDraft,
} from "@/lib/acquisition";

export const Route = createFileRoute("/plumbers")({
  head: () => ({
    meta: [
      { title: "Stop losing plumbing jobs — Rapid Connect" },
      {
        name: "description",
        content:
          "See how Rapid Connect’s Text and AI Receptionists turn missed calls into complete plumbing leads.",
      },
      { property: "og:title", content: "Keep working. Keep answering. Stop losing good jobs." },
      {
        property: "og:description",
        content:
          "Watch the one-minute Rapid Connect demo and claim the founding plumber setup offer.",
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

function PlumberAcquisitionPage() {
  const search = Route.useSearch();
  const attribution = useMemo(() => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(search)) {
      if (value) params.set(key, value);
    }
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
  const landingTracked = useRef(false);

  useEffect(() => {
    const existingSession = sessionStorage.getItem(ACQUISITION_SESSION_KEY);
    const id = existingSession || crypto.randomUUID();
    if (!existingSession) sessionStorage.setItem(ACQUISITION_SESSION_KEY, id);
    setSessionId(id);
    const stored = localStorage.getItem(ACQUISITION_STORAGE_KEY);
    setDraft(readAcquisitionDraft(stored, fallbackDraft));
  }, [fallbackDraft]);

  const track = useCallback(
    (
      eventName: AcquisitionEventName,
      details?: { plan?: AcquisitionSignupDraft["plan"]; wizardStep?: number },
    ) => {
      if (!sessionId) return;
      const body = {
        action: "track",
        eventId: crypto.randomUUID(),
        sessionId,
        eventName,
        path: "/plumbers",
        plan: details?.plan ?? draft.plan,
        promoCode: draft.promoCode,
        wizardStep: details?.wizardStep ?? null,
        attribution,
      };
      void fetch("/api/public/acquisition", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
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

  const openDemo = () => {
    track("demo_started");
    setDemoOpen(true);
    void document.documentElement.requestFullscreen?.().catch(() => undefined);
  };

  const openWizard = () => {
    track("signup_opened", { plan: draft.plan, wizardStep: draft.step });
    setWizardOpen(true);
  };

  return (
    <main className="min-h-dvh overflow-x-hidden bg-[#091019] text-white">
      <header className="absolute inset-x-0 top-0 z-20">
        <div className="mx-auto flex max-w-[1500px] items-center justify-between px-5 py-5 sm:px-8">
          <a href="/plumbers" className="flex items-center gap-3" aria-label="Rapid Connect home">
            <span className="grid h-10 w-10 place-items-center rounded-xl bg-yellow-400 text-slate-950">
              <PhoneCall className="h-5 w-5" />
            </span>
            <div>
              <div className="text-sm font-black tracking-tight">RAPID CONNECT</div>
              <div className="text-[9px] font-bold uppercase tracking-[0.24em] text-white/45">
                Built for plumbers
              </div>
            </div>
          </a>
          <button
            type="button"
            onClick={openWizard}
            className="hidden rounded-full border border-white/15 bg-white/[0.06] px-5 py-2.5 text-sm font-black backdrop-blur transition hover:border-yellow-300/60 sm:block"
          >
            Claim $0 setup
          </button>
        </div>
      </header>

      <section className="grid min-h-dvh lg:grid-cols-2">
        <div className="relative flex min-h-[74vh] items-end overflow-hidden px-5 pb-12 pt-28 sm:px-10 sm:pb-16 lg:min-h-dvh lg:px-14 xl:px-20">
          <img
            src={heroPlumber}
            alt=""
            className="absolute inset-0 h-full w-full object-cover object-center"
          />
          <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(5,10,16,0.32)_0%,rgba(5,10,16,0.58)_40%,rgba(5,10,16,0.97)_100%)] lg:bg-[linear-gradient(90deg,rgba(5,10,16,0.35)_0%,rgba(5,10,16,0.72)_70%,rgba(5,10,16,0.98)_100%)]" />
          <div className="absolute left-8 top-28 hidden h-24 w-24 rounded-full border border-yellow-300/20 bg-yellow-400/10 blur-2xl sm:block" />

          <div className="relative z-10 max-w-2xl">
            <div className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-black/25 px-3 py-1.5 text-[10px] font-black uppercase tracking-[0.2em] text-yellow-300 backdrop-blur">
              <Wrench className="h-3.5 w-3.5" /> See it in action
            </div>
            <h1 className="mt-5 text-balance text-4xl font-black leading-[0.98] tracking-[-0.04em] sm:text-6xl xl:text-7xl">
              Stop losing good jobs because you’re{" "}
              <span className="text-yellow-300">on the tools.</span>
            </h1>
            <p className="mt-5 max-w-xl text-base leading-relaxed text-white/68 sm:text-lg">
              See how a missed call becomes a complete lead—and how an AI receptionist answers
              naturally when you can’t.
            </p>
            <button
              type="button"
              onClick={openDemo}
              className="group mt-8 inline-flex w-full items-center justify-center gap-4 rounded-2xl bg-white px-6 py-5 text-left text-slate-950 shadow-[0_25px_80px_rgba(0,0,0,0.35)] transition hover:-translate-y-0.5 sm:w-auto sm:min-w-[310px]"
            >
              <span className="grid h-12 w-12 shrink-0 place-items-center rounded-full bg-yellow-400 transition group-hover:scale-105">
                <Play className="ml-1 h-5 w-5 fill-current" />
              </span>
              <span>
                <span className="block text-lg font-black">Watch the one-minute demo</span>
                <span className="mt-0.5 block text-xs font-medium text-slate-500">
                  Text + AI Receptionist in action
                </span>
              </span>
            </button>
          </div>
        </div>

        <div className="relative flex min-h-[78vh] items-center overflow-hidden border-t border-white/10 bg-[radial-gradient(circle_at_100%_0%,rgba(250,204,21,0.12),transparent_34%),#0b131d] px-5 py-14 sm:px-10 lg:min-h-dvh lg:border-l lg:border-t-0 lg:px-14 xl:px-20">
          <div className="mx-auto w-full max-w-xl">
            <div className="inline-flex items-center gap-2 rounded-full bg-yellow-400 px-3 py-1.5 text-[10px] font-black uppercase tracking-[0.18em] text-slate-950">
              <Sparkles className="h-3.5 w-3.5" /> Founding plumber offer
            </div>
            <h2 className="mt-5 text-balance text-4xl font-black leading-[1.02] tracking-[-0.035em] sm:text-5xl xl:text-6xl">
              Your receptionist setup is <span className="text-yellow-300">on us.</span>
            </h2>
            <p className="mt-4 max-w-lg text-base leading-relaxed text-white/62">
              Choose Text Receptionist or the complete Text + AI package. Enter the launch code and
              your one-off setup fee becomes $0.
            </p>

            <div className="mt-7 grid gap-3 sm:grid-cols-2">
              {(Object.keys(ACQUISITION_PLANS) as AcquisitionSignupDraft["plan"][]).map((plan) => {
                const config = ACQUISITION_PLANS[plan];
                return (
                  <button
                    type="button"
                    key={plan}
                    onClick={() => {
                      const next = { ...draft, plan };
                      persistDraft(next);
                      track("package_selected", { plan, wizardStep: 0 });
                    }}
                    className={`rounded-2xl border p-4 text-left transition ${
                      draft.plan === plan
                        ? "border-yellow-300/60 bg-yellow-400/10"
                        : "border-white/10 bg-white/[0.035] hover:border-white/25"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-black">{config.name}</span>
                      {draft.plan === plan && (
                        <span className="grid h-6 w-6 place-items-center rounded-full bg-yellow-400 text-slate-950">
                          <Check className="h-3.5 w-3.5" />
                        </span>
                      )}
                    </div>
                    <div className="mt-4 flex items-end justify-between gap-3">
                      <span>
                        <span className="block text-xs text-white/40">One-off setup</span>
                        <span className="mt-0.5 block text-xl font-black text-white/45 line-through">
                          {moneyFromCents(config.setupFeeCents)}
                        </span>
                      </span>
                      <span className="text-right">
                        <span className="block text-xs text-white/40">With offer</span>
                        <span className="mt-0.5 block text-3xl font-black text-yellow-300">$0</span>
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>

            <div className="mt-4 flex items-center justify-between gap-3 rounded-2xl border border-dashed border-yellow-300/35 bg-black/20 p-4">
              <div>
                <div className="text-[9px] font-black uppercase tracking-[0.2em] text-white/40">
                  Your offer code
                </div>
                <div className="mt-1 font-mono text-lg font-black tracking-[0.12em] text-yellow-300">
                  {normalizePromoCode(draft.promoCode)}
                </div>
              </div>
              <ShieldCheck className="h-7 w-7 text-emerald-400" />
            </div>

            <button
              type="button"
              onClick={openWizard}
              className="mt-5 inline-flex w-full items-center justify-center gap-3 rounded-2xl bg-yellow-400 px-6 py-5 text-lg font-black text-slate-950 shadow-[0_24px_70px_rgba(250,204,21,0.18)] transition hover:-translate-y-0.5"
            >
              Sign up now <ArrowRight className="h-5 w-5" />
            </button>

            <div className="mt-5 grid grid-cols-3 gap-2 text-center text-[10px] font-bold text-white/45">
              <span className="rounded-lg bg-white/[0.035] p-2">No number port today</span>
              <span className="rounded-lg bg-white/[0.035] p-2">Secure Stripe checkout</span>
              <span className="rounded-lg bg-white/[0.035] p-2">Guided activation</span>
            </div>

            <p className="mt-5 text-center text-[11px] leading-relaxed text-white/38">
              Recurring platform and metered usage charges apply. All prices are displayed before
              payment setup.
            </p>
          </div>
        </div>
      </section>

      <div className="fixed inset-x-3 bottom-3 z-30 lg:hidden">
        <button
          type="button"
          onClick={openWizard}
          className="flex w-full items-center justify-between rounded-2xl bg-yellow-400 px-5 py-4 text-left text-slate-950 shadow-2xl"
        >
          <span>
            <span className="block text-[10px] font-black uppercase tracking-widest">
              Setup fee waived
            </span>
            <span className="block text-base font-black">
              Sign up with {normalizePromoCode(draft.promoCode)}
            </span>
          </span>
          <ArrowRight className="h-5 w-5" />
        </button>
      </div>

      <DemoCommercial
        open={demoOpen}
        onClose={() => setDemoOpen(false)}
        onTrack={(event) => track(event)}
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
