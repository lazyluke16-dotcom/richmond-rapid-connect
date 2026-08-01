import { useEffect, useMemo, useRef, useState } from "react";
import {
  BellRing,
  Bot,
  BriefcaseBusiness,
  MessageSquareText,
  Pause,
  Phone,
  Play,
  RotateCcw,
  ToggleLeft,
  ToggleRight,
  Wrench,
  X,
} from "lucide-react";
import type { AcquisitionEventName } from "@/lib/acquisition";

const SCENES = [
  {
    duration: 6,
    service: "Missed-Call Recovery",
    caption: "Reconstruction: a customer calls while the plumber is busy under a sink.",
  },
  {
    duration: 6,
    service: "Missed-Call Recovery",
    caption: "The plumber misses the original call. Rapid Connect does not answer it.",
  },
  {
    duration: 7,
    service: "Missed-Call Recovery",
    caption: "After the missed call, an automatic SMS asks for the job details.",
  },
  {
    duration: 6,
    service: "Missed-Call Recovery",
    caption: "The customer adds: burst pipe, Richmond, urgent, water running.",
  },
  {
    duration: 6,
    service: "Missed-Call Recovery",
    caption: "The plumber is alerted and the test opportunity appears in Missed Jobs.",
  },
  {
    duration: 6,
    service: "AI Receptionist",
    caption: "Reconstruction: another customer calls. AI Receptionist answers the original call.",
  },
  {
    duration: 7,
    service: "AI Receptionist",
    caption: "The customer speaks; AI gathers the job, suburb, urgency and callback details.",
  },
  {
    duration: 6,
    service: "AI Receptionist",
    caption: "The plumber is alerted and the completed opportunity appears in Missed Jobs.",
  },
  {
    duration: 8,
    service: "Your service controls",
    caption:
      "Only use the service when you need it. Switching it on or off is as easy as the touch of a button.",
  },
] as const;

const TOTAL_DURATION = SCENES.reduce((sum, scene) => sum + scene.duration, 0);

export function DemoRealWorldV2({
  open,
  onClose,
  onTrack,
  onSignup,
}: {
  open: boolean;
  onClose: () => void;
  onTrack: (event: AcquisitionEventName) => void;
  onSignup: () => void;
}) {
  const [elapsed, setElapsed] = useState(0);
  const [playing, setPlaying] = useState(true);
  const milestones = useRef(new Set<number>());
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const scene = useMemo(() => {
    let cursor = 0;
    for (let index = 0; index < SCENES.length; index += 1) {
      if (elapsed < cursor + SCENES[index].duration) return index;
      cursor += SCENES[index].duration;
    }
    return SCENES.length - 1;
  }, [elapsed]);

  useEffect(() => {
    if (!open) return;
    setElapsed(0);
    setPlaying(!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
    milestones.current.clear();
    closeRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open || !playing || elapsed >= TOTAL_DURATION) return;
    const timer = window.setInterval(
      () => setElapsed((value) => Math.min(TOTAL_DURATION, value + 0.1)),
      100,
    );
    return () => window.clearInterval(timer);
  }, [elapsed, open, playing]);

  useEffect(() => {
    if (!open) return;
    const ratio = elapsed / TOTAL_DURATION;
    const checkpoints: [number, AcquisitionEventName][] = [
      [0.25, "demo_25"],
      [0.5, "demo_50"],
      [0.75, "demo_75"],
      [1, "demo_completed"],
    ];
    for (const [point, event] of checkpoints) {
      if (ratio >= point && !milestones.current.has(point)) {
        milestones.current.add(point);
        onTrack(event);
      }
    }
    if (elapsed >= TOTAL_DURATION) setPlaying(false);
  }, [elapsed, onTrack, open]);

  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (elapsed < TOTAL_DURATION) onTrack("demo_closed");
        onClose();
      } else if (
        event.key === " " &&
        !(event.target instanceof HTMLButtonElement || event.target instanceof HTMLInputElement)
      ) {
        event.preventDefault();
        setPlaying((value) => !value);
      }
    };
    window.addEventListener("keydown", keydown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", keydown);
    };
  }, [elapsed, onClose, onTrack, open]);

  if (!open) return null;
  const close = () => {
    if (elapsed < TOTAL_DURATION) onTrack("demo_closed");
    onClose();
  };
  const replay = () => {
    setElapsed(0);
    milestones.current.clear();
    setPlaying(true);
    onTrack("demo_started");
  };

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label="Rapid Connect real-world service demonstration"
      data-demo-variant="demo-real-world-v2"
      className="acquisition-experience fixed inset-0 z-[100] overflow-y-auto bg-[#071018] text-white"
    >
      <header className="sticky top-0 z-20 flex items-center justify-between border-b border-white/10 bg-[#071018]/95 p-4 backdrop-blur sm:px-6">
        <div>
          <div className="text-xs font-black uppercase tracking-[.22em] text-yellow-300">
            Safe simulated reconstruction
          </div>
          <div className="mt-1 text-sm font-black">{SCENES[scene].service}</div>
        </div>
        <button
          ref={closeRef}
          type="button"
          onClick={close}
          aria-label="Close demo"
          className="grid h-11 w-11 place-items-center rounded-full border border-white/20 hover:bg-white/10 focus-visible:ring-4 focus-visible:ring-yellow-300/40"
        >
          <X className="h-5 w-5" />
        </button>
      </header>

      <main className="mx-auto grid min-h-[calc(100dvh-132px)] max-w-6xl place-items-center px-5 py-8">
        <div className="w-full" aria-live="polite">
          <Scene index={scene} />
          <div className="mx-auto mt-6 max-w-3xl rounded-2xl border border-yellow-300/25 bg-black/35 p-4 text-center shadow-xl">
            <div className="text-xs font-black uppercase tracking-[.2em] text-yellow-300">
              {SCENES[scene].service}
            </div>
            <p className="mt-2 text-base font-bold leading-relaxed sm:text-xl">
              {SCENES[scene].caption}
            </p>
          </div>
          {scene === SCENES.length - 1 && (
            <div className="mx-auto mt-5 flex max-w-xl flex-col gap-3 sm:flex-row">
              <button
                type="button"
                onClick={() => {
                  close();
                  onSignup();
                }}
                className="flex-1 rounded-xl bg-yellow-400 px-6 py-4 font-black text-slate-950 focus-visible:ring-4 focus-visible:ring-yellow-200"
              >
                Set up my service
              </button>
              <button
                type="button"
                onClick={replay}
                className="inline-flex items-center justify-center gap-2 rounded-xl border border-white/20 px-6 py-4 font-bold"
              >
                <RotateCcw className="h-4 w-4" /> Watch again
              </button>
            </div>
          )}
          <details className="mx-auto mt-4 max-w-3xl rounded-xl border border-white/10 p-3 text-sm text-white/70">
            <summary className="cursor-pointer font-bold text-white">
              Read the full accessible transcript
            </summary>
            <ol className="mt-3 list-decimal space-y-2 pl-5">
              {SCENES.map((item) => (
                <li key={item.caption}>
                  <b>{item.service}:</b> {item.caption}
                </li>
              ))}
            </ol>
            <p className="mt-3">
              Switching a service off pauses its operation. It does not cancel the Stripe
              subscription.
            </p>
          </details>
        </div>
      </main>

      <footer className="sticky bottom-0 z-20 border-t border-white/10 bg-[#071018]/95 p-3 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center gap-3">
          <button
            type="button"
            onClick={() => setPlaying((value) => !value)}
            aria-label={playing ? "Pause demo" : "Play demo"}
            className="grid h-10 w-10 place-items-center rounded-full bg-white/10"
          >
            {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
          </button>
          <input
            type="range"
            min={0}
            max={TOTAL_DURATION}
            step={0.1}
            value={elapsed}
            onChange={(event) => setElapsed(Number(event.currentTarget.value))}
            aria-label="Seek demo"
            className="flex-1 accent-yellow-400"
          />
          <span className="w-20 text-right text-xs tabular-nums">
            0:{String(Math.floor(elapsed)).padStart(2, "0")} / 0:{TOTAL_DURATION}
          </span>
        </div>
      </footer>
    </div>
  );
}

function Scene({ index }: { index: number }) {
  if (index === 0 || index === 1)
    return (
      <div className="mx-auto grid max-w-4xl gap-5 sm:grid-cols-2">
        <Device label="Customer phone">
          <Phone className="h-14 w-14 animate-pulse text-yellow-300" />
          <b>Calling Harbour Plumbing</b>
        </Device>
        <Device label="Plumber on site">
          <Wrench className="h-16 w-16 rotate-[-20deg] text-sky-300" />
          <b>Hands busy under a sink</b>
          {index === 1 && (
            <span className="rounded-full bg-rose-400/15 px-3 py-1 text-sm font-bold text-rose-200">
              Original call missed — not answered
            </span>
          )}
        </Device>
      </div>
    );
  if (index === 2)
    return (
      <Device label="Customer messages">
        <MessageSquareText className="h-12 w-12 text-sky-300" />
        <div className="rounded-2xl bg-sky-500 p-4">
          Sorry we missed your call. Tell us what you need and we’ll call you back.
        </div>
      </Device>
    );
  if (index === 3)
    return (
      <div className="mx-auto grid max-w-4xl gap-3 sm:grid-cols-4">
        {[
          ["Job", "Burst pipe"],
          ["Suburb", "Richmond"],
          ["Urgency", "Water running"],
          ["Contact", "Call me now"],
        ].map(([a, b]) => (
          <div key={a} className="rounded-2xl border border-white/10 bg-white/5 p-4">
            <span className="text-xs uppercase text-white/50">{a}</span>
            <b className="mt-2 block">{b}</b>
          </div>
        ))}
      </div>
    );
  if (index === 4 || index === 7)
    return (
      <div className="mx-auto grid max-w-4xl gap-5 sm:grid-cols-2">
        <Device label="Plumber notification">
          <BellRing className="h-12 w-12 text-yellow-300" />
          <b>New captured opportunity</b>
        </Device>
        <JobCard
          source={index === 4 ? "Missed-call SMS" : "AI Receptionist call"}
          job={index === 4 ? "Burst pipe · Richmond" : "No hot water · Hawthorn"}
        />
      </div>
    );
  if (index === 5)
    return (
      <div className="mx-auto grid max-w-4xl gap-5 sm:grid-cols-2">
        <Device label="Customer phone">
          <Phone className="h-12 w-12 text-yellow-300" />
          <b>Calling Harbour Plumbing</b>
        </Device>
        <Device label="AI Receptionist answers">
          <Bot className="h-16 w-16 text-sky-300" />
          <span className="rounded-full bg-emerald-400/15 px-3 py-1 text-sm font-bold text-emerald-200">
            Call answered
          </span>
        </Device>
      </div>
    );
  if (index === 6)
    return (
      <div className="mx-auto max-w-3xl space-y-3">
        {[
          "AI: What can the plumber help with?",
          "Customer: We have no hot water.",
          "AI: What suburb are you in, and how urgent is it?",
          "Customer: Hawthorn. Tomorrow morning is fine.",
        ].map((line, i) => (
          <div
            key={line}
            className={`rounded-2xl p-4 ${i % 2 ? "ml-8 bg-white/10" : "mr-8 bg-sky-500/30"}`}
          >
            {line}
          </div>
        ))}
      </div>
    );
  return (
    <div className="mx-auto grid max-w-4xl gap-4 sm:grid-cols-2">
      <ServiceToggle name="Missed-Call Recovery" />
      <ServiceToggle name="AI Receptionist" />
      <p className="sm:col-span-2 text-center text-sm text-white/65">
        Off pauses operation only. Manage or cancel the subscription separately in Account &amp;
        Billing.
      </p>
    </div>
  );
}

function Device({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mx-auto flex min-h-64 w-full max-w-sm flex-col items-center justify-center gap-5 rounded-[2rem] border border-white/12 bg-white/[.06] p-6 text-center shadow-2xl">
      <span className="text-xs font-black uppercase tracking-[.18em] text-white/50">{label}</span>
      {children}
    </div>
  );
}
function JobCard({ source, job }: { source: string; job: string }) {
  return (
    <div className="rounded-3xl border border-emerald-400/30 bg-emerald-400/10 p-6">
      <div className="flex items-center justify-between">
        <span className="text-xs font-black uppercase tracking-widest text-emerald-200">
          Missed Jobs · test
        </span>
        <BriefcaseBusiness className="h-8 w-8" />
      </div>
      <h3 className="mt-5 text-2xl font-black">{job}</h3>
      <p className="mt-2">Taylor · 0400 000 000 · callback requested</p>
      <div className="mt-5 rounded-xl bg-black/25 p-3 text-sm">Captured by {source}</div>
    </div>
  );
}
function ServiceToggle({ name }: { name: string }) {
  const [on, setOn] = useState(true);
  return (
    <button
      type="button"
      onClick={() => setOn((value) => !value)}
      aria-pressed={on}
      className="flex items-center justify-between rounded-2xl border border-white/15 bg-white/5 p-5 text-left focus-visible:ring-4 focus-visible:ring-yellow-300/40"
    >
      <span>
        <b className="block">{name}</b>
        <span className="text-xs text-white/55">{on ? "On and ready" : "Operation paused"}</span>
      </span>
      {on ? (
        <ToggleRight className="h-12 w-12 text-emerald-300" />
      ) : (
        <ToggleLeft className="h-12 w-12 text-white/45" />
      )}
    </button>
  );
}
