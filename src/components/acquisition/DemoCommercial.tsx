import { useEffect, useMemo, useRef, useState } from "react";
import {
  Bot,
  CheckCircle2,
  ClipboardCheck,
  MessageSquareText,
  Pause,
  Phone,
  Play,
  RotateCcw,
  Wrench,
  X,
} from "lucide-react";
import type { AcquisitionEventName } from "@/lib/acquisition";

const SCENES = [
  {
    duration: 7,
    eyebrow: "The problem",
    title: "You’re under a sink. Your next customer is calling.",
  },
  {
    duration: 8,
    eyebrow: "Text Receptionist",
    title: "The missed call becomes a conversation—in seconds.",
  },
  {
    duration: 9,
    eyebrow: "A better first response",
    title: "Your customer tells you the job, suburb and urgency.",
  },
  {
    duration: 8,
    eyebrow: "Ready to quote",
    title: "You get the useful details before you call back.",
  },
  {
    duration: 10,
    eyebrow: "AI Receptionist",
    title: "Or let a natural voice answer the call, 24/7.",
  },
  {
    duration: 8,
    eyebrow: "One job centre",
    title: "Every lead arrives clear, complete and ready to action.",
  },
  {
    duration: 8,
    eyebrow: "Rapid Connect",
    title: "Keep working. Keep answering. Stop losing good jobs.",
  },
] as const;

const TOTAL_DURATION = SCENES.reduce((sum, scene) => sum + scene.duration, 0);

export function DemoCommercial({
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
  const elapsedRef = useRef(0);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  elapsedRef.current = elapsed;

  const sceneState = useMemo(() => {
    let cursor = 0;
    for (let index = 0; index < SCENES.length; index += 1) {
      const end = cursor + SCENES[index].duration;
      if (elapsed < end) {
        return { index, progress: (elapsed - cursor) / SCENES[index].duration };
      }
      cursor = end;
    }
    return { index: SCENES.length - 1, progress: 1 };
  }, [elapsed]);

  useEffect(() => {
    if (!open) return;
    setElapsed(0);
    setPlaying(!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
    milestones.current.clear();
  }, [open]);

  useEffect(() => {
    if (!open || !playing || elapsed >= TOTAL_DURATION) return;
    const timer = window.setInterval(() => {
      setElapsed((value) => Math.min(TOTAL_DURATION, value + 0.1));
    }, 100);
    return () => window.clearInterval(timer);
  }, [open, playing, elapsed]);

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
    if (!open || elapsed < TOTAL_DURATION) return;
    const timer = window.setTimeout(() => {
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
      onClose();
    }, 1800);
    return () => window.clearTimeout(timer);
  }, [elapsed, onClose, open]);

  useEffect(() => {
    if (!open) return;
    const previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeButtonRef.current?.focus();

    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (elapsedRef.current < TOTAL_DURATION) onTrack("demo_closed");
        if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
        onClose();
        return;
      }
      const target = event.target instanceof HTMLElement ? event.target : null;
      const interactiveTarget = target?.closest(
        "button, input, select, textarea, a[href], [contenteditable='true']",
      );
      if (event.key === " " && !interactiveTarget) {
        event.preventDefault();
        setPlaying((value) => !value);
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(
          "button:not([disabled]), input:not([disabled]), a[href], [tabindex]:not([tabindex='-1'])",
        ),
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = previousOverflow;
      previousFocus?.focus();
    };
  }, [open, onClose, onTrack]);

  if (!open) return null;

  const close = () => {
    if (elapsed < TOTAL_DURATION) onTrack("demo_closed");
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    onClose();
  };

  const replay = () => {
    setElapsed(0);
    setPlaying(true);
    milestones.current.clear();
    onTrack("demo_started");
  };

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label="Rapid Connect product demonstration"
      className="acquisition-experience fixed inset-0 z-[100] overflow-hidden bg-[#071018] text-white"
    >
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_15%_20%,rgba(250,204,21,0.18),transparent_34%),radial-gradient(circle_at_80%_70%,rgba(14,165,233,0.16),transparent_38%)]" />
      <header className="absolute inset-x-0 top-0 z-20 flex items-center justify-between p-4 sm:p-6">
        <div className="flex items-center gap-3">
          <span className="grid h-9 w-9 place-items-center rounded-lg bg-yellow-400 text-slate-950">
            <Phone className="h-5 w-5" />
          </span>
          <div>
            <div className="text-sm font-black tracking-tight">RAPID CONNECT</div>
            <div className="text-[10px] uppercase tracking-[0.24em] text-white/50">
              Product demo
            </div>
          </div>
        </div>
        <button
          ref={closeButtonRef}
          type="button"
          onClick={close}
          className="grid h-11 w-11 place-items-center rounded-full border border-white/20 bg-black/30 text-white transition hover:bg-white/10"
          aria-label="Close demo"
        >
          <X className="h-5 w-5" />
        </button>
      </header>

      <main className="relative z-10 grid min-h-dvh place-items-center px-5 pb-24 pt-20 sm:px-10">
        <div key={sceneState.index} className="w-full max-w-6xl animate-[demo-in_500ms_ease-out]">
          <Scene index={sceneState.index} />
          <div className="mx-auto mt-7 max-w-4xl text-center sm:mt-10">
            <div className="text-xs font-black uppercase tracking-[0.28em] text-yellow-300">
              {SCENES[sceneState.index].eyebrow}
            </div>
            <h2 className="mt-3 text-balance text-3xl font-black leading-[1.02] sm:text-5xl lg:text-6xl">
              {SCENES[sceneState.index].title}
            </h2>
          </div>
          {sceneState.index === SCENES.length - 1 && (
            <div className="mx-auto mt-7 flex max-w-xl flex-col justify-center gap-3 sm:flex-row">
              <button
                type="button"
                onClick={() => {
                  close();
                  onSignup();
                }}
                className="rounded-xl bg-yellow-400 px-7 py-4 text-base font-black text-slate-950 shadow-[0_20px_60px_rgba(250,204,21,0.25)]"
              >
                Set up my receptionist
              </button>
              <button
                type="button"
                onClick={replay}
                className="inline-flex items-center justify-center gap-2 rounded-xl border border-white/20 px-6 py-4 font-bold text-white"
              >
                <RotateCcw className="h-4 w-4" /> Watch again
              </button>
            </div>
          )}
        </div>
      </main>

      <footer className="absolute inset-x-0 bottom-0 z-20 border-t border-white/10 bg-black/25 px-4 py-3 backdrop-blur sm:px-6">
        <div className="mx-auto flex max-w-6xl items-center gap-3">
          <button
            type="button"
            onClick={() => setPlaying((value) => !value)}
            className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-white/10"
            aria-label={playing ? "Pause demo" : "Play demo"}
          >
            {playing ? <Pause className="h-4 w-4" /> : <Play className="ml-0.5 h-4 w-4" />}
          </button>
          <input
            type="range"
            min={0}
            max={TOTAL_DURATION}
            step={0.1}
            value={elapsed}
            onChange={(event) => setElapsed(Number(event.currentTarget.value))}
            className="h-8 flex-1 cursor-pointer accent-yellow-400"
            aria-label="Seek demo"
          />
          <div className="w-20 text-right text-xs tabular-nums text-white/60">
            {formatTime(elapsed)} / {formatTime(TOTAL_DURATION)}
          </div>
        </div>
      </footer>
    </div>
  );
}

function Scene({ index }: { index: number }) {
  if (index === 0) {
    return (
      <div className="mx-auto flex max-w-3xl items-center justify-center gap-6 sm:gap-14">
        <div className="relative grid h-40 w-40 place-items-center rounded-[2rem] border border-white/10 bg-white/5 sm:h-56 sm:w-56">
          <Wrench className="h-20 w-20 rotate-[-20deg] text-yellow-300 sm:h-28 sm:w-28" />
          <span className="absolute -bottom-3 rounded-full bg-sky-400 px-4 py-2 text-xs font-black text-slate-950">
            ON THE TOOLS
          </span>
        </div>
        <div className="relative h-52 w-28 rounded-[2rem] border-4 border-slate-700 bg-slate-950 p-2 shadow-2xl sm:h-72 sm:w-40">
          <div className="grid h-full place-items-center rounded-[1.4rem] bg-gradient-to-b from-sky-500/30 to-slate-900">
            <Phone className="h-12 w-12 animate-bounce text-yellow-300" />
            <span className="absolute bottom-9 text-center text-xs font-bold">NEW CUSTOMER</span>
          </div>
        </div>
      </div>
    );
  }
  if (index === 1) {
    return (
      <PhoneFrame>
        <div className="space-y-3 p-4 pt-10">
          <div className="text-center text-xs text-white/50">Messages · now</div>
          <div className="ml-auto max-w-[88%] rounded-2xl rounded-br-sm bg-sky-500 p-3 text-sm font-medium">
            Sorry we missed your call—we’re on the tools. Tell us what’s happening and we’ll call
            you back with the right help.
          </div>
          <div className="ml-auto rounded-xl bg-yellow-400 px-3 py-2 text-center text-sm font-black text-slate-950">
            Describe my job
          </div>
        </div>
      </PhoneFrame>
    );
  }
  if (index === 2) {
    return (
      <div className="mx-auto grid max-w-3xl gap-3 rounded-3xl border border-white/10 bg-white/[0.06] p-5 shadow-2xl sm:grid-cols-3 sm:p-7">
        {[
          ["Job", "Burst pipe"],
          ["Suburb", "Richmond"],
          ["Urgency", "Water is running"],
        ].map(([label, value], item) => (
          <div
            key={label}
            className="rounded-2xl border border-white/10 bg-black/20 p-4"
            style={{ animationDelay: `${item * 140}ms` }}
          >
            <div className="text-[10px] font-black uppercase tracking-widest text-white/45">
              {label}
            </div>
            <div className="mt-2 flex items-center gap-2 font-black">
              <CheckCircle2 className="h-5 w-5 text-emerald-400" /> {value}
            </div>
          </div>
        ))}
      </div>
    );
  }
  if (index === 3) {
    return (
      <div className="mx-auto max-w-3xl rounded-3xl border border-yellow-300/20 bg-slate-900/80 p-5 shadow-2xl sm:p-7">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-xs font-black uppercase tracking-widest text-yellow-300">
              New lead
            </div>
            <div className="mt-1 text-xl font-black">Burst pipe · Richmond</div>
          </div>
          <ClipboardCheck className="h-10 w-10 text-emerald-400" />
        </div>
        <div className="mt-5 grid gap-3 sm:grid-cols-3">
          {["Caller verified", "Photos requested", "Urgent callback"].map((item) => (
            <div key={item} className="rounded-xl bg-white/[0.06] p-3 text-sm font-bold">
              {item}
            </div>
          ))}
        </div>
      </div>
    );
  }
  if (index === 4) {
    return (
      <div className="mx-auto flex max-w-3xl items-center justify-center gap-5 sm:gap-12">
        <div className="grid h-36 w-36 place-items-center rounded-full border border-sky-300/30 bg-sky-400/10 shadow-[0_0_80px_rgba(56,189,248,0.16)] sm:h-52 sm:w-52">
          <Bot className="h-20 w-20 text-sky-300 sm:h-28 sm:w-28" />
        </div>
        <div className="max-w-md space-y-3">
          <div className="rounded-2xl rounded-bl-sm bg-white/10 p-4 text-sm sm:text-base">
            “Thanks for calling. Tell me what’s happening and I’ll make sure the plumber gets the
            right details.”
          </div>
          <div className="flex items-center gap-2 text-xs font-bold text-emerald-300">
            <span className="h-2 w-2 animate-pulse rounded-full bg-emerald-400" /> Answered in 2
            rings
          </div>
        </div>
      </div>
    );
  }
  if (index === 5) {
    return (
      <div className="mx-auto grid max-w-4xl gap-3 sm:grid-cols-2">
        {[
          {
            icon: MessageSquareText,
            type: "TEXT",
            job: "Burst pipe · Richmond",
            status: "Call back now",
          },
          {
            icon: Phone,
            type: "AI CALL",
            job: "No hot water · Hawthorn",
            status: "Tomorrow morning",
          },
        ].map(({ icon: Icon, type, job, status }) => (
          <div key={type} className="rounded-3xl border border-white/10 bg-white/[0.06] p-5">
            <div className="flex items-center gap-3">
              <span className="grid h-11 w-11 place-items-center rounded-xl bg-yellow-400 text-slate-950">
                <Icon className="h-5 w-5" />
              </span>
              <div>
                <div className="text-[10px] font-black tracking-widest text-yellow-300">{type}</div>
                <div className="font-black">{job}</div>
              </div>
            </div>
            <div className="mt-4 rounded-xl bg-black/25 p-3 text-sm text-white/70">{status}</div>
          </div>
        ))}
      </div>
    );
  }
  return (
    <div className="mx-auto grid h-44 w-44 place-items-center rounded-[2.4rem] bg-yellow-400 text-slate-950 shadow-[0_30px_100px_rgba(250,204,21,0.28)] sm:h-56 sm:w-56">
      <div className="text-center">
        <Phone className="mx-auto h-16 w-16 sm:h-20 sm:w-20" />
        <div className="mt-3 text-xl font-black tracking-tight">RAPID CONNECT</div>
      </div>
    </div>
  );
}

function PhoneFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto h-[320px] w-[184px] rounded-[2.3rem] border-4 border-slate-700 bg-slate-950 p-2 shadow-2xl sm:h-[390px] sm:w-[224px]">
      <div className="relative h-full overflow-hidden rounded-[1.7rem] bg-gradient-to-b from-slate-800 to-slate-950">
        <div className="absolute left-1/2 top-2 h-4 w-16 -translate-x-1/2 rounded-full bg-black" />
        {children}
      </div>
    </div>
  );
}

function formatTime(value: number) {
  const seconds = Math.max(0, Math.floor(value));
  return `0:${String(seconds).padStart(2, "0")}`;
}
