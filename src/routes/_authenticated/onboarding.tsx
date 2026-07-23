import { createFileRoute, useRouter, Link } from '@tanstack/react-router';
import { useEffect, useMemo, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import {
  getOnboardingStatus,
  getMyOnboardingBundle,
  createMyBusiness,
  setMyServices,
  setMyAreas,
  setMyHours,
  setMyPlan,
  setMyOnboardingStep,
  completeOnboarding,
} from '@/lib/onboarding.functions';
import { getMyBusiness, updateMyBusiness, type EditableBusiness } from '@/lib/business-settings.functions';
import { setMyCoverage } from '@/lib/business-settings.functions';
import { CheckCircle2, ArrowRight, Plus, X, Sparkles, Bot, Info } from 'lucide-react';

export const Route = createFileRoute('/_authenticated/onboarding')({
  head: () => ({ meta: [{ title: 'Set up your website — Rapid Connect' }, { name: 'robots', content: 'noindex' }] }),
  component: OnboardingWizard,
});

const DEFAULT_SERVICES = [
  { key: 'emergency', name: 'Emergency Plumbing' },
  { key: 'burst_pipes', name: 'Burst Pipes' },
  { key: 'blocked_drains', name: 'Blocked Drains' },
  { key: 'hot_water', name: 'Hot Water' },
  { key: 'toilets', name: 'Toilets' },
  { key: 'leaking_taps', name: 'Leaking Taps' },
  { key: 'gas', name: 'Gas' },
  { key: 'general', name: 'General Plumbing' },
];

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

type ServiceSel = { key: string; name: string; enabled: boolean };
type HourSel = { day_of_week: number; closed: boolean; open_time: string; close_time: string };

function OnboardingWizard() {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Step 0 (Business) — used to create business
  const [bizName, setBizName] = useState('');
  const [publicPhone, setPublicPhone] = useState('');
  const [publicEmail, setPublicEmail] = useState('');
  const [shortDesc, setShortDesc] = useState('');

  const [biz, setBiz] = useState<EditableBusiness | null>(null);

  // Step 3 services
  const [services, setServices] = useState<ServiceSel[]>(
    DEFAULT_SERVICES.map((s) => ({ key: s.key, name: s.name, enabled: true })),
  );
  // Step 4 areas
  const [areas, setAreas] = useState<string[]>([]);
  const [areaInput, setAreaInput] = useState('');
  // Phase 1 — primary coverage entry (base + radius + region/postcode/exclusion).
  const [baseSuburb, setBaseSuburb] = useState('');
  const [baseState, setBaseState] = useState('');
  const [basePostcode, setBasePostcode] = useState('');
  const [travelRadiusKm, setTravelRadiusKm] = useState<number | ''>('');
  const [regionLabels, setRegionLabels] = useState<string[]>([]);
  const [regionInput, setRegionInput] = useState('');
  const [postcodeRanges, setPostcodeRanges] = useState<string[]>([]);
  const [postcodeInput, setPostcodeInput] = useState('');
  const [excludedAreas, setExcludedAreas] = useState<string[]>([]);
  const [excludeInput, setExcludeInput] = useState('');
  const [showAdvancedAreas, setShowAdvancedAreas] = useState(false);
  // Step 5 hours
  const [hours, setHours] = useState<HourSel[]>(
    Array.from({ length: 7 }).map((_, i) => ({
      day_of_week: i,
      closed: i === 0 || i === 6,
      open_time: '08:00',
      close_time: '17:00',
    })),
  );
  // Plan
  const [plan, setPlan] = useState<'missed_call_recovery' | 'ai_receptionist'>('missed_call_recovery');

  // Load state on mount
  useEffect(() => {
    void (async () => {
      try {
        const status = await getOnboardingStatus();
        if (status.onboarding_completed) {
          await router.navigate({ to: '/dashboard', replace: true });
          return;
        }
        if (status.hasBusiness) {
          const [full, bundle] = await Promise.all([getMyBusiness(), getMyOnboardingBundle()]);
          if (full) {
            setBiz(full);
            setBizName(full.name);
            setPublicPhone(full.public_phone ?? '');
            setPublicEmail(full.public_email ?? '');
            setShortDesc(full.short_description ?? '');
          }
          // Restore any previously-saved wizard data instead of clobbering it
          // with UI defaults on resume.
          if (bundle.services.length > 0) {
            const saved = new Map(bundle.services.map((s) => [s.service_key, s]));
            const merged: ServiceSel[] = DEFAULT_SERVICES.map((d) => {
              const hit = saved.get(d.key);
              return { key: d.key, name: hit?.display_name ?? d.name, enabled: hit ? hit.active : false };
            });
            // Include any custom services the user saved that aren't in DEFAULT_SERVICES.
            for (const s of bundle.services) {
              if (!merged.some((m) => m.key === s.service_key)) {
                merged.push({ key: s.service_key, name: s.display_name, enabled: s.active });
              }
            }
            setServices(merged);
          }
          if (bundle.areas.length > 0) {
            setAreas(bundle.areas.map((a) => a.suburb));
          }
          // Restore Phase 1 coverage fields when the migration is applied.
          if (full) {
            setBaseSuburb(full.base_suburb ?? '');
            setBaseState(full.base_state ?? '');
            setBasePostcode(full.base_postcode ?? '');
            setTravelRadiusKm(
              typeof full.travel_radius_km === 'number' ? full.travel_radius_km : '',
            );
            setRegionLabels(full.region_labels ?? []);
            setPostcodeRanges(full.postcode_ranges ?? []);
            setExcludedAreas(full.excluded_areas ?? []);
          }
          if (bundle.hours.length > 0) {
            const byDay = new Map(bundle.hours.map((h) => [h.day_of_week, h]));
            setHours((prev) =>
              prev.map((h) => {
                const hit = byDay.get(h.day_of_week);
                if (!hit) return h;
                return {
                  day_of_week: h.day_of_week,
                  closed: hit.closed,
                  open_time: hit.open_time ?? h.open_time,
                  close_time: hit.close_time ?? h.close_time,
                };
              }),
            );
          }
          // Server is authoritative about which step the wizard should resume at.
          setStep(Math.min(Math.max(status.step, 1), 7));
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    })();
  }, [router]);

  // Transition-bound step persistence: each save handler awaits
  // `persistStep(next)` AFTER its own save succeeds and BEFORE advancing the
  // UI. If persistence fails, `withBusy` surfaces the error and the wizard
  // does NOT advance — the user is never shown a destination step that was
  // not durably recorded. Initial hydration never writes.
  const persistStep = async (next: number) => {
    try {
      await setMyOnboardingStep({ data: { step: next } });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`Could not save your progress (step ${next}). ${msg}`);
    }
  };

  const stepTitles = [
    'Your Business', 'Your Branding', 'Your Services', 'Where You Work',
    'Business Hours', 'Choose Your Plan', 'Your Website', 'Finish',
  ];

  const canNext = useMemo(() => {
    if (busy) return false;
    if (step === 0) return bizName.trim().length >= 2;
    return true;
  }, [step, bizName, busy]);

  const withBusy = async (fn: () => Promise<void>) => {
    setBusy(true); setError(null);
    try { await fn(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  const goStep0Next = () => withBusy(async () => {
    if (!biz) {
      // Create business
      const partner = sessionStorage.getItem('rc_partner') ?? undefined;
      const ref = sessionStorage.getItem('rc_ref') ?? undefined;
      await createMyBusiness({
        data: {
          name: bizName.trim(),
          slug_base: bizName.trim(),
          signup_source: partner ? 'partner' : 'direct',
          partner_code: partner ?? null,
          referral_code: ref ?? null,
        },
      });
      const full = await getMyBusiness();
      if (!full) throw new Error('Business creation failed');
      setBiz(full);
    }
    // Persist step-0 editable fields
    await updateMyBusiness({
      data: {
        name: bizName.trim(),
        public_phone: publicPhone || null,
        public_email: publicEmail || null,
        short_description: shortDesc || null,
      },
    });
    const full = await getMyBusiness();
    if (full) setBiz(full);
    await persistStep(1);
    setStep(1);
  });

  const saveBranding = () => withBusy(async () => {
    if (!biz) return;
    await updateMyBusiness({
      data: {
        logo_url: biz.logo_url,
        primary_colour: biz.primary_colour,
        secondary_colour: biz.secondary_colour,
        accent_colour: biz.accent_colour,
      },
    });
    await persistStep(2);
    setStep(2);
  });

  const saveServices = () => withBusy(async () => {
    await setMyServices({
      data: {
        services: services.filter((s) => s.enabled).map((s) => ({ service_key: s.key, display_name: s.name })),
      },
    });
    await persistStep(3);
    setStep(3);
  });

  const saveAreas = () => withBusy(async () => {
    // Phase 1: coverage save is transactional from the user's perspective.
    // If the user supplied ANY coverage field we MUST persist it before
    // touching the legacy suburb list. A coverage failure surfaces a
    // clear error, does NOT overwrite existing suburbs, and does NOT
    // advance the wizard. Pre-migration compatibility is preserved by
    // skipping the coverage call entirely when the user left every
    // coverage input empty (existing Richmond tenant keeps working).
    const hasCoverageInput =
      baseSuburb.trim() !== '' ||
      baseState.trim() !== '' ||
      basePostcode.trim() !== '' ||
      travelRadiusKm !== '' ||
      regionLabels.length > 0 ||
      postcodeRanges.length > 0 ||
      excludedAreas.length > 0;

    if (hasCoverageInput) {
      try {
        await setMyCoverage({
          data: {
            base_suburb: baseSuburb.trim() || null,
            base_state: baseState.trim() || null,
            base_postcode: basePostcode.trim() || null,
            travel_radius_km: travelRadiusKm === '' ? null : Number(travelRadiusKm),
            region_labels: regionLabels,
            postcode_ranges: postcodeRanges,
            excluded_areas: excludedAreas,
          },
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const columnMissing = /(base_suburb|travel_radius_km|region_labels|postcode_ranges|excluded_areas|licence_|does not exist|not found|could not find|42703)/i.test(msg);
        if (columnMissing) {
          throw new Error(
            "Service coverage can't be saved yet — the platform database update for coverage fields is still pending. Your existing suburb list was not changed. Please try again shortly or contact support.",
          );
        }
        throw new Error(`Could not save service coverage — ${msg}. Your existing settings were not overwritten.`);
      }
    }

    await setMyAreas({ data: { areas: areas.map((s) => ({ suburb: s })) } });
    await persistStep(4);
    setStep(4);
  });

  const saveHours = () => withBusy(async () => {
    await setMyHours({
      data: {
        hours: hours.map((h) => ({
          day_of_week: h.day_of_week,
          closed: h.closed,
          open_time: h.open_time,
          close_time: h.close_time,
        })),
      },
    });
    await persistStep(5);
    setStep(5);
  });

  const savePlan = () => withBusy(async () => {
    await setMyPlan({ data: { plan } });
    await persistStep(6);
    setStep(6);
  });

  const saveHero = () => withBusy(async () => {
    if (!biz) return;
    await updateMyBusiness({
      data: {
        hero_heading: biz.hero_heading,
        hero_subheading: biz.hero_subheading,
        emergency_message: biz.emergency_message,
      },
    });
    await persistStep(7);
    setStep(7);
  });

  const finish = () => withBusy(async () => {
    // completeOnboarding sets onboarding_completed=true; also anchor the
    // persisted step at MAX so future reloads resume coherently even if a
    // legacy row is later re-opened.
    await persistStep(7);
    await completeOnboarding();
    sessionStorage.removeItem('rc_partner');
    sessionStorage.removeItem('rc_ref');
  });

  const signOut = async () => {
    await supabase.auth.signOut();
    await router.navigate({ to: '/auth', replace: true });
  };

  const addArea = () => {
    const v = areaInput.trim();
    if (!v) return;
    if (areas.some((a) => a.toLowerCase() === v.toLowerCase())) { setAreaInput(''); return; }
    setAreas([...areas, v]);
    setAreaInput('');
  };

  const updateBiz = (patch: Partial<EditableBusiness>) => setBiz((b) => (b ? { ...b, ...patch } : b));

  if (loading) return <div className="p-8 text-sm text-muted-foreground">Loading…</div>;

  return (
    <div className="mx-auto max-w-4xl px-4 py-6">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-xs uppercase tracking-widest text-primary">Setup wizard</div>
          <h1 className="text-2xl font-black">{stepTitles[step]}</h1>
          <p className="text-xs text-muted-foreground">Step {Math.min(step + 1, stepTitles.length)} of {stepTitles.length}</p>
        </div>
        <button onClick={() => { void signOut(); }} className="text-xs text-muted-foreground underline">Sign out</button>
      </div>

      <StepProgress step={step} total={stepTitles.length} />

      {error && <div className="mt-4 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">{error}</div>}

      <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_360px]">
        <div className="rounded-lg border border-border bg-card p-5">
          {step === 0 && (
            <div className="space-y-4">
              <Field label="Business name *" value={bizName} onChange={setBizName} placeholder="e.g. Harbour Plumbing Co" />
              <Field label="Public phone" value={publicPhone} onChange={setPublicPhone} placeholder="0400 000 000" />
              <Field label="Public email" type="email" value={publicEmail} onChange={setPublicEmail} />
              <Field label="Short description" value={shortDesc} onChange={setShortDesc} placeholder="24/7 emergency plumbers based in Sydney" multiline />
              <NextBar onNext={goStep0Next} disabled={!canNext} busy={busy} />
            </div>
          )}

          {step === 1 && biz && (
            <div className="space-y-4">
              <Field label="Logo URL (optional)" value={biz.logo_url ?? ''} onChange={(v) => updateBiz({ logo_url: v || null })} placeholder="https://…" />
              <p className="text-xs text-muted-foreground">
                Direct file upload is coming soon — paste a hosted URL for now (e.g. from your Google Drive share link or existing website).
              </p>
              <div className="grid grid-cols-3 gap-3">
                <ColorField label="Primary" value={biz.primary_colour ?? '#0EA5E9'} onChange={(v) => updateBiz({ primary_colour: v })} />
                <ColorField label="Secondary" value={biz.secondary_colour ?? '#0B2545'} onChange={(v) => updateBiz({ secondary_colour: v })} />
                <ColorField label="Accent" value={biz.accent_colour ?? '#67E8F9'} onChange={(v) => updateBiz({ accent_colour: v })} />
              </div>
              <NextBar onBack={() => setStep(0)} onNext={saveBranding} busy={busy} />
            </div>
          )}

          {step === 2 && (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">Enable the services you offer. You can edit names.</p>
              {services.map((s, i) => (
                <div key={s.key} className="flex items-center gap-2">
                  <input
                    type="checkbox" checked={s.enabled}
                    onChange={(e) => setServices(services.map((x, j) => j === i ? { ...x, enabled: e.target.checked } : x))}
                    className="h-5 w-5"
                  />
                  <input
                    value={s.name} onChange={(e) => setServices(services.map((x, j) => j === i ? { ...x, name: e.target.value } : x))}
                    className="flex-1 rounded-md border border-border bg-input px-3 py-2"
                  />
                </div>
              ))}
              <NextBar onBack={() => setStep(1)} onNext={saveServices} busy={busy} />
            </div>
          )}

          {step === 3 && (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                Tell us where you're based and how far you'll travel. You can add broad region names, optional postcode ranges, and specific exclusions.
              </p>
              <div className="rounded-md border border-border bg-background/40 p-3 space-y-3">
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                  <Field label="Base suburb" value={baseSuburb} onChange={setBaseSuburb} placeholder="Richmond" />
                  <Field label="State" value={baseState} onChange={setBaseState} placeholder="VIC" />
                  <Field label="Postcode" value={basePostcode} onChange={setBasePostcode} placeholder="3121" />
                </div>
                <label className="block">
                  <div className="mb-1 text-xs font-bold uppercase tracking-widest text-muted-foreground">Travel radius (km)</div>
                  <input
                    type="number" min={0} max={500}
                    value={travelRadiusKm}
                    onChange={(e) => setTravelRadiusKm(e.target.value === '' ? '' : Math.max(0, Math.min(500, Number(e.target.value))))}
                    placeholder="25"
                    className="w-full rounded-md border border-border bg-input px-3 py-2"
                  />
                </label>
                <ChipsField
                  label="Broad region labels (optional)"
                  hint="Free-form — e.g. 'Inner East Melbourne', 'Bayside'. We don't assume any authoritative mapping."
                  values={regionLabels} setValues={setRegionLabels}
                  input={regionInput} setInput={setRegionInput}
                  placeholder="Inner East Melbourne"
                />
                <ChipsField
                  label="Postcode ranges (optional)"
                  hint="Enter '3000' or a range like '3000-3199'."
                  values={postcodeRanges} setValues={setPostcodeRanges}
                  input={postcodeInput} setInput={setPostcodeInput}
                  placeholder="3000-3199"
                />
                <ChipsField
                  label="Exclusions (optional)"
                  hint="Specific suburbs or areas you never service."
                  values={excludedAreas} setValues={setExcludedAreas}
                  input={excludeInput} setInput={setExcludeInput}
                  placeholder="Docklands"
                />
              </div>

              <details className="rounded-md border border-border bg-background/40" open={showAdvancedAreas} onToggle={(e) => setShowAdvancedAreas((e.currentTarget as HTMLDetailsElement).open)}>
                <summary className="cursor-pointer select-none px-3 py-2 text-sm font-bold">Advanced: specific suburb list</summary>
                <div className="space-y-2 p-3 pt-1">
                  <p className="text-xs text-muted-foreground">Optional — only use this if you need to enumerate every suburb explicitly. Existing entries are preserved; leaving this alone won't overwrite them.</p>
                  <div className="flex gap-2">
                    <input
                      value={areaInput} onChange={(e) => setAreaInput(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addArea(); } }}
                      placeholder="Suburb name"
                      className="flex-1 rounded-md border border-border bg-input px-3 py-2"
                    />
                    <button onClick={addArea} className="rounded-md bg-primary px-3 py-2 text-primary-foreground"><Plus className="h-4 w-4" /></button>
                  </div>
                  <ul className="flex flex-wrap gap-2">
                    {areas.map((a) => (
                      <li key={a} className="inline-flex items-center gap-1 rounded-full border border-border bg-card px-3 py-1 text-sm">
                        {a}
                        <button onClick={() => setAreas(areas.filter((x) => x !== a))}><X className="h-3 w-3" /></button>
                      </li>
                    ))}
                    {areas.length === 0 && <li className="text-sm text-muted-foreground">No suburbs yet.</li>}
                  </ul>
                </div>
              </details>
              <NextBar onBack={() => setStep(2)} onNext={saveAreas} busy={busy} />
            </div>
          )}

          {step === 4 && (
            <div className="space-y-2">
              {hours.map((h, i) => (
                <div key={h.day_of_week} className="flex items-center gap-3 py-1">
                  <div className="w-12 font-bold">{DAY_NAMES[h.day_of_week]}</div>
                  <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={!h.closed} onChange={(e) => setHours(hours.map((x, j) => j === i ? { ...x, closed: !e.target.checked } : x))} />
                    Open
                  </label>
                  {!h.closed && (
                    <>
                      <input type="time" value={h.open_time} onChange={(e) => setHours(hours.map((x, j) => j === i ? { ...x, open_time: e.target.value } : x))} className="rounded-md border border-border bg-input px-2 py-1 text-sm" />
                      <span>–</span>
                      <input type="time" value={h.close_time} onChange={(e) => setHours(hours.map((x, j) => j === i ? { ...x, close_time: e.target.value } : x))} className="rounded-md border border-border bg-input px-2 py-1 text-sm" />
                    </>
                  )}
                </div>
              ))}
              <NextBar onBack={() => setStep(3)} onNext={saveHours} busy={busy} />
            </div>
          )}

          {step === 5 && (
            <div className="space-y-4">
              <PlanCard
                selected={plan === 'missed_call_recovery'} onSelect={() => setPlan('missed_call_recovery')}
                icon={<Sparkles className="h-5 w-5" />} title="Missed Call Recovery"
                bullets={['Branded job-capture website', 'Missed-call SMS recovery', 'Customer job form', 'Plumber dashboard', 'Lead summaries']}
              />
              <PlanCard
                selected={plan === 'ai_receptionist'} onSelect={() => setPlan('ai_receptionist')}
                icon={<Bot className="h-5 w-5" />} title="AI Receptionist"
                bullets={['Everything in Missed Call Recovery', 'AI phone receptionist', 'Phone-call job capture', 'AI call summary']}
                highlight
              />
              <p className="text-xs text-muted-foreground">Signup and configuration are free. Usage (SMS, AI minutes) is billed only when you go Live — nothing is charged today.</p>
              {plan === 'ai_receptionist' && (
                <div className="rounded-md border border-yellow-500/40 bg-yellow-500/5 p-3 text-xs text-yellow-200 flex gap-2">
                  <Info className="h-4 w-4 shrink-0 mt-0.5" />
                  <div>
                    <div className="font-bold">AI Receptionist selected — not yet live</div>
                    <p className="mt-1 opacity-90">
                      Your choice is saved. The AI receptionist is <b>included</b> in your setup but is <b>not activated</b>, <b>not billable</b>, and setup is <b>incomplete</b>. No telephony is provisioned and no payment method is connected. A future Go Live step will handle activation.
                    </p>
                  </div>
                </div>
              )}
              <NextBar onBack={() => setStep(4)} onNext={savePlan} busy={busy} />
            </div>
          )}

          {step === 6 && biz && (
            <div className="space-y-4">
              <Field label="Hero heading" value={biz.hero_heading ?? ''} onChange={(v) => updateBiz({ hero_heading: v || null })} placeholder="Sydney's fastest plumbers" />
              <Field label="Hero subheading" value={biz.hero_subheading ?? ''} onChange={(v) => updateBiz({ hero_subheading: v || null })} multiline />
              <Field label="Emergency message" value={biz.emergency_message ?? ''} onChange={(v) => updateBiz({ emergency_message: v || null })} placeholder="24/7 emergency service" />
              <NextBar onBack={() => setStep(5)} onNext={saveHero} busy={busy} />
            </div>
          )}

          {step === 7 && biz && (
            <div className="text-center py-8">
              <CheckCircle2 className="mx-auto h-16 w-16 text-primary" />
              <h2 className="mt-4 text-2xl font-black">Your website is ready!</h2>
              <p className="mt-1 text-sm text-muted-foreground">Your public job-capture site is live at:</p>
              <div className="mt-3 font-mono text-primary">/b/{biz.slug}</div>
              <div className="mt-6 flex flex-wrap justify-center gap-3">
                <button
                  onClick={() => withBusy(async () => {
                    await completeOnboarding();
                    window.open(`/b/${biz.slug}`, '_blank');
                    await router.navigate({ to: '/dashboard', replace: true });
                  })}
                  disabled={busy}
                  className="rounded-md bg-primary px-5 py-3 font-black text-primary-foreground disabled:opacity-40"
                >
                  View My Website
                </button>
                <button
                  onClick={() => withBusy(async () => { await finish(); await router.navigate({ to: '/dashboard', replace: true }); })}
                  disabled={busy}
                  className="rounded-md border border-border bg-card px-5 py-3 font-black disabled:opacity-40"
                >
                  Go to Dashboard
                </button>
                <button
                  onClick={() => withBusy(async () => { await finish(); await router.navigate({ to: '/settings', replace: true }); })}
                  disabled={busy}
                  className="rounded-md border border-border bg-card px-5 py-3 font-black disabled:opacity-40"
                >
                  Business Settings
                </button>
              </div>
            </div>
          )}
        </div>

        <aside className="rounded-lg border border-border bg-card p-4 h-fit sticky top-6">
          <div className="text-xs uppercase tracking-widest text-muted-foreground mb-2">Live preview</div>
          <PreviewCard
            name={bizName || biz?.name || 'Your business'}
            logo={biz?.logo_url ?? null}
            primary={biz?.primary_colour ?? '#0EA5E9'}
            secondary={biz?.secondary_colour ?? '#0B2545'}
            hero={biz?.hero_heading ?? bizName ?? 'Your hero heading'}
            subhero={biz?.hero_subheading ?? shortDesc ?? 'Your subheading appears here.'}
            services={services.filter((s) => s.enabled).slice(0, 4).map((s) => s.name)}
            areas={areas.slice(0, 5)}
          />
          {biz && <div className="mt-3 text-[11px] text-muted-foreground">Slug: <span className="font-mono">{biz.slug}</span></div>}
          <div className="mt-3 text-[11px]">
            <Link to="/dashboard" className="text-muted-foreground underline">Skip to dashboard (finishes later)</Link>
          </div>
        </aside>
      </div>
    </div>
  );
}

function StepProgress({ step, total }: { step: number; total: number }) {
  const pct = Math.round(((Math.min(step, total - 1) + 1) / total) * 100);
  return (
    <div className="mt-4 h-2 w-full rounded-full bg-secondary">
      <div className="h-2 rounded-full bg-primary transition-all" style={{ width: `${pct}%` }} />
    </div>
  );
}

function NextBar({ onBack, onNext, disabled, busy }: { onBack?: () => void; onNext: () => void; disabled?: boolean; busy?: boolean }) {
  return (
    <div className="flex items-center justify-between pt-2">
      {onBack ? <button onClick={onBack} disabled={busy} className="text-sm text-muted-foreground underline">← Back</button> : <span />}
      <button onClick={onNext} disabled={disabled || busy} className="inline-flex items-center gap-2 rounded-md bg-primary px-5 py-3 font-black text-primary-foreground disabled:opacity-40">
        {busy ? 'Saving…' : 'Continue'} <ArrowRight className="h-4 w-4" />
      </button>
    </div>
  );
}

function Field({ label, value, onChange, placeholder, type = 'text', multiline }: {
  label: string; value: string; onChange: (v: string) => void;
  placeholder?: string; type?: string; multiline?: boolean;
}) {
  return (
    <label className="block">
      <div className="mb-1 text-xs font-bold uppercase tracking-widest text-muted-foreground">{label}</div>
      {multiline ? (
        <textarea value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} rows={2} className="w-full rounded-md border border-border bg-input px-3 py-2" />
      ) : (
        <input type={type} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className="w-full rounded-md border border-border bg-input px-3 py-2" />
      )}
    </label>
  );
}

function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="block">
      <div className="mb-1 text-xs font-bold uppercase tracking-widest text-muted-foreground">{label}</div>
      <div className="flex items-center gap-2">
        <input type="color" value={value} onChange={(e) => onChange(e.target.value)} className="h-10 w-12 rounded border border-border" />
        <input value={value} onChange={(e) => onChange(e.target.value)} className="min-w-0 flex-1 rounded-md border border-border bg-input px-2 py-2 text-sm" />
      </div>
    </label>
  );
}

function ChipsField({ label, hint, values, setValues, input, setInput, placeholder }: {
  label: string; hint?: string;
  values: string[]; setValues: (v: string[]) => void;
  input: string; setInput: (v: string) => void;
  placeholder?: string;
}) {
  const add = () => {
    const v = input.trim();
    if (!v) return;
    if (values.some((x) => x.toLowerCase() === v.toLowerCase())) { setInput(''); return; }
    setValues([...values, v]);
    setInput('');
  };
  return (
    <div>
      <div className="mb-1 text-xs font-bold uppercase tracking-widest text-muted-foreground">{label}</div>
      {hint && <p className="mb-1 text-[11px] text-muted-foreground">{hint}</p>}
      <div className="flex gap-2">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
          placeholder={placeholder}
          className="flex-1 rounded-md border border-border bg-input px-3 py-2 text-sm"
        />
        <button type="button" onClick={add} className="rounded-md bg-primary px-3 py-2 text-primary-foreground"><Plus className="h-4 w-4" /></button>
      </div>
      <ul className="mt-2 flex flex-wrap gap-2">
        {values.map((a) => (
          <li key={a} className="inline-flex items-center gap-1 rounded-full border border-border bg-card px-3 py-1 text-xs">
            {a}
            <button type="button" onClick={() => setValues(values.filter((x) => x !== a))}><X className="h-3 w-3" /></button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function PlanCard({ selected, onSelect, title, bullets, icon, highlight }: {
  selected: boolean; onSelect: () => void; title: string; bullets: string[];
  icon: React.ReactNode; highlight?: boolean;
}) {
  return (
    <button
      type="button" onClick={onSelect}
      className={`w-full rounded-lg border p-4 text-left transition ${selected ? 'border-primary bg-primary/10' : 'border-border bg-card hover:border-primary/50'}`}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 font-black">{icon} {title}</div>
        {highlight && <span className="rounded-full bg-primary/20 px-2 py-0.5 text-[10px] font-bold uppercase text-primary">Popular</span>}
      </div>
      <ul className="mt-2 space-y-1 text-sm text-muted-foreground">
        {bullets.map((b) => <li key={b} className="flex items-start gap-1">• {b}</li>)}
      </ul>
      <div className="mt-2 text-xs text-primary">30-day free trial · No card required</div>
    </button>
  );
}

function PreviewCard({ name, logo, primary, secondary, hero, subhero, services, areas }: {
  name: string; logo: string | null; primary: string; secondary: string;
  hero: string; subhero: string; services: string[]; areas: string[];
}) {
  return (
    <div className="rounded-md p-4 text-white" style={{ background: `linear-gradient(180deg, ${secondary} 0%, #000 100%)` }}>
      <div className="flex items-center gap-2">
        {logo ? <img src={logo} alt="" className="h-8 w-8 rounded object-cover" /> : (
          <span className="grid h-8 w-8 place-items-center rounded font-black" style={{ background: primary }}>
            {name.split(' ').map((w) => w[0]).slice(0, 2).join('')}
          </span>
        )}
        <span className="font-black text-sm">{name}</span>
      </div>
      <div className="mt-3 text-lg font-black" style={{ color: primary }}>{hero}</div>
      <p className="mt-1 text-xs text-white/70">{subhero}</p>
      <span className="mt-2 inline-block rounded px-2 py-1 text-xs font-black" style={{ background: primary }}>Start job request</span>
      {services.length > 0 && (
        <div className="mt-3">
          <div className="text-[10px] uppercase tracking-widest text-white/60">Services</div>
          <div className="mt-1 flex flex-wrap gap-1">
            {services.map((s) => <span key={s} className="rounded bg-white/10 px-2 py-0.5 text-[11px]">{s}</span>)}
          </div>
        </div>
      )}
      {areas.length > 0 && (
        <div className="mt-3">
          <div className="text-[10px] uppercase tracking-widest text-white/60">Areas</div>
          <div className="mt-1 flex flex-wrap gap-1">
            {areas.map((a) => <span key={a} className="rounded bg-white/10 px-2 py-0.5 text-[11px]">{a}</span>)}
          </div>
        </div>
      )}
    </div>
  );
}