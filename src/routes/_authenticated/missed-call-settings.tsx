import { createFileRoute, Link, useRouter } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { useMyTenantBrand } from '@/hooks/use-my-tenant-brand';
import { DemoSmsPreview } from '@/components/DemoSmsPreview';
import {
  getMyMissedCallContext,
  updateMyMissedCallSettings,
  sendTestMissedCall,
  type MissedCallContext,
} from '@/lib/missed-call.functions';
import { AlertTriangle, CheckCircle2, PhoneCall, Save, Send, Settings } from 'lucide-react';

export const Route = createFileRoute('/_authenticated/missed-call-settings')({
  head: () => ({ meta: [{ title: 'Missed-call recovery — settings' }] }),
  component: MissedCallSettingsPage,
});

function MissedCallSettingsPage() {
  const router = useRouter();
  const [ctx, setCtx] = useState<MissedCallContext | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const [callerPhone, setCallerPhone] = useState('0412 000 111');
  const [testResult, setTestResult] = useState<{
    smsBody: string; recoveryLink: string; missedCallId: string; simulated: boolean; businessSlug: string;
  } | null>(null);
  const [testing, setTesting] = useState(false);
  const tenant = useMyTenantBrand();

  const load = async () => {
    try {
      const c = await getMyMissedCallContext();
      setCtx(c);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load');
    }
  };
  useEffect(() => { void load(); }, []);

  if (error) return (
    <AppShell showCallBar={false} tenant={tenant} hidePublicNav><div className="mx-auto max-w-3xl px-4 py-10 text-destructive">{error}</div></AppShell>
  );
  if (!ctx) return (
    <AppShell showCallBar={false} tenant={tenant} hidePublicNav><div className="mx-auto max-w-3xl px-4 py-10 text-muted-foreground">Loading…</div></AppShell>
  );

  const s = ctx.settings;
  const set = (patch: Partial<typeof s>) => setCtx({ ...ctx, settings: { ...s, ...patch } });

  const save = async () => {
    setSaving(true);
    try {
      await updateMyMissedCallSettings({ data: {
        enabled: s.enabled,
        mode: s.mode,
        recovery_sms_enabled: s.recovery_sms_enabled,
        sms_template: s.sms_template,
        plumber_alert_enabled: s.plumber_alert_enabled,
        alert_method: s.alert_method,
        alert_phone: s.alert_phone,
        alert_email: s.alert_email,
        callback_message: s.callback_message,
      } });
      setSavedAt(Date.now());
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const runTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const baseUrl = typeof window !== 'undefined' ? window.location.origin : undefined;
      const r = await sendTestMissedCall({ data: { callerPhone, baseUrl } });
      setTestResult(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Test failed');
    } finally {
      setTesting(false);
    }
  };

  const gated = !ctx.has_access;
  const featureStateLabel: Record<string, string> = {
    setup: 'Setup — choose a plan',
    trial_active: 'Trial active',
    trial_expired: 'Trial expired',
    active: 'Active',
    suspended: 'Suspended',
    unknown: 'Unknown',
  };

  return (
    <AppShell showCallBar={false} tenant={tenant} hidePublicNav>
      <div className="mx-auto max-w-3xl px-4 py-6 space-y-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="text-xs uppercase tracking-widest text-primary">Product settings</div>
            <h1 className="text-2xl font-black sm:text-3xl">Missed-call recovery</h1>
            <p className="text-sm text-muted-foreground">Configure the SMS your callers receive when you miss a call, and the alert you get when a lead comes back.</p>
          </div>
          <Link to="/dashboard" className="text-sm underline text-muted-foreground">← Dashboard</Link>
        </div>

        <div className="rounded-md border border-border bg-card p-4 flex flex-wrap items-center gap-3 text-sm">
          <span className="rounded-full border border-primary/40 bg-primary/10 px-3 py-1 text-xs font-bold uppercase tracking-widest text-primary">
            {ctx.sms_mode === 'twilio' && s.mode === 'live' ? 'LIVE' : 'DEMO MODE'}
          </span>
          <span className="rounded-full border border-border px-3 py-1 text-xs">Plan: <b>{ctx.business.selected_plan ?? 'none'}</b></span>
          <span className="rounded-full border border-border px-3 py-1 text-xs">{featureStateLabel[ctx.feature_state] ?? ctx.feature_state}</span>
          {ctx.business.trial_ends_at && (
            <span className="text-xs text-muted-foreground">Trial ends: {new Date(ctx.business.trial_ends_at).toLocaleDateString()}</span>
          )}
        </div>

        {gated && (
          <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm flex items-start gap-2">
            <AlertTriangle className="h-4 w-4 mt-0.5 text-amber-500" />
            <div>Your current plan/trial state does not include missed-call recovery. Enable it once you're on the Missed-Call Recovery or AI Receptionist plan.</div>
          </div>
        )}

        <section className="rounded-lg border border-border bg-card p-5 space-y-4">
          <div className="flex items-center gap-2 text-sm font-bold uppercase tracking-widest text-muted-foreground"><Settings className="h-4 w-4" /> Recovery SMS</div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={s.enabled} disabled={gated}
              onChange={(e) => set({ enabled: e.target.checked })} />
            <span>Enable missed-call recovery</span>
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={s.recovery_sms_enabled}
              onChange={(e) => set({ recovery_sms_enabled: e.target.checked })} />
            <span>Send recovery SMS to the caller</span>
          </label>
          <label className="block">
            <div className="mb-1 text-xs font-bold uppercase tracking-widest text-muted-foreground">Mode</div>
            <select value={s.mode} onChange={(e) => set({ mode: e.target.value as 'demo' | 'live' })}
              className="rounded-md border border-border bg-input px-3 py-2 text-sm">
              <option value="demo">Demo (safe — no real SMS)</option>
              <option value="live" disabled={ctx.sms_mode !== 'twilio'}>Live {ctx.sms_mode !== 'twilio' ? '(disabled — SMS gateway not configured)' : ''}</option>
            </select>
          </label>
          <label className="block">
            <div className="mb-1 text-xs font-bold uppercase tracking-widest text-muted-foreground">SMS template</div>
            <textarea rows={4} value={s.sms_template}
              onChange={(e) => set({ sms_template: e.target.value })}
              className="w-full rounded-md border border-border bg-input px-3 py-2 text-sm font-mono" />
            <div className="mt-1 text-xs text-muted-foreground">Variables: <code>{'{{business_name}}'}</code> <code>{'{{recovery_link}}'}</code> <code>{'{{public_phone}}'}</code></div>
          </label>
        </section>

        <section className="rounded-lg border border-border bg-card p-5 space-y-4">
          <div className="flex items-center gap-2 text-sm font-bold uppercase tracking-widest text-muted-foreground"><PhoneCall className="h-4 w-4" /> Plumber alerts</div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={s.plumber_alert_enabled}
              onChange={(e) => set({ plumber_alert_enabled: e.target.checked })} />
            <span>Alert me when a recovered lead comes in</span>
          </label>
          <label className="block">
            <div className="mb-1 text-xs font-bold uppercase tracking-widest text-muted-foreground">Alert method</div>
            <select value={s.alert_method} onChange={(e) => set({ alert_method: e.target.value as 'demo' | 'sms' | 'email' })}
              className="rounded-md border border-border bg-input px-3 py-2 text-sm">
              <option value="demo">Demo log</option>
              <option value="sms">SMS (requires live SMS gateway)</option>
              <option value="email">Email (placeholder)</option>
            </select>
          </label>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <div className="mb-1 text-xs font-bold uppercase tracking-widest text-muted-foreground">Alert phone (private)</div>
              <input value={s.alert_phone ?? ''} onChange={(e) => set({ alert_phone: e.target.value })}
                className="w-full rounded-md border border-border bg-input px-3 py-2 text-sm" />
            </label>
            <label className="block">
              <div className="mb-1 text-xs font-bold uppercase tracking-widest text-muted-foreground">Alert email (private)</div>
              <input value={s.alert_email ?? ''} onChange={(e) => set({ alert_email: e.target.value })}
                className="w-full rounded-md border border-border bg-input px-3 py-2 text-sm" />
            </label>
          </div>
        </section>

        <div className="flex items-center gap-3">
          <button onClick={() => { void save(); }} disabled={saving}
            className="inline-flex items-center gap-2 rounded-md bg-primary px-5 py-3 text-sm font-black text-primary-foreground disabled:opacity-40">
            <Save className="h-4 w-4" /> {saving ? 'Saving…' : 'Save settings'}
          </button>
          {savedAt && <span className="text-xs text-muted-foreground">Saved.</span>}
        </div>

        <section className="rounded-lg border border-border bg-card p-5 space-y-4">
          <div className="flex items-center gap-2 text-sm font-bold uppercase tracking-widest text-muted-foreground"><Send className="h-4 w-4" /> Send a test missed call</div>
          <p className="text-sm text-muted-foreground">Creates a real missed-call + SMS event scoped to your business only. In demo mode nothing leaves the system.</p>
          <div className="flex flex-wrap items-end gap-2">
            <label className="block flex-1 min-w-[200px]">
              <div className="mb-1 text-xs font-bold uppercase tracking-widest text-muted-foreground">Caller phone</div>
              <input value={callerPhone} onChange={(e) => setCallerPhone(e.target.value)}
                className="w-full rounded-md border border-border bg-input px-3 py-2 text-sm" />
            </label>
            <button onClick={() => { void runTest(); }} disabled={testing || gated}
              className="rounded-md bg-primary px-4 py-2 text-sm font-black text-primary-foreground disabled:opacity-40">
              {testing ? 'Triggering…' : 'Send test missed call'}
            </button>
          </div>
          {testResult && (
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-sm font-bold text-primary"><CheckCircle2 className="h-4 w-4" /> Test dispatched</div>
              <DemoSmsPreview to={callerPhone} body={testResult.smsBody} status={testResult.simulated ? 'simulated' : 'sent'} />
              <div className="text-xs text-muted-foreground break-all">Recovery link: <a className="underline" href={testResult.recoveryLink} target="_blank" rel="noreferrer">{testResult.recoveryLink}</a></div>
              <Link to="/b/$slug/request" params={{ slug: testResult.businessSlug }}
                search={{ source: 'missed_call', mcid: testResult.missedCallId } as never}
                className="inline-block rounded-md border border-border px-3 py-2 text-xs font-bold">
                Continue as customer →
              </Link>
            </div>
          )}
        </section>
      </div>
    </AppShell>
  );
}