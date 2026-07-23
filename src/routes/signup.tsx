import { createFileRoute, useRouter, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { AppShell } from "@/components/AppShell";
import { UserPlus } from "lucide-react";

export const Route = createFileRoute("/signup")({
  head: () => ({
    meta: [
      { title: "Create your plumber account — Rapid Connect" },
      { name: "description", content: "Set up your branded job-capture website in minutes." },
      { name: "robots", content: "noindex" },
    ],
  }),
  validateSearch: (s: Record<string, unknown>) => ({
    partner: typeof s.partner === "string" ? s.partner : undefined,
    ref: typeof s.ref === "string" ? s.ref : undefined,
  }),
  component: SignupPage,
});

function SignupPage() {
  const router = useRouter();
  const { partner, ref } = Route.useSearch();
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const { data } = await supabase.auth.getUser();
      if (data.user) await router.navigate({ to: "/onboarding", replace: true });
    })();
  }, [router]);

  // Persist partner/ref attribution client-side so it survives the auth roundtrip.
  useEffect(() => {
    if (partner) sessionStorage.setItem("rc_partner", partner);
    if (ref) sessionStorage.setItem("rc_ref", ref);
  }, [partner, ref]);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    const { data, error: err } = await supabase.auth.signUp({
      email: email.trim(),
      password,
      options: {
        emailRedirectTo: `${window.location.origin}/onboarding`,
        data: {
          first_name: firstName.trim(),
          last_name: lastName.trim(),
          partner_code: partner ?? null,
          referral_code: ref ?? null,
        },
      },
    });
    setSubmitting(false);
    if (err) {
      setError(err.message);
      return;
    }
    if (!data.session) {
      setError("Check your email to confirm your account, then sign in.");
      return;
    }
    await router.navigate({ to: "/onboarding", replace: true });
  };

  return (
    <AppShell showCallBar={false}>
      <div className="mx-auto max-w-md px-4 py-16">
        <div className="rounded-lg border border-border bg-card p-6">
          <div className="mb-4 flex items-center gap-2 text-primary">
            <UserPlus className="h-5 w-5" />
            <div className="text-xs font-bold uppercase tracking-widest">Plumber signup</div>
          </div>
          <h1 className="text-2xl font-black">Create your account</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Get your own branded job-capture website in about 5 minutes.
          </p>
          {partner && <PartnerOfferBanner partner={partner} />}
          <form onSubmit={onSubmit} className="mt-6 space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <Field label="First name" value={firstName} onChange={setFirstName} required />
              <Field label="Last name" value={lastName} onChange={setLastName} required />
            </div>
            <Field
              label="Email"
              type="email"
              value={email}
              onChange={setEmail}
              required
              autoComplete="email"
            />
            <Field
              label="Password"
              type="password"
              value={password}
              onChange={setPassword}
              required
              autoComplete="new-password"
            />
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
              {submitting ? "Creating account…" : "Create my account"}
            </button>
          </form>
          <p className="mt-4 text-xs text-muted-foreground">
            Already have an account?{" "}
            <Link to="/auth" search={{ next: undefined }} className="underline text-primary">
              Sign in
            </Link>
          </p>
        </div>
      </div>
    </AppShell>
  );
}

/**
 * Union member offer copy (Phase P). Wording is deliberate:
 *  - "First month's platform fee free" (NOT "first month free")
 *  - "Usage charges apply from day one" (AI voice + future SMS billed from day 1)
 *  - "Payment method required to activate"
 * Non-union partners get a small acknowledgement without misleading claims.
 */
function PartnerOfferBanner({ partner }: { partner: string }) {
  if (partner === "union-member") {
    return (
      <div className="mt-3 rounded-md border border-primary/40 bg-primary/10 p-3 text-xs space-y-2">
        <div className="font-black text-sm text-primary">Union Member Offer</div>
        <ul className="space-y-1 list-disc pl-5">
          <li>
            <b>$0 setup</b>
          </li>
          <li>
            <b>First month's platform fee free</b>
          </li>
          <li>Usage charges apply from day one</li>
        </ul>
        <div className="pt-1 border-t border-primary/20">
          <div className="font-bold uppercase tracking-widest text-[10px] text-muted-foreground mb-1">
            After first month
          </div>
          <div>
            Missed Call Recovery — <b>A$9/mo</b> + SMS usage
          </div>
          <div>
            AI Receptionist — <b>A$15/mo</b> + <b>A$0.59/min</b> AI usage
          </div>
        </div>
        <div className="pt-1 text-[11px] text-muted-foreground">
          A valid payment method is required to activate service.
        </div>
      </div>
    );
  }
  return (
    <div className="mt-3 rounded-md border border-primary/40 bg-primary/10 p-2 text-xs">
      Partner attribution: <span className="font-bold">{partner}</span>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  type = "text",
  required,
  autoComplete,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  required?: boolean;
  autoComplete?: string;
}) {
  return (
    <label className="block">
      <div className="mb-1 text-xs font-bold uppercase tracking-widest text-muted-foreground">
        {label}
      </div>
      <input
        type={type}
        value={value}
        required={required}
        autoComplete={autoComplete}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-md border border-border bg-input px-3 py-3 text-base"
      />
    </label>
  );
}
