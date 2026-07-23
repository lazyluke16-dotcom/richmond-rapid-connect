import { createFileRoute, Link, getRouteApi } from '@tanstack/react-router';
import { useState } from 'react';
import { DemoSmsPreview } from '@/components/DemoSmsPreview';

const parentRoute = getRouteApi('/b/$slug');

export const Route = createFileRoute('/b/$slug/missed-call')({
  component: TenantMissedCall,
});

function TenantMissedCall() {
  const bundle = parentRoute.useLoaderData();
  const { slug } = Route.useParams();
  const b = bundle.business;
  const [phone, setPhone] = useState('0412 000 111');
  const [smsBody, setSmsBody] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  const send = async () => {
    setSending(true);
    try {
      const res = await fetch('/api/demo/trigger-sms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callerPhone: phone, businessSlug: slug }),
      });
      const j = await res.json();
      if (j.smsBody) setSmsBody(j.smsBody);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="mx-auto max-w-2xl px-4 py-10">
      <h1 className="text-3xl font-black">Missed-call recovery — {b.name}</h1>
      <p className="mt-2 text-muted-foreground">Simulates a customer calling and being sent a recovery SMS with a tenant-specific link.</p>
      <div className="mt-6 space-y-3">
        <label className="block">
          <div className="mb-1 text-sm font-bold uppercase tracking-widest text-muted-foreground">Caller number</div>
          <input value={phone} onChange={(e) => setPhone(e.target.value)} className="w-full rounded-md border border-border bg-input px-3 py-3" />
        </label>
        <button onClick={() => { void send(); }} disabled={sending} className="rounded-md px-5 py-3 font-black text-white disabled:opacity-40" style={{ background: 'var(--tenant-primary)' }}>
          {sending ? 'Sending…' : 'Send recovery SMS'}
        </button>
      </div>
      {smsBody && (
        <div className="mt-6">
          <DemoSmsPreview to={phone} body={smsBody} status="simulated" />
          <Link to="/b/$slug/request" params={{ slug }} className="mt-4 inline-block text-sm underline">Continue as the customer →</Link>
        </div>
      )}
    </div>
  );
}