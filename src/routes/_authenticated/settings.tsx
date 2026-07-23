import { createFileRoute, Link } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { getMyBusiness, updateMyBusiness, setMyLicence, setMyCoverage, type EditableBusiness } from '@/lib/business-settings.functions';

export const Route = createFileRoute('/_authenticated/settings')({
  head: () => ({ meta: [{ title: 'Business settings' }] }),
  component: SettingsPage,
});

function SettingsPage() {
  const [biz, setBiz] = useState<EditableBusiness | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [licenceSaving, setLicenceSaving] = useState(false);
  const [licenceMsg, setLicenceMsg] = useState<string | null>(null);
  const [coverageSaving, setCoverageSaving] = useState(false);
  const [coverageMsg, setCoverageMsg] = useState<string | null>(null);

  useEffect(() => { void getMyBusiness().then((b) => setBiz(b)); }, []);

  const update = (patch: Partial<EditableBusiness>) => setBiz((b) => (b ? { ...b, ...patch } : b));

  const save = async () => {
    if (!biz) return;
    setSaving(true); setMessage(null);
    try { await updateMyBusiness({ data: biz }); setMessage('Saved.'); }
    catch (e) { setMessage(e instanceof Error ? e.message : 'Save failed'); }
    finally { setSaving(false); }
  };

  const saveLicence = async () => {
    if (!biz) return;
    setLicenceSaving(true); setLicenceMsg(null);
    try {
      await setMyLicence({ data: {
        licence_number: biz.licence_number ?? null,
        licence_holder_name: biz.licence_holder_name ?? null,
        licence_expiry: biz.licence_expiry ?? null,
        licence_public: biz.licence_public ?? false,
      } });
      setLicenceMsg('Licence details saved.');
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Save failed';
      if (/licence_(number|holder_name|expiry|public)|does not exist|not found|could not find/i.test(msg)) {
        setLicenceMsg('Licence fields will persist once the Phase 1 database update is applied.');
      } else {
        setLicenceMsg(msg);
      }
    } finally { setLicenceSaving(false); }
  };

  const saveCoverage = async () => {
    if (!biz) return;
    setCoverageSaving(true); setCoverageMsg(null);
    try {
      await setMyCoverage({ data: {
        base_suburb: biz.base_suburb ?? null,
        base_state: biz.base_state ?? null,
        base_postcode: biz.base_postcode ?? null,
        travel_radius_km: biz.travel_radius_km ?? null,
        region_labels: biz.region_labels ?? [],
        postcode_ranges: biz.postcode_ranges ?? [],
        excluded_areas: biz.excluded_areas ?? [],
      } });
      setCoverageMsg('Coverage saved.');
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Save failed';
      if (/(base_suburb|travel_radius_km|region_labels|postcode_ranges|excluded_areas|does not exist|not found|could not find)/i.test(msg)) {
        setCoverageMsg('Coverage fields will persist once the Phase 1 database update is applied.');
      } else {
        setCoverageMsg(msg);
      }
    } finally { setCoverageSaving(false); }
  };

  if (!biz) return <div className="p-8 text-sm text-muted-foreground">Loading…</div>;

  return (
    <div className="mx-auto max-w-5xl px-4 py-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-black">Business settings</h1>
          <p className="text-sm text-muted-foreground">Editing <span className="font-bold">{biz.name}</span> — public page at <Link to="/b/$slug" params={{ slug: biz.slug }} className="underline">/b/{biz.slug}</Link></p>
        </div>
        <Link to="/dashboard" className="text-sm underline">← Dashboard</Link>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_360px]">
        <div className="space-y-4">
          <Field label="Business name" value={biz.name} onChange={(v) => update({ name: v })} />
          <Field label="Public phone" value={biz.public_phone ?? ''} onChange={(v) => update({ public_phone: v })} />
          <Field label="Public email" value={biz.public_email ?? ''} onChange={(v) => update({ public_email: v })} />
          <Field label="Logo URL" value={biz.logo_url ?? ''} onChange={(v) => update({ logo_url: v })} placeholder="https://…" />
          <div className="grid grid-cols-3 gap-3">
            <ColorField label="Primary" value={biz.primary_colour ?? '#0EA5E9'} onChange={(v) => update({ primary_colour: v })} />
            <ColorField label="Secondary" value={biz.secondary_colour ?? '#0B2545'} onChange={(v) => update({ secondary_colour: v })} />
            <ColorField label="Accent" value={biz.accent_colour ?? '#67E8F9'} onChange={(v) => update({ accent_colour: v })} />
          </div>
          <Field label="Short description" value={biz.short_description ?? ''} onChange={(v) => update({ short_description: v })} />
          <Field label="Hero heading" value={biz.hero_heading ?? ''} onChange={(v) => update({ hero_heading: v })} />
          <Field label="Hero subheading" value={biz.hero_subheading ?? ''} onChange={(v) => update({ hero_subheading: v })} multiline />
          <Field label="Emergency message" value={biz.emergency_message ?? ''} onChange={(v) => update({ emergency_message: v })} />
          <div className="flex items-center gap-3">
            <button onClick={() => { void save(); }} disabled={saving} className="rounded-md bg-primary px-5 py-3 font-black text-primary-foreground disabled:opacity-40">
              {saving ? 'Saving…' : 'Save changes'}
            </button>
            {message && <span className="text-sm text-muted-foreground">{message}</span>}
          </div>

          <section className="mt-8 rounded-lg border border-border bg-card p-4 space-y-3">
            <h2 className="text-sm uppercase tracking-widest text-muted-foreground">Service coverage</h2>
            <p className="text-xs text-muted-foreground">Where you're based and how far you'll travel. This replaces suburb-by-suburb entry as the primary way to describe your service area — suburb lists are still available in the setup wizard's Advanced section.</p>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              <Field label="Base suburb" value={biz.base_suburb ?? ''} onChange={(v) => update({ base_suburb: v || null })} />
              <Field label="State" value={biz.base_state ?? ''} onChange={(v) => update({ base_state: v || null })} />
              <Field label="Postcode" value={biz.base_postcode ?? ''} onChange={(v) => update({ base_postcode: v || null })} />
            </div>
            <Field label="Travel radius (km, 0–500)" value={biz.travel_radius_km == null ? '' : String(biz.travel_radius_km)} onChange={(v) => update({ travel_radius_km: v === '' ? null : Math.max(0, Math.min(500, Number(v) || 0)) })} />
            <Field label="Region labels (comma-separated)" value={(biz.region_labels ?? []).join(', ')} onChange={(v) => update({ region_labels: v.split(',').map((s) => s.trim()).filter(Boolean) })} />
            <Field label="Postcode ranges (comma-separated, e.g. 3000-3199, 3121)" value={(biz.postcode_ranges ?? []).join(', ')} onChange={(v) => update({ postcode_ranges: v.split(',').map((s) => s.trim()).filter(Boolean) })} />
            <Field label="Exclusions (comma-separated)" value={(biz.excluded_areas ?? []).join(', ')} onChange={(v) => update({ excluded_areas: v.split(',').map((s) => s.trim()).filter(Boolean) })} />
            <div className="flex items-center gap-3">
              <button onClick={() => { void saveCoverage(); }} disabled={coverageSaving} className="rounded-md border border-border bg-card px-4 py-2 font-bold disabled:opacity-40">
                {coverageSaving ? 'Saving…' : 'Save coverage'}
              </button>
              {coverageMsg && <span className="text-xs text-muted-foreground">{coverageMsg}</span>}
            </div>
          </section>

          <section className="mt-4 rounded-lg border border-border bg-card p-4 space-y-3">
            <h2 className="text-sm uppercase tracking-widest text-muted-foreground">Business profile — licence</h2>
            <p className="text-xs text-muted-foreground">
              Optional now. A future <b>Go Live</b> step is expected to require and validate these fields. We do not perform any external verification here — values are stored as-is. Public display is off by default; the toggle only takes effect on your public tenant site.
            </p>
            <Field label="Registration / licence number" value={biz.licence_number ?? ''} onChange={(v) => update({ licence_number: v || null })} placeholder="e.g. VIC-12345" />
            <Field label="Licence holder name" value={biz.licence_holder_name ?? ''} onChange={(v) => update({ licence_holder_name: v || null })} />
            <Field label="Expiry (YYYY-MM-DD)" value={biz.licence_expiry ?? ''} onChange={(v) => update({ licence_expiry: v || null })} placeholder="2028-12-31" />
            <label className="inline-flex items-center gap-2 text-sm">
              <input type="checkbox" checked={Boolean(biz.licence_public)} onChange={(e) => update({ licence_public: e.target.checked })} />
              Display licence details on my public tenant site
            </label>
            <div className="flex items-center gap-3">
              <button onClick={() => { void saveLicence(); }} disabled={licenceSaving} className="rounded-md border border-border bg-card px-4 py-2 font-bold disabled:opacity-40">
                {licenceSaving ? 'Saving…' : 'Save licence'}
              </button>
              {licenceMsg && <span className="text-xs text-muted-foreground">{licenceMsg}</span>}
            </div>
          </section>
        </div>

        <aside className="rounded-lg border border-border bg-card p-4">
          <div className="text-xs uppercase tracking-widest text-muted-foreground mb-2">Live preview</div>
          <div className="rounded-md p-5 text-white" style={{ background: `linear-gradient(180deg, ${biz.secondary_colour ?? '#0B2545'} 0%, #000 100%)` }}>
            <div className="flex items-center gap-2">
              {biz.logo_url ? (
                <img src={biz.logo_url} alt="" className="h-8 w-8 rounded object-cover" />
              ) : (
                <span className="grid h-8 w-8 place-items-center rounded font-black" style={{ background: biz.primary_colour ?? '#0EA5E9' }}>
                  {biz.name.split(' ').map((w: string) => w[0]).slice(0, 2).join('')}
                </span>
              )}
              <span className="font-black">{biz.name}</span>
            </div>
            <div className="mt-4 text-xl font-black" style={{ color: biz.primary_colour ?? '#0EA5E9' }}>{biz.hero_heading || 'Your hero heading'}</div>
            <p className="mt-2 text-sm text-white/70">{biz.hero_subheading || 'Your hero subheading appears here.'}</p>
            <div className="mt-3">
              <span className="inline-block rounded px-3 py-2 text-sm font-black" style={{ background: biz.primary_colour ?? '#0EA5E9' }}>Start job request</span>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}

function Field({ label, value, onChange, placeholder, multiline }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string; multiline?: boolean }) {
  return (
    <label className="block">
      <div className="mb-1 text-xs font-bold uppercase tracking-widest text-muted-foreground">{label}</div>
      {multiline ? (
        <textarea value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} rows={2} className="w-full rounded-md border border-border bg-input px-3 py-2" />
      ) : (
        <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className="w-full rounded-md border border-border bg-input px-3 py-2" />
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