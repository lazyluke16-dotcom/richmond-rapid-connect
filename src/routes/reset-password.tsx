import { createFileRoute, useRouter } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { AppShell } from '@/components/AppShell';
import { Lock } from 'lucide-react';

export const Route = createFileRoute('/reset-password')({
  head: () => ({
    meta: [
      { title: 'Reset password — Richmond Rapid Connect' },
      { name: 'description', content: 'Set a new password for your plumber dashboard.' },
      { name: 'robots', content: 'noindex' },
    ],
  }),
  component: ResetPasswordPage,
});

function ResetPasswordPage() {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    // Supabase v2 places recovery tokens in the URL hash and auto-establishes
    // a temporary session via detectSessionInUrl. We wait for that session.
    const { data: sub } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'PASSWORD_RECOVERY' || event === 'SIGNED_IN') setReady(true);
    });
    void (async () => {
      const { data } = await supabase.auth.getSession();
      if (data.session) setReady(true);
    })();
    return () => sub.subscription.unsubscribe();
  }, []);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (password.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }
    if (password !== confirm) {
      setError('Passwords do not match.');
      return;
    }
    setSubmitting(true);
    const { error: err } = await supabase.auth.updateUser({ password });
    setSubmitting(false);
    if (err) {
      setError(err.message);
      return;
    }
    setDone(true);
    setTimeout(() => {
      void router.navigate({ to: '/dashboard', replace: true });
    }, 1200);
  };

  return (
    <AppShell showCallBar={false}>
      <div className="mx-auto max-w-md px-4 py-16">
        <div className="rounded-lg border border-border bg-card p-6">
          <div className="mb-4 flex items-center gap-2 text-primary">
            <Lock className="h-5 w-5" />
            <div className="text-xs font-bold uppercase tracking-widest">Set new password</div>
          </div>
          <h1 className="text-2xl font-black">Choose a new password</h1>
          {!ready ? (
            <p className="mt-4 text-sm text-muted-foreground">
              Waiting for a valid password reset link. Open this page from the email link.
            </p>
          ) : done ? (
            <p className="mt-4 text-sm">Password updated. Redirecting to your dashboard…</p>
          ) : (
            <form onSubmit={onSubmit} className="mt-6 space-y-4">
              <label className="block">
                <div className="mb-1 text-xs font-bold uppercase tracking-widest text-muted-foreground">New password</div>
                <input
                  type="password"
                  autoComplete="new-password"
                  required
                  minLength={8}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full rounded-md border border-border bg-input px-3 py-3 text-base"
                />
              </label>
              <label className="block">
                <div className="mb-1 text-xs font-bold uppercase tracking-widest text-muted-foreground">Confirm new password</div>
                <input
                  type="password"
                  autoComplete="new-password"
                  required
                  minLength={8}
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  className="w-full rounded-md border border-border bg-input px-3 py-3 text-base"
                />
              </label>
              {error && (
                <div className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-sm text-destructive">
                  {error}
                </div>
              )}
              <button
                type="submit"
                disabled={submitting}
                className="w-full rounded-md bg-primary px-5 py-3 text-base font-black text-primary-foreground disabled:opacity-40"
              >
                {submitting ? 'Updating…' : 'Update password'}
              </button>
            </form>
          )}
        </div>
      </div>
    </AppShell>
  );
}