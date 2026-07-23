import { createFileRoute, useRouter } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { AppShell } from '@/components/AppShell';
import { Lock } from 'lucide-react';

export const Route = createFileRoute('/auth')({
  head: () => ({
    meta: [
      { title: 'Plumber sign-in — Richmond Rapid Connect' },
      { name: 'description', content: 'Sign in to your plumber dashboard.' },
      { name: 'robots', content: 'noindex' },
    ],
  }),
  validateSearch: (s: Record<string, unknown>) => ({
    next: typeof s.next === 'string' && s.next.startsWith('/') && !s.next.startsWith('//') ? s.next : undefined,
  }),
  component: AuthPage,
});

function AuthPage() {
  const router = useRouter();
  const { next } = Route.useSearch();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resetMsg, setResetMsg] = useState<string | null>(null);
  const [resetting, setResetting] = useState(false);

  useEffect(() => {
    // Already signed in? Send them to the dashboard.
    void (async () => {
      const { data } = await supabase.auth.getUser();
      if (data.user) {
        if (next) { window.location.href = next; return; }
        await router.navigate({ to: '/dashboard', replace: true });
      }
    })();
  }, [router, next]);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    const { error: err } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password,
    });
    setSubmitting(false);
    if (err) {
      setError(err.message);
      return;
    }
    if (next) { window.location.href = next; return; }
    await router.navigate({ to: '/dashboard', replace: true });
  };

  const onForgotPassword = async () => {
    setError(null);
    setResetMsg(null);
    const target = email.trim();
    if (!target) {
      setError('Enter your email above first, then click "Forgot password?".');
      return;
    }
    setResetting(true);
    const { error: err } = await supabase.auth.resetPasswordForEmail(target, {
      redirectTo: `${window.location.origin}/reset-password`,
    });
    setResetting(false);
    if (err) {
      setError(err.message);
      return;
    }
    setResetMsg(`If an account exists for ${target}, a password reset link has been sent. Check your inbox (and spam).`);
  };

  return (
    <AppShell showCallBar={false}>
      <div className="mx-auto max-w-md px-4 py-16">
        <div className="rounded-lg border border-border bg-card p-6">
          <div className="mb-4 flex items-center gap-2 text-primary">
            <Lock className="h-5 w-5" />
            <div className="text-xs font-bold uppercase tracking-widest">Plumber sign-in</div>
          </div>
          <h1 className="text-2xl font-black">Sign in to your dashboard</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Only authorised plumbers for this business can access the missed-job inbox.
          </p>
          <form onSubmit={onSubmit} className="mt-6 space-y-4">
            <label className="block">
              <div className="mb-1 text-xs font-bold uppercase tracking-widest text-muted-foreground">Email</div>
              <input
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full rounded-md border border-border bg-input px-3 py-3 text-base"
              />
            </label>
            <label className="block">
              <div className="mb-1 text-xs font-bold uppercase tracking-widest text-muted-foreground">Password</div>
              <input
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full rounded-md border border-border bg-input px-3 py-3 text-base"
              />
            </label>
            {error && (
              <div className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-sm text-destructive">
                {error}
              </div>
            )}
            {resetMsg && (
              <div className="rounded-md border border-primary/40 bg-primary/10 p-2 text-sm">
                {resetMsg}
              </div>
            )}
            <button
              type="submit"
              disabled={submitting}
              className="w-full rounded-md bg-primary px-5 py-3 text-base font-black text-primary-foreground disabled:opacity-40"
            >
              {submitting ? 'Signing in…' : 'Sign in'}
            </button>
            <button
              type="button"
              onClick={onForgotPassword}
              disabled={resetting}
              className="w-full text-left text-xs text-primary underline disabled:opacity-40"
            >
              {resetting ? 'Sending reset link…' : 'Forgot password?'}
            </button>
          </form>
          <p className="mt-4 text-xs text-muted-foreground">
            New plumber? <a href="/signup" className="text-primary underline">Create your account</a> and set up your branded site in minutes.
          </p>
        </div>
      </div>
    </AppShell>
  );
}