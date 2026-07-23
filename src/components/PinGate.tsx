import { useState, useEffect, type ReactNode } from 'react';
import { Lock, LogOut } from 'lucide-react';

interface PinGateProps {
  children: ReactNode;
}

export function PinGate({ children }: PinGateProps) {
  const [authed, setAuthed] = useState(false);
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [checking, setChecking] = useState(false);
  const [noPinSet, setNoPinSet] = useState(false);

  useEffect(() => {
    if (typeof sessionStorage !== 'undefined' && sessionStorage.getItem('rrp_dashboard_authed') === '1') {
      setAuthed(true);
    }
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setChecking(true);
    try {
      const res = await fetch('/api/dashboard/verify-pin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin }),
      });
      const json = (await res.json()) as { ok: boolean; noPinSet?: boolean; error?: string };
      if (json.noPinSet) {
        setNoPinSet(true);
        setAuthed(true);
        sessionStorage.setItem('rrp_dashboard_authed', '1');
      } else if (json.ok) {
        setAuthed(true);
        sessionStorage.setItem('rrp_dashboard_authed', '1');
      } else {
        setError('Incorrect PIN. Try again.');
        setPin('');
      }
    } catch {
      setError('Could not verify PIN. Try again.');
    } finally {
      setChecking(false);
    }
  };

  const handleLogout = () => {
    sessionStorage.removeItem('rrp_dashboard_authed');
    setAuthed(false);
    setPin('');
  };

  if (authed) {
    return (
      <div>
        {noPinSet && (
          <div className="mx-auto max-w-6xl px-4 pt-4">
            <div className="rounded-md border border-yellow-500/40 bg-yellow-500/10 px-4 py-3 text-sm text-yellow-400">
              <strong>No PIN set.</strong> Set <code>DASHBOARD_PIN</code> in environment variables to secure this view.
            </div>
          </div>
        )}
        <div className="flex justify-end px-4 pt-4 max-w-6xl mx-auto">
          <button
            onClick={handleLogout}
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-1.5 text-xs font-semibold text-muted-foreground hover:text-foreground"
          >
            <LogOut className="h-3.5 w-3.5" /> Lock dashboard
          </button>
        </div>
        {children}
      </div>
    );
  }

  return (
    <div className="flex min-h-[60vh] items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="grid h-12 w-12 place-items-center rounded-full bg-primary/10 text-primary mb-4">
          <Lock className="h-6 w-6" />
        </div>
        <h2 className="text-xl font-black">Plumber dashboard</h2>
        <p className="mt-1 text-sm text-muted-foreground">Enter your dashboard PIN to continue.</p>
        <form onSubmit={handleSubmit} className="mt-6 space-y-3">
          <input
            type="password"
            inputMode="numeric"
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            placeholder="PIN"
            maxLength={12}
            autoFocus
            className="w-full rounded-md border border-border bg-input px-3 py-3 text-base tracking-widest"
          />
          {error && <p className="text-sm text-destructive">{error}</p>}
          <button
            type="submit"
            disabled={!pin.trim() || checking}
            className="inline-flex w-full items-center justify-center gap-2 rounded-md bg-primary px-5 py-3 text-base font-black text-primary-foreground disabled:opacity-40"
          >
            {checking ? 'Checking…' : 'Unlock'}
          </button>
        </form>
      </div>
    </div>
  );
}