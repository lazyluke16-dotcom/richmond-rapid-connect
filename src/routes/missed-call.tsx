import { createFileRoute, Link } from '@tanstack/react-router';
import { AppShell } from '@/components/AppShell';
import { DemoSmsPreview } from '@/components/DemoSmsPreview';
import { useState } from 'react';
import { Phone, ArrowRight, CheckCircle2 } from 'lucide-react';

export const Route = createFileRoute('/missed-call')({
  head: () => ({ meta: [{ title: 'Missed-call demo — Richmond Rapid Plumbing' }] }),
  component: MissedCallPage,
});

function MissedCallPage() {
  const [callerPhone, setCallerPhone] = useState('');
  const [step, setStep] = useState<'idle' | 'sending' | 'sent'>('idle');
  const [smsBody, setSmsBody] = useState('');
  const [missedCallId, setMissedCallId] = useState('');

  const handleSend = async () => {
    if (!callerPhone.trim()) return;
    setStep('sending');
    const res = await fetch('/api/demo/trigger-sms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callerPhone: callerPhone.trim() }),
    });
    const json = (await res.json()) as { missedCallId: string; smsBody: string };
    setMissedCallId(json.missedCallId);
    setSmsBody(json.smsBody);
    setStep('sent');
  };

  return (
    <AppShell showCallBar={false}>
      <div className="mx-auto max-w-2xl px-4 py-10">
        <div className="inline-flex items-center gap-2 rounded-full border border-primary/40 bg-primary/10 px-3 py-1 text-xs font-bold uppercase tracking-widest text-primary mb-6">
          <span className="inline-block h-2 w-2 rounded-full bg-primary animate-pulse" /> Demo mode
        </div>
        <h1 className="text-3xl font-black sm:text-4xl">Missed-call recovery demo</h1>
        <p className="mt-2 text-muted-foreground">
          This simulates what happens when a caller rings and the plumber doesn't answer. Enter a phone number — the system shows the SMS that would be sent with a job-request recovery link.
        </p>

        <div className="mt-8 flex flex-wrap gap-2 items-center text-sm">
          {['Caller rings', 'Call missed', 'Auto SMS fired', 'Caller taps link', 'Form submitted', 'Lead on dashboard'].map((s, i, arr) => (
            <div key={s} className="flex items-center gap-2">
              <div className="rounded-full bg-primary/10 border border-primary/30 px-3 py-1 text-xs font-semibold text-primary whitespace-nowrap">{s}</div>
              {i < arr.length - 1 && <ArrowRight className="h-3 w-3 text-muted-foreground shrink-0" />}
            </div>
          ))}
        </div>

        <div className="mt-8 rounded-lg border border-border bg-card p-6 space-y-4">
          <div className="text-sm font-bold uppercase tracking-widest text-muted-foreground">Step 1 — Simulate a missed call</div>
          <label className="block">
            <div className="mb-2 text-sm font-semibold">Caller phone number</div>
            <input
              inputMode="tel"
              value={callerPhone}
              onChange={(e) => setCallerPhone(e.target.value)}
              placeholder="e.g. 0412 345 678"
              disabled={step === 'sent'}
              className="w-full rounded-md border border-border bg-input px-3 py-3 text-base disabled:opacity-50"
            />
          </label>
          {step !== 'sent' && (
            <button
              onClick={() => { void handleSend(); }}
              disabled={!callerPhone.trim() || step === 'sending'}
              className="inline-flex w-full items-center justify-center gap-2 rounded-md bg-primary px-5 py-4 text-base font-black text-primary-foreground disabled:opacity-40"
            >
              <Phone className="h-5 w-5" />
              {step === 'sending' ? 'Sending recovery SMS…' : 'Trigger missed-call recovery SMS'}
            </button>
          )}
        </div>

        {step === 'sent' && smsBody && (
          <div className="mt-6 space-y-4">
            <div className="flex items-center gap-2 text-sm font-bold text-primary">
              <CheckCircle2 className="h-5 w-5" /> Recovery SMS logged
            </div>
            <DemoSmsPreview to={callerPhone} body={smsBody} status="simulated" />
            <div className="rounded-lg border border-border bg-card p-5 space-y-3">
              <div className="text-sm font-bold uppercase tracking-widest text-muted-foreground">Step 2 — Caller taps the link</div>
              <p className="text-sm text-muted-foreground">In a real scenario the caller taps the link. Click below to continue the demo as the customer:</p>
              <Link
                to="/request"
                search={{ source: 'missed_call', mcid: missedCallId } as never}
                className="inline-flex w-full items-center justify-center gap-2 rounded-md bg-primary px-5 py-4 text-base font-black text-primary-foreground"
              >
                Continue as customer — start job request <ArrowRight className="h-5 w-5" />
              </Link>
            </div>
          </div>
        )}
      </div>
    </AppShell>
  );
}