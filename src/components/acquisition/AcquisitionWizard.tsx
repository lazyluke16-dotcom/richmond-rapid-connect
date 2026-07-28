import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  CreditCard,
  Loader2,
  LockKeyhole,
  MailCheck,
  MessageSquareText,
  Phone,
  ShieldCheck,
  Sparkles,
  X,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { createMyBusiness, getOnboardingStatus } from "@/lib/onboarding.functions";
import { updateMyBusiness } from "@/lib/business-settings.functions";
import { normalizeAustralianPhone } from "@/lib/call-handling";
import { redeemMyAcquisitionOffer } from "@/lib/acquisition.functions";
import {
  ACQUISITION_PLANS,
  ACQUISITION_STORAGE_KEY,
  AcquisitionSignupDraftSchema,
  moneyFromCents,
  normalizePromoCode,
  type AcquisitionEventName,
  type AcquisitionSignupDraft,
} from "@/lib/acquisition";

type PromoState =
  | { status: "checking" }
  | { status: "valid"; waivedSetupFeeCents: number; expiresAt: string | null }
  | { status: "invalid"; message: string };

export function AcquisitionWizard({
  open,
  initialDraft,
  sessionId,
  onClose,
  onDraftChange,
  onTrack,
}: {
  open: boolean;
  initialDraft: AcquisitionSignupDraft;
  sessionId: string;
  onClose: () => void;
  onDraftChange: (draft: AcquisitionSignupDraft) => void;
  onTrack: (
    event: AcquisitionEventName,
    details?: { plan?: AcquisitionSignupDraft["plan"]; wizardStep?: number },
  ) => void;
}) {
  const [draft, setDraft] = useState(initialDraft);
  const [password, setPassword] = useState("");
  const [agreed, setAgreed] = useState(false);
  const [promo, setPromo] = useState<PromoState>({ status: "checking" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmationEmail, setConfirmationEmail] = useState<string | null>(null);
  const resumeAttempted = useRef(false);

  useEffect(() => setDraft(initialDraft), [initialDraft]);

  useEffect(() => {
    if (!open) return;
    onTrack("wizard_step_viewed", { plan: draft.plan, wizardStep: draft.step });
  }, [draft.plan, draft.step, onTrack, open]);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void (async () => {
        setPromo({ status: "checking" });
        try {
          const response = await fetch("/api/public/acquisition", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            signal: controller.signal,
            body: JSON.stringify({
              action: "validate_promo",
              code: normalizePromoCode(draft.promoCode),
              plan: draft.plan,
            }),
          });
          const payload = (await response.json()) as {
            valid?: boolean;
            waivedSetupFeeCents?: number;
            expiresAt?: string | null;
            error?: string;
          };
          if (!response.ok || !payload.valid || payload.waivedSetupFeeCents == null) {
            setPromo({ status: "invalid", message: payload.error ?? "Code is not available" });
            return;
          }
          setPromo({
            status: "valid",
            waivedSetupFeeCents: payload.waivedSetupFeeCents,
            expiresAt: payload.expiresAt ?? null,
          });
          onTrack("promo_validated", { plan: draft.plan, wizardStep: draft.step });
        } catch (cause) {
          if ((cause as { name?: string }).name === "AbortError") return;
          setPromo({
            status: "invalid",
            message: "We couldn’t verify the code. Check your connection and try again.",
          });
        }
      })();
    }, 250);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [draft.plan, draft.promoCode, draft.step, onTrack, open]);

  useEffect(() => {
    if (!open || !sessionId || resumeAttempted.current) return;
    void (async () => {
      const { data } = await supabase.auth.getSession();
      if (data.session && new URLSearchParams(window.location.search).get("resume") === "signup") {
        resumeAttempted.current = true;
        setBusy(true);
        try {
          const user = data.session.user;
          const metadata = user.user_metadata ?? {};
          const hydrated = AcquisitionSignupDraftSchema.parse({
            ...draft,
            businessName: String(metadata.business_name ?? draft.businessName),
            firstName: String(metadata.first_name ?? draft.firstName),
            lastName: String(metadata.last_name ?? draft.lastName),
            email: user.email ?? draft.email,
            mobile: String(metadata.contact_mobile_e164 ?? draft.mobile),
            businessPhone: String(metadata.business_phone_e164 ?? draft.businessPhone),
            plan:
              metadata.acquisition_plan === "ai_receptionist" ||
              metadata.acquisition_plan === "missed_call_recovery"
                ? metadata.acquisition_plan
                : draft.plan,
            promoCode: normalizePromoCode(
              String(metadata.acquisition_promo_code ?? draft.promoCode),
            ),
            handlingTiming:
              metadata.call_handling_timing === "after_hours" ||
              metadata.call_handling_timing === "all_calls" ||
              metadata.call_handling_timing === "missed_calls"
                ? metadata.call_handling_timing
                : draft.handlingTiming,
            currentArrangement:
              metadata.current_answering_arrangement === "none" ||
              metadata.current_answering_arrangement === "mobile" ||
              metadata.current_answering_arrangement === "receptionist" ||
              metadata.current_answering_arrangement === "answering_service"
                ? metadata.current_answering_arrangement
                : draft.currentArrangement,
            attribution: {
              source: metadata.acquisition_source ?? draft.attribution.source,
              medium: metadata.acquisition_medium ?? draft.attribution.medium,
              campaign: metadata.acquisition_campaign ?? draft.attribution.campaign,
              content: metadata.acquisition_content ?? draft.attribution.content,
              referralCode: metadata.referral_code ?? draft.attribution.referralCode,
            },
          });
          setDraft(hydrated);
          onDraftChange(hydrated);
          await continueAuthenticatedSignup(hydrated, sessionId, onTrack);
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : "Could not continue signup");
          setBusy(false);
        }
      }
    })();
  }, [draft, onDraftChange, onTrack, open, sessionId]);

  const update = (patch: Partial<AcquisitionSignupDraft>) => {
    setDraft((current) => {
      const next = AcquisitionSignupDraftSchema.parse({ ...current, ...patch });
      onDraftChange(next);
      return next;
    });
  };

  const next = () => {
    setError(null);
    const validation = validateStep(draft, password, agreed, promo);
    if (validation) {
      setError(validation);
      return;
    }
    const nextStep = Math.min(4, draft.step + 1);
    update({ step: nextStep });
  };

  const back = () => {
    setError(null);
    update({ step: Math.max(0, draft.step - 1) });
  };

  const submit = async () => {
    const validation = validateStep(draft, password, agreed, promo);
    if (validation) {
      setError(validation);
      return;
    }
    setBusy(true);
    setError(null);
    onTrack("signup_submitted", { plan: draft.plan, wizardStep: draft.step });
    try {
      const businessPhone = normalizeAustralianPhone(draft.businessPhone);
      const mobile = normalizeAustralianPhone(draft.mobile);
      const metadataDraft = { ...draft, businessPhone, mobile };
      const { data, error: signupError } = await supabase.auth.signUp({
        email: draft.email.trim(),
        password,
        options: {
          emailRedirectTo: `${window.location.origin}/plumbers?resume=signup`,
          data: {
            first_name: draft.firstName.trim(),
            last_name: draft.lastName.trim(),
            business_name: draft.businessName.trim(),
            business_phone_e164: businessPhone,
            contact_mobile_e164: mobile,
            acquisition_plan: draft.plan,
            acquisition_promo_code: normalizePromoCode(draft.promoCode),
            acquisition_source: draft.attribution.source,
            acquisition_medium: draft.attribution.medium,
            acquisition_campaign: draft.attribution.campaign,
            acquisition_content: draft.attribution.content,
            referral_code: draft.attribution.referralCode,
            call_handling_timing: draft.handlingTiming,
            current_answering_arrangement: draft.currentArrangement,
          },
        },
      });
      if (signupError) throw signupError;
      onDraftChange(metadataDraft);
      if (!data.session) {
        onTrack("email_confirmation_required", { plan: draft.plan, wizardStep: 4 });
        setConfirmationEmail(draft.email.trim());
        setBusy(false);
        return;
      }
      await continueAuthenticatedSignup(metadataDraft, sessionId, onTrack);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not create your account");
      setBusy(false);
    }
  };

  const progress = ((draft.step + 1) / 5) * 100;

  if (!open) return null;

  if (confirmationEmail) {
    return (
      <WizardFrame onClose={onClose}>
        <div className="mx-auto flex min-h-[70vh] max-w-xl flex-col items-center justify-center px-5 text-center">
          <span className="grid h-20 w-20 place-items-center rounded-full bg-emerald-400/15 text-emerald-400">
            <MailCheck className="h-10 w-10" />
          </span>
          <h2 className="mt-6 text-3xl font-black">Check your email</h2>
          <p className="mt-3 text-muted-foreground">
            We sent a confirmation link to <b className="text-foreground">{confirmationEmail}</b>.
            Open it in any tab and we’ll continue with secure payment setup.
          </p>
          <div className="mt-6 rounded-xl border border-border bg-card p-4 text-sm">
            Your <b>{ACQUISITION_PLANS[draft.plan].name}</b> selection and{" "}
            <b>{normalizePromoCode(draft.promoCode)}</b> waiver are saved with your account.
          </div>
        </div>
      </WizardFrame>
    );
  }

  return (
    <WizardFrame onClose={onClose}>
      <div className="border-b border-border px-5 pb-4 pt-5 sm:px-8">
        <div className="mx-auto max-w-5xl">
          <div className="flex items-center justify-between gap-4">
            <div>
              <div className="text-xs font-black uppercase tracking-[0.2em] text-primary">
                Get Rapid Connect
              </div>
              <h2 className="mt-1 text-2xl font-black">{STEP_TITLES[draft.step]}</h2>
            </div>
            <div className="text-xs font-bold text-muted-foreground">
              Step {draft.step + 1} of 5
            </div>
          </div>
          <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-primary transition-all"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>
      </div>

      <div className="mx-auto grid w-full max-w-5xl gap-6 px-5 py-7 sm:px-8 lg:grid-cols-[1fr_320px]">
        <div>
          {draft.step === 0 && <PlanStep draft={draft} update={update} onTrack={onTrack} />}
          {draft.step === 1 && <BusinessStep draft={draft} update={update} />}
          {draft.step === 2 && <PhoneStep draft={draft} update={update} />}
          {draft.step === 3 && <OfferStep draft={draft} update={update} promo={promo} />}
          {draft.step === 4 && (
            <AccountStep
              draft={draft}
              password={password}
              setPassword={setPassword}
              agreed={agreed}
              setAgreed={setAgreed}
              promo={promo}
            />
          )}

          {error && (
            <div className="mt-5 rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
              {error}
            </div>
          )}

          <div className="mt-7 flex items-center justify-between gap-3">
            <button
              type="button"
              onClick={draft.step === 0 ? onClose : back}
              disabled={busy}
              className="inline-flex items-center gap-2 rounded-xl border border-border px-5 py-3 text-sm font-bold disabled:opacity-40"
            >
              <ArrowLeft className="h-4 w-4" /> {draft.step === 0 ? "Back to demo" : "Back"}
            </button>
            {draft.step < 4 ? (
              <button
                type="button"
                onClick={next}
                className="inline-flex items-center gap-2 rounded-xl bg-primary px-6 py-3 text-sm font-black text-primary-foreground"
              >
                Continue <ArrowRight className="h-4 w-4" />
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void submit()}
                disabled={busy || promo.status !== "valid"}
                className="inline-flex min-w-44 items-center justify-center gap-2 rounded-xl bg-primary px-6 py-3 text-sm font-black text-primary-foreground disabled:opacity-50"
              >
                {busy ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <LockKeyhole className="h-4 w-4" />
                )}
                {busy ? "Setting up…" : "Create account"}
              </button>
            )}
          </div>
        </div>

        <OrderSummary draft={draft} promo={promo} />
      </div>
    </WizardFrame>
  );
}

async function continueAuthenticatedSignup(
  draft: AcquisitionSignupDraft,
  sessionId: string,
  onTrack: (
    event: AcquisitionEventName,
    details?: { plan?: AcquisitionSignupDraft["plan"]; wizardStep?: number },
  ) => void,
) {
  const status = await getOnboardingStatus();
  if (!status.hasBusiness) {
    await createMyBusiness({
      data: {
        name: draft.businessName.trim(),
        slug_base: draft.businessName.trim(),
        signup_source: draft.attribution.source ?? "acquisition_funnel",
        partner_code: null,
        referral_code: draft.attribution.referralCode,
      },
    });
    await updateMyBusiness({
      data: {
        name: draft.businessName.trim(),
        public_phone: normalizeAustralianPhone(draft.businessPhone),
        public_email: draft.email.trim(),
      },
    });
  }
  await redeemMyAcquisitionOffer({
    data: {
      code: draft.promoCode,
      plan: draft.plan,
      session_id: sessionId,
      attribution: draft.attribution,
    },
  });
  onTrack("account_created", { plan: draft.plan, wizardStep: 4 });
  localStorage.removeItem(ACQUISITION_STORAGE_KEY);

  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("Your session expired. Sign in again to continue.");
  const response = await fetch("/api/public/billing/checkout", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  const payload = (await response.json().catch(() => ({}))) as { url?: string; error?: string };
  if (!response.ok || !payload.url) {
    onTrack("checkout_failed", { plan: draft.plan, wizardStep: 4 });
    throw new Error(
      payload.error ??
        "Your account was created, but secure payment setup could not open. Sign in and use Plan & Billing to continue.",
    );
  }
  onTrack("checkout_opened", { plan: draft.plan, wizardStep: 4 });
  window.location.assign(payload.url);
}

function WizardFrame({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-[90] overflow-y-auto bg-background text-foreground">
      <button
        type="button"
        onClick={onClose}
        className="fixed right-4 top-4 z-10 grid h-11 w-11 place-items-center rounded-full border border-border bg-card shadow-lg"
        aria-label="Close signup"
      >
        <X className="h-5 w-5" />
      </button>
      {children}
    </div>
  );
}

const STEP_TITLES = [
  "Choose your receptionist",
  "Tell us about your business",
  "How should calls be handled?",
  "Confirm your fee waiver",
  "Create your secure account",
] as const;

function PlanStep({
  draft,
  update,
  onTrack,
}: {
  draft: AcquisitionSignupDraft;
  update: (patch: Partial<AcquisitionSignupDraft>) => void;
  onTrack: (
    event: AcquisitionEventName,
    details?: { plan?: AcquisitionSignupDraft["plan"]; wizardStep?: number },
  ) => void;
}) {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {(Object.keys(ACQUISITION_PLANS) as AcquisitionSignupDraft["plan"][]).map((plan) => {
        const config = ACQUISITION_PLANS[plan];
        const selected = draft.plan === plan;
        return (
          <button
            type="button"
            key={plan}
            onClick={() => {
              update({ plan });
              onTrack("package_selected", { plan, wizardStep: 0 });
            }}
            className={`relative rounded-2xl border p-5 text-left transition ${
              selected
                ? "border-primary bg-primary/10 shadow-[var(--shadow-glow)]"
                : "border-border bg-card hover:border-primary/50"
            }`}
          >
            {plan === "ai_receptionist" && (
              <span className="absolute right-4 top-4 rounded-full bg-primary px-2.5 py-1 text-[10px] font-black text-primary-foreground">
                MOST COMPLETE
              </span>
            )}
            <span
              className={`grid h-11 w-11 place-items-center rounded-xl ${selected ? "bg-primary text-primary-foreground" : "bg-muted"}`}
            >
              {plan === "ai_receptionist" ? (
                <Sparkles className="h-5 w-5" />
              ) : (
                <MessageSquareText className="h-5 w-5" />
              )}
            </span>
            <h3 className="mt-4 text-xl font-black">{config.name}</h3>
            <div className="mt-2 text-2xl font-black">
              {moneyFromCents(config.platformFeeCents)}
              <span className="text-sm font-medium text-muted-foreground">/month</span>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">{config.usage}</p>
            <ul className="mt-5 space-y-2 text-sm">
              {config.includes.map((item) => (
                <li key={item} className="flex gap-2">
                  <Check className="mt-0.5 h-4 w-4 shrink-0 text-primary" /> {item}
                </li>
              ))}
            </ul>
          </button>
        );
      })}
    </div>
  );
}

function BusinessStep({
  draft,
  update,
}: {
  draft: AcquisitionSignupDraft;
  update: (patch: Partial<AcquisitionSignupDraft>) => void;
}) {
  return (
    <div className="space-y-4">
      <Field
        label="Business name"
        value={draft.businessName}
        onChange={(businessName) => update({ businessName })}
        autoComplete="organization"
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="First name"
          value={draft.firstName}
          onChange={(firstName) => update({ firstName })}
          autoComplete="given-name"
        />
        <Field
          label="Last name"
          value={draft.lastName}
          onChange={(lastName) => update({ lastName })}
          autoComplete="family-name"
        />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Email"
          type="email"
          value={draft.email}
          onChange={(email) => update({ email })}
          autoComplete="email"
        />
        <Field
          label="Mobile"
          type="tel"
          value={draft.mobile}
          onChange={(mobile) => update({ mobile })}
          autoComplete="mobile tel"
        />
      </div>
    </div>
  );
}

function PhoneStep({
  draft,
  update,
}: {
  draft: AcquisitionSignupDraft;
  update: (patch: Partial<AcquisitionSignupDraft>) => void;
}) {
  return (
    <div className="space-y-5">
      <Field
        label="Business phone number"
        type="tel"
        value={draft.businessPhone}
        onChange={(businessPhone) => update({ businessPhone })}
        autoComplete="tel"
        hint="The number customers currently call."
      />
      <ChoiceGroup
        label="When should Rapid Connect handle calls?"
        value={draft.handlingTiming}
        onChange={(handlingTiming) => update({ handlingTiming })}
        options={[
          ["missed_calls", "Only when I miss a call"],
          ["after_hours", "After hours and missed calls"],
          ["all_calls", "Every incoming call"],
        ]}
      />
      <ChoiceGroup
        label="How are calls answered today?"
        value={draft.currentArrangement}
        onChange={(currentArrangement) => update({ currentArrangement })}
        options={[
          ["mobile", "I answer on my mobile"],
          ["none", "No consistent setup"],
          ["receptionist", "A receptionist or office staff"],
          ["answering_service", "An external answering service"],
        ]}
      />
      <div className="rounded-xl border border-sky-400/20 bg-sky-400/10 p-4 text-sm">
        <div className="flex gap-3">
          <Phone className="mt-0.5 h-5 w-5 shrink-0 text-sky-300" />
          <p>
            We won’t change or port your number during signup. Guided call forwarding and testing
            happen after your account is created.
          </p>
        </div>
      </div>
    </div>
  );
}

function OfferStep({
  draft,
  update,
  promo,
}: {
  draft: AcquisitionSignupDraft;
  update: (patch: Partial<AcquisitionSignupDraft>) => void;
  promo: PromoState;
}) {
  const plan = ACQUISITION_PLANS[draft.plan];
  return (
    <div>
      <div className="rounded-2xl border border-primary/30 bg-primary/10 p-5 sm:p-6">
        <div className="flex items-center gap-3">
          <span className="grid h-12 w-12 place-items-center rounded-full bg-primary text-primary-foreground">
            <CheckCircle2 className="h-6 w-6" />
          </span>
          <div>
            <div className="text-xs font-black uppercase tracking-widest text-primary">
              Launch offer
            </div>
            <h3 className="text-xl font-black">Waive your complete setup fee</h3>
          </div>
        </div>
        <div className="mt-6 flex items-end justify-between gap-4 rounded-xl bg-background/60 p-4">
          <div>
            <div className="text-xs uppercase tracking-widest text-muted-foreground">
              {plan.name} setup
            </div>
            <div className="mt-1 text-2xl font-black line-through opacity-50">
              {moneyFromCents(plan.setupFeeCents)}
            </div>
          </div>
          <div className="text-right">
            <div className="text-xs uppercase tracking-widest text-muted-foreground">With code</div>
            <div className="mt-1 text-4xl font-black text-primary">$0</div>
          </div>
        </div>
        <label className="mt-5 block">
          <span className="text-xs font-black uppercase tracking-widest text-muted-foreground">
            Offer code
          </span>
          <div className="mt-2 flex gap-2">
            <input
              value={draft.promoCode}
              onChange={(event) => update({ promoCode: normalizePromoCode(event.target.value) })}
              className="min-w-0 flex-1 rounded-xl border border-border bg-input px-4 py-3 font-mono text-lg font-black tracking-wider uppercase"
            />
            <span
              className={`grid w-12 place-items-center rounded-xl border ${
                promo.status === "valid"
                  ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-400"
                  : "border-border"
              }`}
            >
              {promo.status === "checking" ? (
                <Loader2 className="h-5 w-5 animate-spin" />
              ) : promo.status === "valid" ? (
                <Check className="h-5 w-5" />
              ) : (
                <X className="h-5 w-5 text-destructive" />
              )}
            </span>
          </div>
        </label>
        <p
          className={`mt-2 text-xs ${promo.status === "invalid" ? "text-destructive" : "text-muted-foreground"}`}
        >
          {promo.status === "checking"
            ? "Checking code…"
            : promo.status === "valid"
              ? `${moneyFromCents(promo.waivedSetupFeeCents)} setup fee waived.`
              : promo.message}
        </p>
      </div>
      <p className="mt-4 text-xs leading-relaxed text-muted-foreground">
        The setup waiver does not discount recurring platform or usage charges. Your selected
        package remains {moneyFromCents(plan.platformFeeCents)}/month plus the usage shown.
      </p>
    </div>
  );
}

function AccountStep({
  draft,
  password,
  setPassword,
  agreed,
  setAgreed,
  promo,
}: {
  draft: AcquisitionSignupDraft;
  password: string;
  setPassword: (value: string) => void;
  agreed: boolean;
  setAgreed: (value: boolean) => void;
  promo: PromoState;
}) {
  const plan = ACQUISITION_PLANS[draft.plan];
  return (
    <div className="space-y-5">
      <div className="rounded-xl border border-border bg-card p-4">
        <div className="flex items-center gap-3">
          <ShieldCheck className="h-6 w-6 text-primary" />
          <div>
            <div className="font-black">{draft.email}</div>
            <div className="text-xs text-muted-foreground">
              {draft.businessName} · {plan.name}
            </div>
          </div>
        </div>
      </div>
      <Field
        label="Create a password"
        type="password"
        value={password}
        onChange={setPassword}
        autoComplete="new-password"
        hint="Use at least 10 characters."
      />
      <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-border p-4 text-sm">
        <input
          type="checkbox"
          checked={agreed}
          onChange={(event) => setAgreed(event.target.checked)}
          className="mt-0.5 h-5 w-5 accent-yellow-400"
        />
        <span>
          I agree to the displayed recurring price and usage charges, and I authorise Rapid Connect
          to open Stripe’s secure payment setup. The setup fee shown above will be $0 while the
          verified offer remains valid.
        </span>
      </label>
      <div className="flex gap-3 rounded-xl bg-muted/60 p-4 text-xs text-muted-foreground">
        <CreditCard className="h-5 w-5 shrink-0 text-foreground" />
        <p>
          Your card details are entered directly into Stripe after account creation. Rapid Connect
          does not store your card number.
        </p>
      </div>
      {promo.status !== "valid" && (
        <p className="text-sm text-destructive">
          A verified offer code is required to continue with the $0 setup offer.
        </p>
      )}
    </div>
  );
}

function OrderSummary({ draft, promo }: { draft: AcquisitionSignupDraft; promo: PromoState }) {
  const plan = ACQUISITION_PLANS[draft.plan];
  return (
    <aside className="h-fit rounded-2xl border border-border bg-card p-5 lg:sticky lg:top-6">
      <div className="text-xs font-black uppercase tracking-widest text-muted-foreground">
        Your order
      </div>
      <h3 className="mt-2 text-lg font-black">{plan.name}</h3>
      <div className="mt-5 space-y-3 border-y border-border py-4 text-sm">
        <SummaryRow label="Platform" value={`${moneyFromCents(plan.platformFeeCents)}/month`} />
        <SummaryRow label="Usage" value={plan.usage} />
        <SummaryRow label="Setup fee" value={moneyFromCents(plan.setupFeeCents)} strike />
        <SummaryRow
          label="Offer"
          value={
            promo.status === "valid" ? `−${moneyFromCents(promo.waivedSetupFeeCents)}` : "Pending"
          }
          accent={promo.status === "valid"}
        />
      </div>
      <div className="mt-4 flex items-end justify-between">
        <span className="text-sm font-bold">Due for setup</span>
        <span className="text-3xl font-black text-primary">
          {promo.status === "valid" ? "$0" : "—"}
        </span>
      </div>
      <p className="mt-4 text-[11px] leading-relaxed text-muted-foreground">
        Prices are AUD. Usage is metered separately. GST is applied at the invoice boundary where
        required.
      </p>
    </aside>
  );
}

function SummaryRow({
  label,
  value,
  strike,
  accent,
}: {
  label: string;
  value: string;
  strike?: boolean;
  accent?: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <span className="text-muted-foreground">{label}</span>
      <span
        className={`max-w-[180px] text-right font-bold ${strike ? "line-through opacity-50" : ""} ${accent ? "text-emerald-400" : ""}`}
      >
        {value}
      </span>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  type = "text",
  autoComplete,
  hint,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  autoComplete?: string;
  hint?: string;
}) {
  return (
    <label className="block">
      <span className="text-xs font-black uppercase tracking-widest text-muted-foreground">
        {label}
      </span>
      <input
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        autoComplete={autoComplete}
        className="mt-2 w-full rounded-xl border border-border bg-input px-4 py-3 text-base outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20"
      />
      {hint && <span className="mt-1.5 block text-xs text-muted-foreground">{hint}</span>}
    </label>
  );
}

function ChoiceGroup<T extends string>({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: T;
  onChange: (value: T) => void;
  options: readonly (readonly [T, string])[];
}) {
  return (
    <fieldset>
      <legend className="text-xs font-black uppercase tracking-widest text-muted-foreground">
        {label}
      </legend>
      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        {options.map(([option, copy]) => (
          <label
            key={option}
            className={`flex cursor-pointer items-center gap-3 rounded-xl border p-3 text-sm ${
              value === option ? "border-primary bg-primary/10" : "border-border bg-card"
            }`}
          >
            <input
              type="radio"
              checked={value === option}
              onChange={() => onChange(option)}
              className="h-4 w-4 accent-yellow-400"
            />
            <span className="font-bold">{copy}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function validateStep(
  draft: AcquisitionSignupDraft,
  password: string,
  agreed: boolean,
  promo: PromoState,
): string | null {
  if (draft.step === 1) {
    if (draft.businessName.trim().length < 2) return "Enter your business name.";
    if (draft.firstName.trim().length < 2 || draft.lastName.trim().length < 2)
      return "Enter your first and last name.";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(draft.email.trim()))
      return "Enter a valid email address.";
    try {
      normalizeAustralianPhone(draft.mobile);
    } catch {
      return "Enter a valid Australian mobile number.";
    }
  }
  if (draft.step === 2) {
    try {
      normalizeAustralianPhone(draft.businessPhone);
    } catch {
      return "Enter a valid Australian business phone number.";
    }
  }
  if (draft.step === 3 && promo.status !== "valid")
    return "Enter a valid offer code to waive the setup fee.";
  if (draft.step === 4) {
    if (password.length < 10) return "Create a password with at least 10 characters.";
    if (!agreed) return "Confirm the displayed prices and secure payment setup to continue.";
    if (promo.status !== "valid") return "The setup-fee waiver must be verified before signup.";
  }
  return null;
}
