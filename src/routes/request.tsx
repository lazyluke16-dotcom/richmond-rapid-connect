import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { AppShell } from "@/components/AppShell";
import {
  JOB_TYPES,
  SUBURBS,
  loadDraft,
  saveDraft,
  type Draft,
  type JobType,
  type PropertyType,
  type Urgency,
} from "@/lib/leads";
import { ArrowLeft, ArrowRight, Camera, X } from "lucide-react";

export const Route = createFileRoute("/request")({
  head: () => ({
    meta: [
      { title: "Start a job request — Richmond Rapid Plumbing" },
      { name: "description", content: "Tell us the job in 60 seconds. Our AI receptionist takes the details so the plumber can call you back informed." },
    ],
  }),
  component: RequestPage,
});

const URGENCIES: { value: Urgency; label: string; hint: string }[] = [
  { value: "now", label: "Right now — emergency", hint: "Water everywhere, no water, gas smell" },
  { value: "today", label: "Today if possible", hint: "Annoying, need it sorted" },
  { value: "few-days", label: "In the next few days", hint: "Not urgent but soon" },
  { value: "flexible", label: "Flexible / book me in", hint: "Whenever suits" },
];

const PROP_TYPES: { value: PropertyType; label: string }[] = [
  { value: "house", label: "House" },
  { value: "apartment", label: "Apartment / unit" },
  { value: "commercial", label: "Business / commercial" },
];

function RequestPage() {
  const navigate = useNavigate();
  const [step, setStep] = useState(1);
  const [draft, setDraft] = useState<Draft>({
    photos: [],
    suburb: "Richmond",
    propertyType: "house",
  });

  useEffect(() => {
    setDraft((d) => ({ ...loadDraft(), ...d }));
  }, []);

  useEffect(() => {
    saveDraft(draft);
  }, [draft]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    const src = params.get('source');
    const mcid = params.get('mcid');
    if (src === 'missed_call' && mcid) {
      sessionStorage.setItem('lead_source', 'missed_call');
      sessionStorage.setItem('missed_call_id', mcid);
    }
  }, []);

  const total = 4;
  const update = (patch: Draft) => setDraft((d) => ({ ...d, ...patch }));

  const canNext = () => {
    if (step === 1) return !!draft.jobType;
    if (step === 2) return !!draft.suburb && !!draft.urgency && !!draft.propertyType;
    if (step === 3) return true;
    if (step === 4) return !!draft.name?.trim() && !!draft.phone?.trim();
    return false;
  };

  const onPhotos = async (files: FileList | null) => {
    if (!files) return;
    const list: string[] = [...(draft.photos ?? [])];
    for (const f of Array.from(files).slice(0, 4)) {
      const b64 = await fileToDataUrl(f);
      list.push(b64);
    }
    update({ photos: list.slice(0, 4) });
  };

  const next = () => {
    if (step < total) return setStep(step + 1);
    // finished the form -> go to AI chat
    navigate({ to: "/chat" });
  };

  return (
    <AppShell showCallBar={false}>
      <div className="mx-auto max-w-2xl px-4 pt-6 pb-32">
        <button onClick={() => (step === 1 ? navigate({ to: "/" }) : setStep(step - 1))} className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4" /> Back
        </button>

        <div className="mt-4 flex items-center gap-2">
          {Array.from({ length: total }).map((_, i) => (
            <div key={i} className={`h-1.5 flex-1 rounded-full ${i < step ? "bg-primary" : "bg-secondary"}`} />
          ))}
        </div>
        <div className="mt-2 text-xs uppercase tracking-widest text-muted-foreground">Step {step} of {total}</div>

        {step === 1 && (
          <div className="mt-6">
            <h1 className="text-2xl font-black sm:text-3xl">What's the job?</h1>
            <p className="mt-1 text-muted-foreground">Pick the closest match — the AI will ask more in a sec.</p>
            <div className="mt-5 grid gap-2">
              {JOB_TYPES.map((j) => {
                const active = draft.jobType === j.value;
                return (
                  <button
                    key={j.value}
                    onClick={() => update({ jobType: j.value as JobType })}
                    className={`flex items-center gap-3 rounded-lg border p-4 text-left transition ${active ? "border-primary bg-primary/10" : "border-border bg-card hover:border-primary/50"}`}
                  >
                    <span className="text-2xl">{j.icon}</span>
                    <span className="min-w-0 flex-1">
                      <div className="font-bold">{j.label}</div>
                      <div className="text-xs text-muted-foreground">{j.blurb}</div>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="mt-6 space-y-6">
            <div>
              <h1 className="text-2xl font-black sm:text-3xl">Where and how urgent?</h1>
            </div>
            <Field label="Suburb">
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {SUBURBS.map((s) => (
                  <button
                    key={s}
                    onClick={() => update({ suburb: s })}
                    className={`rounded-md border p-3 text-sm font-semibold ${draft.suburb === s ? "border-primary bg-primary/10 text-primary" : "border-border bg-card hover:border-primary/50"}`}
                  >
                    {s}
                  </button>
                ))}
              </div>
            </Field>
            <Field label="Urgency">
              <div className="grid gap-2">
                {URGENCIES.map((u) => (
                  <button
                    key={u.value}
                    onClick={() => update({ urgency: u.value })}
                    className={`rounded-md border p-3 text-left ${draft.urgency === u.value ? "border-primary bg-primary/10" : "border-border bg-card hover:border-primary/50"}`}
                  >
                    <div className="font-bold">{u.label}</div>
                    <div className="text-xs text-muted-foreground">{u.hint}</div>
                  </button>
                ))}
              </div>
            </Field>
            <Field label="Property type">
              <div className="grid grid-cols-3 gap-2">
                {PROP_TYPES.map((p) => (
                  <button
                    key={p.value}
                    onClick={() => update({ propertyType: p.value })}
                    className={`rounded-md border p-3 text-sm font-semibold ${draft.propertyType === p.value ? "border-primary bg-primary/10 text-primary" : "border-border bg-card hover:border-primary/50"}`}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </Field>
          </div>
        )}

        {step === 3 && (
          <div className="mt-6 space-y-4">
            <h1 className="text-2xl font-black sm:text-3xl">Photos help heaps</h1>
            <p className="text-muted-foreground">Snap the leak, drain, tap or unit — it helps the plumber assess the job before calling.</p>
            <label className="flex cursor-pointer items-center justify-center gap-2 rounded-lg border-2 border-dashed border-border bg-card p-8 text-sm text-muted-foreground hover:border-primary hover:text-foreground">
              <Camera className="h-5 w-5" />
              Tap to add photos (optional, up to 4)
              <input type="file" accept="image/*" multiple capture="environment" className="hidden" onChange={(e) => onPhotos(e.target.files)} />
            </label>
            {!!draft.photos?.length && (
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {draft.photos!.map((p, i) => (
                  <div key={i} className="relative aspect-square overflow-hidden rounded-md border border-border">
                    <img src={p} alt="Job photo" className="h-full w-full object-cover" />
                    <button
                      onClick={() => update({ photos: draft.photos!.filter((_, j) => j !== i) })}
                      className="absolute right-1 top-1 grid h-6 w-6 place-items-center rounded-full bg-background/80 text-foreground"
                      aria-label="Remove photo"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {step === 4 && (
          <div className="mt-6 space-y-4">
            <h1 className="text-2xl font-black sm:text-3xl">Your details</h1>
            <Field label="Name">
              <input
                value={draft.name ?? ""}
                onChange={(e) => update({ name: e.target.value })}
                placeholder="First name is fine"
                className="w-full rounded-md border border-border bg-input px-3 py-3 text-base"
              />
            </Field>
            <Field label="Mobile number">
              <input
                inputMode="tel"
                value={draft.phone ?? ""}
                onChange={(e) => update({ phone: e.target.value })}
                placeholder="e.g. 0412 345 678"
                className="w-full rounded-md border border-border bg-input px-3 py-3 text-base"
              />
            </Field>
            <Field label="Best time to call back">
              <input
                value={draft.bestTime ?? ""}
                onChange={(e) => update({ bestTime: e.target.value })}
                placeholder="e.g. ASAP / after 3pm / weekday mornings"
                className="w-full rounded-md border border-border bg-input px-3 py-3 text-base"
              />
            </Field>
            <p className="text-xs text-muted-foreground">
              We use these to call you back only — never for marketing. Demo site: nothing is actually sent.
            </p>
          </div>
        )}

        <div className="mt-8">
          <button
            onClick={next}
            disabled={!canNext()}
            className="inline-flex w-full items-center justify-center gap-2 rounded-md bg-primary px-5 py-4 text-base font-black text-primary-foreground shadow-[var(--shadow-glow)] disabled:cursor-not-allowed disabled:opacity-40"
          >
            {step < total ? "Continue" : "Chat with AI receptionist"} <ArrowRight className="h-5 w-5" />
          </button>
          {step === 1 && (
            <Link to="/" className="mt-3 block text-center text-xs text-muted-foreground hover:text-foreground">
              Cancel
            </Link>
          )}
        </div>
      </div>
    </AppShell>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <div className="mb-2 text-sm font-bold uppercase tracking-widest text-muted-foreground">{label}</div>
      {children}
    </label>
  );
}

function fileToDataUrl(f: File): Promise<string> {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result));
    r.onerror = rej;
    r.readAsDataURL(f);
  });
}