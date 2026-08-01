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
  Upload,
  UserRound,
  X,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import {
  completeOnboarding,
  createMyBusiness,
  getOnboardingStatus,
  setMyAreas,
  setMyHours,
  setMyServices,
} from "@/lib/onboarding.functions";
import { setMyLicence, updateMyBusiness } from "@/lib/business-settings.functions";
import { normalizeAustralianPhone } from "@/lib/call-handling";
import { redeemMyAcquisitionOffer } from "@/lib/acquisition.functions";
import {
  ACQUISITION_PLANS,
  ACQUISITION_STORAGE_KEY,
  ACQUISITION_SAFE_STORAGE_KEY,
  AcquisitionSignupDraftSchema,
  moneyFromCents,
  normalBillingDate,
  normalizePromoCode,
  recoverAcquisitionDraftFromUser,
  acquisitionUserMetadata,
  acquisitionAreaRows,
  acquisitionHourRows,
  acquisitionServiceRows,
  firstIncompleteAcquisitionStep,
  type AcquisitionEventName,
  type AcquisitionSignupDraft,
} from "@/lib/acquisition";
import { usageRateLines, usageWorkedExample } from "@/lib/commercial-pricing";

type IdentityState =
  | { kind: "loading" }
  | { kind: "anonymous" }
  | {
      kind: "signed-in";
      email: string;
      onboarding: Awaited<ReturnType<typeof getOnboardingStatus>>;
      billingStatus: string | null;
      hasStripeSubscription: boolean;
      selectedPlan: AcquisitionSignupDraft["plan"] | null;
    };

type PromoState =
  | { status: "checking" }
  | {
      status: "valid";
      waivedSetupFeeCents: number;
      subscriptionMonthsFree: number;
      offerVersion: string;
      expiresAt: string | null;
    }
  | { status: "invalid"; message: string };

export function AcquisitionWizard({
  open,
  initialDraft,
  sessionId,
  onClose,
  onDraftChange,
  onTrack,
  checkoutCancelled = false,
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
  checkoutCancelled?: boolean;
}) {
  const [draft, setDraft] = useState(initialDraft);
  const [password, setPassword] = useState("");
  const [agreed, setAgreed] = useState(false);
  const [promo, setPromo] = useState<PromoState>({ status: "checking" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmationEmail, setConfirmationEmail] = useState<string | null>(null);
  const [identity, setIdentity] = useState<IdentityState>({ kind: "loading" });
  const [identityAccepted, setIdentityAccepted] = useState(false);
  const [logoFile, setLogoFile] = useState<File | null>(null);
  const [logoPreview, setLogoPreview] = useState<string | null>(null);
  const [logoValidationError, setLogoValidationError] = useState<string | null>(null);
  const stepHeadingRef = useRef<HTMLHeadingElement>(null);
  const wizardStarted = useRef(false);

  useEffect(() => setDraft(initialDraft), [initialDraft]);

  useEffect(() => {
    if (open && checkoutCancelled) {
      setError(
        "Stripe checkout was cancelled. Your setup is saved; review the price and try again when ready.",
      );
    }
  }, [checkoutCancelled, open]);

  useEffect(() => {
    if (!open) return;
    if (!wizardStarted.current) {
      wizardStarted.current = true;
      onTrack("wizard_started", { plan: draft.plan, wizardStep: draft.step });
    }
    onTrack("wizard_step_viewed", { plan: draft.plan, wizardStep: draft.step });
  }, [draft.plan, draft.step, onTrack, open]);

  useEffect(() => {
    if (!open || confirmationEmail) return;
    const frame = window.requestAnimationFrame(() => stepHeadingRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [confirmationEmail, draft.step, open]);

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
            subscriptionMonthsFree?: number;
            offerVersion?: string;
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
            subscriptionMonthsFree: payload.subscriptionMonthsFree ?? 0,
            offerVersion: payload.offerVersion ?? "setup-waiver-v1",
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
    if (!open) return;
    let cancelled = false;
    void (async () => {
      setIdentity({ kind: "loading" });
      setIdentityAccepted(false);
      const { data } = await supabase.auth.getSession();
      if (cancelled) return;
      const session = data.session;
      if (!session?.user) {
        setIdentity({ kind: "anonymous" });
        setIdentityAccepted(true);
        return;
      }
      try {
        const onboarding = await getOnboardingStatus();
        let billingStatus: string | null = null;
        let hasStripeSubscription = false;
        let selectedPlan: AcquisitionSignupDraft["plan"] | null = null;
        if (onboarding.hasBusiness) {
          const response = await fetch("/api/public/billing/summary", {
            headers: { Authorization: `Bearer ${session.access_token}` },
          });
          if (response.ok) {
            const payload = (await response.json()) as {
              billing?: {
                billingStatus?: string;
                hasStripeSubscription?: boolean;
                selectedPlan?: AcquisitionSignupDraft["plan"] | null;
              };
            };
            billingStatus = payload.billing?.billingStatus ?? null;
            hasStripeSubscription = Boolean(payload.billing?.hasStripeSubscription);
            selectedPlan = payload.billing?.selectedPlan ?? null;
          }
        }
        if (!cancelled) {
          setIdentity({
            kind: "signed-in",
            email: session.user.email ?? "your signed-in account",
            onboarding,
            billingStatus,
            hasStripeSubscription,
            selectedPlan,
          });
        }
      } catch (cause) {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : "Could not check your account");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  useEffect(
    () => () => {
      if (logoPreview) URL.revokeObjectURL(logoPreview);
    },
    [logoPreview],
  );

  const update = (patch: Partial<AcquisitionSignupDraft>) => {
    setDraft((current) => {
      const next = AcquisitionSignupDraftSchema.parse({ ...current, ...patch });
      onDraftChange(next);
      return next;
    });
  };

  const next = () => {
    setError(null);
    const validation = validateStep(draft, password, agreed, promo, identity.kind === "signed-in");
    if (validation) {
      setError(validation);
      return;
    }
    const nextStep = Math.min(4, draft.step + 1);
    onTrack("wizard_stage_completed", { plan: draft.plan, wizardStep: draft.step });
    update({ step: nextStep });
  };

  const back = () => {
    setError(null);
    update({ step: Math.max(0, draft.step - 1) });
  };

  const submit = async () => {
    const validation = validateStep(draft, password, agreed, promo, identity.kind === "signed-in");
    if (validation) {
      setError(validation);
      return;
    }
    setBusy(true);
    setError(null);
    onTrack("signup_submitted", { plan: draft.plan, wizardStep: draft.step });
    try {
      const { data: existingAuth } = await supabase.auth.getSession();
      if (existingAuth.session?.user) {
        if (!identityAccepted || identity.kind !== "signed-in") {
          throw new Error("Confirm which signed-in account you want to continue with.");
        }
        if (identity.hasStripeSubscription) {
          window.location.assign("/dashboard");
          return;
        }
        const ownedDraft = {
          ...draft,
          email: existingAuth.session.user.email ?? identity.email,
        };
        await continueAuthenticatedSignup(ownedDraft, sessionId, onTrack, logoFile);
        return;
      }

      const businessPhone = normalizeAustralianPhone(draft.businessPhone);
      const mobile = normalizeAustralianPhone(draft.mobile);
      const metadataDraft = { ...draft, businessPhone, mobile };
      const { data, error: signupError } = await supabase.auth.signUp({
        email: draft.email.trim(),
        password,
        options: {
          emailRedirectTo: `${window.location.origin}/plumbers?resume=signup`,
          data: acquisitionUserMetadata(metadataDraft),
        },
      });
      if (signupError) throw signupError;
      if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
        throw new Error(
          "That sign-up could not be completed. Sign in or use password recovery if you may already have an account.",
        );
      }
      onDraftChange(metadataDraft);
      if (!data.session) {
        onTrack("email_confirmation_required", { plan: draft.plan, wizardStep: 4 });
        setConfirmationEmail(draft.email.trim());
        setBusy(false);
        return;
      }
      await continueAuthenticatedSignup(metadataDraft, sessionId, onTrack, logoFile);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not create your account");
      setBusy(false);
    }
  };

  const progress = ((draft.step + 1) / 5) * 100;

  if (!open) return null;

  if (identity.kind === "loading") {
    return (
      <WizardFrame onClose={onClose}>
        <div className="grid min-h-[70vh] place-items-center">
          <div className="text-center">
            <Loader2 className="mx-auto h-8 w-8 animate-spin text-primary" />
            <p className="mt-3 font-bold">Checking your account securely…</p>
          </div>
        </div>
      </WizardFrame>
    );
  }

  if (identity.kind === "signed-in" && !identityAccepted) {
    const complete = identity.hasStripeSubscription || identity.billingStatus === "active";
    return (
      <WizardFrame onClose={onClose}>
        <div className="mx-auto flex min-h-[70vh] max-w-2xl flex-col justify-center px-5 py-16">
          <div className="rounded-3xl border border-border bg-card p-6 sm:p-8">
            <span className="grid h-14 w-14 place-items-center rounded-2xl bg-primary/15 text-primary">
              <UserRound className="h-7 w-7" />
            </span>
            <div className="mt-5 text-xs font-black uppercase tracking-widest text-primary">
              Signed-in account
            </div>
            <h2 className="mt-2 break-all text-3xl font-black">{identity.email}</h2>
            <p className="mt-3 text-muted-foreground">
              {complete
                ? "This account already has a subscription. Continue to its dashboard—another checkout is blocked."
                : identity.onboarding.hasBusiness
                  ? `Resume setup for ${identity.onboarding.name ?? "this business"}. We will only restore data owned by this account.`
                  : "Continue this account’s saved setup, or sign out to create a genuinely different account."}
            </p>
            <div className="mt-6 grid gap-3 sm:grid-cols-2">
              <button
                type="button"
                onClick={() => {
                  if (complete) {
                    window.location.assign("/dashboard");
                    return;
                  }
                  void supabase.auth.getSession().then(({ data }) => {
                    const recovered = recoverAcquisitionDraftFromUser(
                      data.session?.user,
                      draft,
                    ) ?? {
                      ...draft,
                      email: identity.email,
                      contactEmail: draft.contactEmail || identity.email,
                    };
                    const preciseStep = identity.onboarding.hasBusiness
                      ? 4
                      : firstIncompleteAcquisitionStep(recovered);
                    const nextDraft = {
                      ...recovered,
                      plan: identity.selectedPlan ?? recovered.plan,
                      step: preciseStep,
                    };
                    setDraft(nextDraft);
                    onDraftChange(nextDraft);
                    setIdentityAccepted(true);
                  });
                }}
                className="rounded-xl bg-primary px-5 py-3 font-black text-primary-foreground focus-visible:ring-4 focus-visible:ring-primary/30"
              >
                {complete ? "Go to dashboard" : `Continue as ${identity.email}`}
              </button>
              <button
                type="button"
                onClick={() =>
                  void (async () => {
                    await supabase.auth.signOut();
                    sessionStorage.removeItem(ACQUISITION_SAFE_STORAGE_KEY);
                    localStorage.removeItem(ACQUISITION_STORAGE_KEY);
                    const fresh = {
                      ...initialDraft,
                      step: 0 as const,
                      businessName: "",
                      firstName: "",
                      lastName: "",
                      email: "",
                      contactEmail: "",
                      mobile: "",
                      businessPhone: "",
                    };
                    setDraft(fresh);
                    onDraftChange(fresh);
                    setIdentity({ kind: "anonymous" });
                    setIdentityAccepted(true);
                  })()
                }
                className="rounded-xl border border-border px-5 py-3 font-black focus-visible:ring-4 focus-visible:ring-primary/20"
              >
                Use a different account
              </button>
            </div>
            {!identity.onboarding.hasBusiness && !complete && (
              <button
                type="button"
                onClick={() => {
                  const fresh = {
                    ...initialDraft,
                    email: identity.email,
                    contactEmail: identity.email,
                    step: 0 as const,
                  };
                  setDraft(fresh);
                  onDraftChange(fresh);
                  setIdentityAccepted(true);
                }}
                className="mt-4 text-sm font-bold text-primary underline"
              >
                Start fresh with this signed-in account
              </button>
            )}
          </div>
        </div>
      </WizardFrame>
    );
  }

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
              <h2
                ref={stepHeadingRef}
                tabIndex={-1}
                className="mt-1 text-2xl font-black outline-none"
              >
                {STEP_TITLES[draft.step]}
              </h2>
            </div>
            <div className="text-xs font-bold text-muted-foreground">
              Step {draft.step + 1} of 5
            </div>
          </div>
          <div
            role="progressbar"
            aria-label="Signup progress"
            aria-valuemin={1}
            aria-valuemax={5}
            aria-valuenow={draft.step + 1}
            className="mt-4 h-1.5 overflow-hidden rounded-full bg-muted"
          >
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
          {draft.step === 1 && (
            <BusinessStep
              draft={draft}
              update={update}
              signedInEmail={identity.kind === "signed-in" ? identity.email : null}
            />
          )}
          {draft.step === 2 && (
            <PhoneStep
              draft={draft}
              update={update}
              logoFile={logoFile}
              logoPreview={logoPreview}
              logoValidationError={logoValidationError}
              onLogoChange={(file) => {
                if (logoPreview) URL.revokeObjectURL(logoPreview);
                setLogoFile(file);
                setLogoPreview(file ? URL.createObjectURL(file) : null);
                setLogoValidationError(null);
              }}
              onLogoValidationError={setLogoValidationError}
            />
          )}
          {draft.step === 3 && <OfferStep draft={draft} update={update} promo={promo} />}
          {draft.step === 4 && (
            <AccountStep
              draft={draft}
              password={password}
              setPassword={setPassword}
              agreed={agreed}
              setAgreed={setAgreed}
              promo={promo}
              signedInEmail={identity.kind === "signed-in" ? identity.email : null}
            />
          )}

          {error && (
            <div
              role="alert"
              className="mt-5 rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
            >
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
              <ArrowLeft className="h-4 w-4" /> {draft.step === 0 ? "Back to services" : "Back"}
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
                {busy
                  ? "Opening Stripe…"
                  : identity.kind === "signed-in"
                    ? "Continue securely with Stripe"
                    : "Create account & continue to Stripe"}
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
  logoFile: File | null = null,
) {
  const status = await getOnboardingStatus();
  const shouldSeedSetup = !status.onboarding_completed;
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
  }
  if (shouldSeedSetup) {
    await updateMyBusiness({
      data: {
        name: draft.businessName.trim(),
        public_phone: normalizeAustralianPhone(draft.businessPhone),
        public_email: draft.contactEmail.trim() || draft.email.trim(),
        short_description: draft.servicesOffered.trim(),
        hero_heading: `${draft.businessName.trim()} plumbing help`,
        hero_subheading: `Local help across ${draft.serviceArea.trim()}.`,
        emergency_message:
          draft.afterHoursPreference === "next_business_day"
            ? "Leave your job details and we will respond next business day."
            : "Tell us what is urgent and we will alert the plumber.",
      },
    });
    await Promise.all([
      setMyServices({ data: { services: acquisitionServiceRows(draft.servicesOffered) } }),
      setMyAreas({ data: { areas: acquisitionAreaRows(draft.serviceArea) } }),
      setMyHours({ data: { hours: acquisitionHourRows(draft.businessHours) } }),
    ]);
    if (draft.licenceNumber.trim() || draft.licenceState) {
      await setMyLicence({
        data: {
          licence_number: draft.licenceNumber.trim() || null,
          licence_state: draft.licenceState || null,
          licence_public: false,
        },
      });
    }
  }
  await redeemMyAcquisitionOffer({
    data: {
      code: draft.promoCode,
      plan: draft.plan,
      session_id: sessionId,
      attribution: draft.attribution,
      demoVariant: draft.demoVariant,
    },
  });
  if (shouldSeedSetup) await completeOnboarding();
  onTrack("account_created", { plan: draft.plan, wizardStep: 4 });
  localStorage.removeItem(ACQUISITION_STORAGE_KEY);
  sessionStorage.removeItem(ACQUISITION_SAFE_STORAGE_KEY);

  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("Your session expired. Sign in again to continue.");
  if (logoFile) {
    const form = new FormData();
    form.set("logo", logoFile);
    const logoResponse = await fetch("/api/public/business-logo", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });
    if (!logoResponse.ok) {
      // A logo is optional. Unsafe or failed uploads are discarded by the server,
      // while the plumber can still finish payment and add a logo later in Settings.
      console.warn("[acquisition] optional business logo upload was skipped");
    }
  }
  const response = await fetch("/api/public/billing/checkout", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  onTrack("checkout_started", { plan: draft.plan, wizardStep: 4 });
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
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeButtonRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(
          "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex='-1'])",
        ),
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      previousFocus?.focus();
    };
  }, []);

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label="Rapid Connect signup"
      className="acquisition-experience fixed inset-0 z-[90] overflow-y-auto bg-background text-foreground"
    >
      <button
        ref={closeButtonRef}
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
  "Choose the service that fits",
  "Tell us about your business",
  "How should calls be handled?",
  "Confirm your founding offer",
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
            {plan === "both" && (
              <span className="absolute right-4 top-4 rounded-full bg-primary px-2.5 py-1 text-[10px] font-black text-primary-foreground">
                BOTH SERVICES
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
              <span className="text-sm font-medium text-muted-foreground">
                /month including GST
              </span>
            </div>
            <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
              {config.explanation}
            </p>
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
  signedInEmail,
}: {
  draft: AcquisitionSignupDraft;
  update: (patch: Partial<AcquisitionSignupDraft>) => void;
  signedInEmail: string | null;
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
        {signedInEmail ? (
          <div className="rounded-xl border border-primary/30 bg-primary/10 p-4">
            <div className="text-xs font-black uppercase tracking-widest text-muted-foreground">
              Signed-in login (cannot be changed here)
            </div>
            <div className="mt-2 break-all font-black">{signedInEmail}</div>
          </div>
        ) : (
          <Field
            label="Email for login and business contact"
            type="email"
            value={draft.email}
            onChange={(email) => update({ email, contactEmail: email })}
            autoComplete="email"
          />
        )}
        <Field
          label="Mobile"
          type="tel"
          value={draft.mobile}
          onChange={(mobile) => update({ mobile })}
          autoComplete="mobile tel"
        />
      </div>
      {signedInEmail && (
        <Field
          label="Business contact email (optional)"
          type="email"
          value={draft.contactEmail}
          onChange={(contactEmail) => update({ contactEmail })}
          autoComplete="email"
          hint="This can receive business contact. It does not change the signed-in login or Stripe ownership."
        />
      )}
    </div>
  );
}

function PhoneStep({
  draft,
  update,
  logoFile,
  logoPreview,
  logoValidationError,
  onLogoChange,
  onLogoValidationError,
}: {
  draft: AcquisitionSignupDraft;
  update: (patch: Partial<AcquisitionSignupDraft>) => void;
  logoFile: File | null;
  logoPreview: string | null;
  logoValidationError: string | null;
  onLogoChange: (file: File | null) => void;
  onLogoValidationError: (message: string | null) => void;
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
      <div className="grid gap-4 rounded-2xl border border-border bg-card p-4 sm:grid-cols-2">
        <div>
          <label
            className="block text-xs font-black uppercase tracking-widest text-muted-foreground"
            htmlFor="business-logo"
          >
            Business logo (optional)
          </label>
          <label
            htmlFor="business-logo"
            className="mt-2 flex min-h-12 cursor-pointer items-center justify-center gap-2 rounded-xl border border-dashed border-border px-4 font-bold hover:border-primary focus-within:ring-2 focus-within:ring-primary/30"
          >
            <Upload className="h-4 w-4" /> {logoFile ? "Replace logo" : "Choose logo"}
            <input
              id="business-logo"
              className="sr-only"
              type="file"
              accept="image/png,image/jpeg,image/webp"
              onChange={(event) => {
                const file = event.currentTarget.files?.[0] ?? null;
                if (file && file.size > 2 * 1024 * 1024) {
                  event.currentTarget.value = "";
                  onLogoChange(null);
                  onLogoValidationError(
                    "That logo is larger than 2 MB. Choose a smaller file or skip it.",
                  );
                  return;
                }
                onLogoChange(file);
              }}
            />
          </label>
          <p className="mt-2 text-xs text-muted-foreground">
            PNG, JPEG or WebP, up to 2 MB. Stored privately and not made public automatically.
          </p>
          {logoValidationError && (
            <p className="mt-2 text-xs font-bold text-destructive" role="alert">
              {logoValidationError}
            </p>
          )}
          {logoFile && (
            <button
              type="button"
              onClick={() => onLogoChange(null)}
              className="mt-2 text-xs font-bold text-primary underline"
            >
              Remove selected logo
            </button>
          )}
        </div>
        <div className="grid min-h-28 place-items-center rounded-xl bg-muted/50">
          {logoPreview ? (
            <img
              src={logoPreview}
              alt="Selected business logo preview"
              className="max-h-24 max-w-full rounded-lg object-contain"
            />
          ) : (
            <span className="text-sm text-muted-foreground">Logo preview</span>
          )}
        </div>
        <Field
          label="Plumber licence / registration number (optional)"
          value={draft.licenceNumber}
          onChange={(licenceNumber) => update({ licenceNumber })}
          hint="Self-reported only. Requirements and formats differ by state; Rapid Connect does not verify it."
        />
        <label className="block">
          <span className="text-xs font-black uppercase tracking-widest text-muted-foreground">
            Issuing state / territory (optional)
          </span>
          <select
            value={draft.licenceState}
            onChange={(event) =>
              update({
                licenceState: event.currentTarget.value as AcquisitionSignupDraft["licenceState"],
              })
            }
            className="mt-2 w-full rounded-xl border border-border bg-input px-4 py-3"
          >
            <option value="">Select later</option>
            {(["ACT", "NSW", "NT", "QLD", "SA", "TAS", "VIC", "WA"] as const).map((state) => (
              <option key={state} value={state}>
                {state}
              </option>
            ))}
          </select>
        </label>
      </div>
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
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Services you offer"
          value={draft.servicesOffered}
          onChange={(servicesOffered) => update({ servicesOffered })}
          hint="A short list is enough. You can refine this later."
        />
        <Field
          label="Service area"
          value={draft.serviceArea}
          onChange={(serviceArea) => update({ serviceArea })}
          hint="For example: Richmond and suburbs within 15 km."
        />
      </div>
      <ChoiceGroup
        label="Business hours"
        value={draft.businessHours}
        onChange={(businessHours) => update({ businessHours })}
        options={[
          ["Monday to Friday, 8am–5pm", "Weekdays, 8am–5pm"],
          ["Monday to Saturday, 8am–5pm", "Monday–Saturday, 8am–5pm"],
          ["Every day, 8am–5pm", "Every day, 8am–5pm"],
          ["24/7", "24 hours, every day"],
        ]}
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <ChoiceGroup
          label="After-hours jobs"
          value={draft.afterHoursPreference}
          onChange={(afterHoursPreference) => update({ afterHoursPreference })}
          options={[
            ["collect_and_notify", "Collect details and alert me"],
            ["urgent_only", "Alert me only when urgent"],
            ["next_business_day", "Hold for the next business day"],
          ]}
        />
        <ChoiceGroup
          label="Job alerts"
          value={draft.notificationPreference}
          onChange={(notificationPreference) => update({ notificationPreference })}
          options={[
            ["sms", "Text message"],
            ["email", "Email"],
            ["both", "Text and email"],
          ]}
        />
      </div>
      {draft.plan !== "missed_call_recovery" && (
        <Field
          label="What should the AI collect?"
          value={draft.customerQuestions}
          onChange={(customerQuestions) => update({ customerQuestions })}
          hint="The sensible default covers job, suburb, urgency and callback time."
        />
      )}
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
            <h3 className="text-xl font-black">No sign-on fee. Three subscription months free.</h3>
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
            <div className="mt-1 text-4xl font-black text-primary">A$0</div>
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
              ? `${moneyFromCents(promo.waivedSetupFeeCents)} sign-on fee waived and ${promo.subscriptionMonthsFree} subscription months free.`
              : promo.message}
        </p>
      </div>
      <p className="mt-4 text-xs leading-relaxed text-muted-foreground">
        Usage charges apply from activation. Your platform subscription is A$0 for the first three
        monthly billing periods, then {moneyFromCents(plan.platformFeeCents)}/month. Cancel anytime.
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
  signedInEmail,
}: {
  draft: AcquisitionSignupDraft;
  password: string;
  setPassword: (value: string) => void;
  agreed: boolean;
  setAgreed: (value: boolean) => void;
  promo: PromoState;
  signedInEmail: string | null;
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
      {signedInEmail ? (
        <div className="rounded-xl border border-primary/30 bg-primary/10 p-4 text-sm">
          Continuing securely as <b>{signedInEmail}</b>. The subscription will belong to this
          account’s server-verified business.
        </div>
      ) : (
        <Field
          label="Create a password"
          type="password"
          value={password}
          onChange={setPassword}
          autoComplete="new-password"
          hint="Use at least 10 characters."
        />
      )}
      <div className="rounded-xl border border-border bg-card p-4 text-sm">
        <div className="font-black">What you will pay</div>
        <ul className="mt-3 space-y-2">
          <li>A$0 setup/sign-on fee.</li>
          <li>A$0 platform fees for the first three monthly billing periods.</li>
          <li>
            Normal platform billing begins {normalBillingDate()}:{" "}
            {moneyFromCents(plan.platformFeeCents)}/month including GST.
          </li>
          <li>Usage billing starts when the service is activated.</li>
        </ul>
        <details className="mt-4 rounded-lg bg-muted/60 p-3">
          <summary className="cursor-pointer font-black">See all usage rates</summary>
          <ul className="mt-3 list-disc space-y-2 pl-5">
            {usageRateLines(draft.plan).map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <p className="mt-3">
            No separate AI-model, inbound-call or phone-number customer charge is implemented.{" "}
            {usageWorkedExample(draft.plan)}
          </p>
        </details>
      </div>
      <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-border p-4 text-sm">
        <input
          type="checkbox"
          checked={agreed}
          onChange={(event) => setAgreed(event.target.checked)}
          className="mt-0.5 h-5 w-5 accent-yellow-400"
        />
        <span>
          I accept the GST-inclusive pricing above, usage from activation, normal billing from{" "}
          {normalBillingDate()}, cancel-anytime terms, and Stripe’s secure payment setup.
        </span>
      </label>
      <div className="flex gap-3 rounded-xl bg-muted/60 p-4 text-xs text-muted-foreground">
        <CreditCard className="h-5 w-5 shrink-0 text-foreground" />
        <p>
          Stripe opens securely inside this guided setup and returns you to verified activation.
          Rapid Connect never receives or stores your raw card number. Switching a service off
          pauses operation; it does not cancel billing.
        </p>
      </div>
      {promo.status !== "valid" && (
        <p className="text-sm text-destructive">
          A verified offer code is required to continue with the A$0 setup offer.
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
        <SummaryRow
          label="Normal subscription"
          value={`${moneyFromCents(plan.platformFeeCents)}/month incl GST`}
        />
        <SummaryRow label="First three months" value="A$0 platform fees" accent />
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
        <span className="text-sm font-bold">Sign-on fee</span>
        <span className="text-3xl font-black text-primary">
          {promo.status === "valid" ? "A$0" : "—"}
        </span>
      </div>
      <p className="mt-4 text-[11px] leading-relaxed text-muted-foreground">
        If activated today, normal subscription billing begins {normalBillingDate()}. Prices are AUD
        and the prominent totals include GST. Usage is metered separately from day one. Cancel
        anytime.
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
  signedIn: boolean,
): string | null {
  if (draft.step === 1) {
    if (draft.businessName.trim().length < 2) return "Enter your business name.";
    if (draft.firstName.trim().length < 2 || draft.lastName.trim().length < 2)
      return "Enter your first and last name.";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(draft.email.trim()))
      return "Enter a valid email address.";
    if (draft.contactEmail.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(draft.contactEmail.trim()))
      return "Enter a valid business contact email address.";
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
    if (acquisitionServiceRows(draft.servicesOffered).length === 0)
      return "Add at least one plumbing service.";
    if (acquisitionAreaRows(draft.serviceArea).length === 0)
      return "Enter the suburb or service area you cover.";
  }
  if (draft.step === 3 && promo.status !== "valid")
    return "Enter a valid offer code to waive the setup fee.";
  if (draft.step === 4) {
    if (!signedIn && password.length < 10) return "Create a password with at least 10 characters.";
    if (!agreed) return "Confirm the displayed prices and secure payment setup to continue.";
    if (promo.status !== "valid") return "The setup-fee waiver must be verified before signup.";
  }
  return null;
}
