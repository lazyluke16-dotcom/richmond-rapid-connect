import { createFileRoute, useNavigate, getRouteApi } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import {
  JOB_TYPES, loadDraft, saveDraft,
  type Draft, type JobType, type PropertyType, type Urgency,
} from '@/lib/leads';
import { ArrowLeft, ArrowRight } from 'lucide-react';

const parentRoute = getRouteApi('/b/$slug');

export const Route = createFileRoute('/b/$slug/request')({
  component: TenantRequest,
});

const URGENCIES: { value: Urgency; label: string }[] = [
  { value: 'now', label: 'Right now — emergency' },
  { value: 'today', label: 'Today if possible' },
  { value: 'few-days', label: 'In the next few days' },
  { value: 'flexible', label: 'Flexible / book me in' },
];
const PROP: { value: PropertyType; label: string }[] = [
  { value: 'house', label: 'House' },
  { value: 'apartment', label: 'Apartment' },
  { value: 'commercial', label: 'Commercial' },
];

function TenantRequest() {
  const bundle = parentRoute.useLoaderData();
  const { slug } = Route.useParams();
  const navigate = useNavigate();
  const [step, setStep] = useState(1);
  const [draft, setDraft] = useState<Draft>({ photos: [], propertyType: 'house' });

  useEffect(() => {
    setDraft((d) => ({ ...loadDraft(), ...d, businessSlug: slug } as Draft & { businessSlug: string }));
    if (typeof sessionStorage !== 'undefined') {
      sessionStorage.setItem('tenant_slug', slug);
    }
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      const src = params.get('source');
      const mcid = params.get('mcid');
      if (src === 'missed_call' && mcid) {
        sessionStorage.setItem('lead_source', 'missed_call');
        sessionStorage.setItem('missed_call_id', mcid);
      }
    }
  }, [slug]);

  useEffect(() => { saveDraft(draft); }, [draft]);

  const total = 4;
  const update = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));
  const canNext = () => {
    if (step === 1) return !!draft.jobType;
    if (step === 2) return !!draft.suburb && !!draft.urgency && !!draft.propertyType;
    if (step === 3) return true;
    if (step === 4) return !!draft.name?.trim() && !!draft.phone?.trim();
    return false;
  };
  const next = () => {
    if (step < total) return setStep(step + 1);
    navigate({ to: '/b/$slug/chat', params: { slug } });
  };

  const areas: string[] = bundle.areas.map((a: { suburb: string }) => a.suburb);

  return (
    <div className="mx-auto max-w-2xl px-4 pt-6 pb-32">
      <button onClick={() => (step === 1 ? navigate({ to: '/b/$slug', params: { slug } }) : setStep(step - 1))} className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" /> Back
      </button>
      <div className="mt-4 flex items-center gap-2">
        {Array.from({ length: total }).map((_, i) => (
          <div key={i} className="h-1.5 flex-1 rounded-full" style={{ background: i < step ? 'var(--tenant-primary)' : 'hsl(var(--secondary))' }} />
        ))}
      </div>
      <div className="mt-2 text-xs uppercase tracking-widest text-muted-foreground">Step {step} of {total}</div>

      {step === 1 && (
        <div className="mt-6">
          <h1 className="text-2xl font-black">What's the job?</h1>
          <div className="mt-4 grid gap-2">
            {JOB_TYPES.map((j) => (
              <button
                key={j.value}
                onClick={() => update({ jobType: j.value as JobType })}
                className={`flex items-center gap-3 rounded-lg border p-4 text-left ${draft.jobType === j.value ? 'border-primary bg-primary/10' : 'border-border bg-card'}`}
              >
                <span className="text-2xl">{j.icon}</span>
                <div><div className="font-bold">{j.label}</div><div className="text-xs text-muted-foreground">{j.blurb}</div></div>
              </button>
            ))}
          </div>
        </div>
      )}

      {step === 2 && (
        <div className="mt-6 space-y-6">
          <h1 className="text-2xl font-black">Where and how urgent?</h1>
          <div>
            <div className="mb-2 text-sm font-bold uppercase tracking-widest text-muted-foreground">Suburb</div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {areas.map((s: string) => (
                <button key={s} onClick={() => update({ suburb: s })} className={`rounded-md border p-3 text-sm font-semibold ${draft.suburb === s ? 'border-primary bg-primary/10' : 'border-border bg-card'}`}>{s}</button>
              ))}
              <button onClick={() => update({ suburb: 'Other' })} className={`rounded-md border p-3 text-sm font-semibold ${draft.suburb === 'Other' ? 'border-primary bg-primary/10' : 'border-border bg-card'}`}>Other</button>
            </div>
          </div>
          <div>
            <div className="mb-2 text-sm font-bold uppercase tracking-widest text-muted-foreground">Urgency</div>
            <div className="grid gap-2">
              {URGENCIES.map((u) => (
                <button key={u.value} onClick={() => update({ urgency: u.value })} className={`rounded-md border p-3 text-left ${draft.urgency === u.value ? 'border-primary bg-primary/10' : 'border-border bg-card'}`}>
                  <div className="font-bold">{u.label}</div>
                </button>
              ))}
            </div>
          </div>
          <div>
            <div className="mb-2 text-sm font-bold uppercase tracking-widest text-muted-foreground">Property type</div>
            <div className="grid grid-cols-3 gap-2">
              {PROP.map((p) => (
                <button key={p.value} onClick={() => update({ propertyType: p.value })} className={`rounded-md border p-3 text-sm font-semibold ${draft.propertyType === p.value ? 'border-primary bg-primary/10' : 'border-border bg-card'}`}>{p.label}</button>
              ))}
            </div>
          </div>
        </div>
      )}

      {step === 3 && (
        <div className="mt-6 space-y-4">
          <h1 className="text-2xl font-black">Photos help heaps</h1>
          <p className="text-muted-foreground text-sm">(Optional — skip if you like.)</p>
        </div>
      )}

      {step === 4 && (
        <div className="mt-6 space-y-4">
          <h1 className="text-2xl font-black">Your details</h1>
          <label className="block"><div className="mb-2 text-sm font-bold uppercase tracking-widest text-muted-foreground">Name</div>
            <input value={draft.name ?? ''} onChange={(e) => update({ name: e.target.value })} className="w-full rounded-md border border-border bg-input px-3 py-3" placeholder="First name is fine" />
          </label>
          <label className="block"><div className="mb-2 text-sm font-bold uppercase tracking-widest text-muted-foreground">Mobile</div>
            <input inputMode="tel" value={draft.phone ?? ''} onChange={(e) => update({ phone: e.target.value })} className="w-full rounded-md border border-border bg-input px-3 py-3" placeholder="e.g. 0412 345 678" />
          </label>
          <label className="block"><div className="mb-2 text-sm font-bold uppercase tracking-widest text-muted-foreground">Best time to call back</div>
            <input value={draft.bestTime ?? ''} onChange={(e) => update({ bestTime: e.target.value })} className="w-full rounded-md border border-border bg-input px-3 py-3" />
          </label>
        </div>
      )}

      <div className="mt-8">
        <button onClick={next} disabled={!canNext()} className="inline-flex w-full items-center justify-center gap-2 rounded-md px-5 py-4 text-base font-black text-white disabled:opacity-40" style={{ background: 'var(--tenant-primary)' }}>
          {step < total ? 'Continue' : 'Chat with AI receptionist'} <ArrowRight className="h-5 w-5" />
        </button>
      </div>
    </div>
  );
}