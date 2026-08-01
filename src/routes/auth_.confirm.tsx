import { createFileRoute } from "@tanstack/react-router";
import { CheckCircle2, Loader2, MailWarning, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import type { EmailOtpType } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";
import {
  confirmedAcquisitionDestination,
  confirmationFailureMessage,
  readConfirmationParameters,
  safeConfirmationNext,
  safeEmailOtpType,
} from "@/lib/auth-confirmation";

type ConfirmationState = "confirming" | "confirmed" | "failed";

export const Route = createFileRoute("/auth_/confirm")({
  ssr: false,
  head: () => ({
    meta: [{ title: "Confirm your Rapid Connect account" }, { name: "robots", content: "noindex" }],
  }),
  validateSearch: (search: Record<string, unknown>) => ({
    next: safeConfirmationNext(typeof search.next === "string" ? search.next : undefined),
    code: typeof search.code === "string" ? search.code : undefined,
    token_hash: typeof search.token_hash === "string" ? search.token_hash : undefined,
    type: typeof search.type === "string" ? search.type : undefined,
    error: typeof search.error === "string" ? search.error : undefined,
    error_code: typeof search.error_code === "string" ? search.error_code : undefined,
    error_description:
      typeof search.error_description === "string" ? search.error_description : undefined,
  }),
  component: AuthConfirmationPage,
});

function AuthConfirmationPage() {
  const { next } = Route.useSearch();
  const [state, setState] = useState<ConfirmationState>("confirming");
  const [message, setMessage] = useState("Email confirmed — finishing your secure setup…");

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const parameters = readConfirmationParameters(new URL(window.location.href));
      if (parameters.errorCode) throw new Error(confirmationFailureMessage(parameters.errorCode));

      if (parameters.tokenHash) {
        const type = safeEmailOtpType(parameters.type);
        if (!type) throw new Error("This confirmation link is not valid for email verification.");
        const { error } = await supabase.auth.verifyOtp({
          token_hash: parameters.tokenHash,
          type: type as EmailOtpType,
        });
        if (error) throw error;
      } else if (parameters.code) {
        const { error } = await supabase.auth.exchangeCodeForSession(parameters.code);
        if (error) throw error;
      } else if (parameters.accessToken && parameters.refreshToken) {
        const { error } = await supabase.auth.setSession({
          access_token: parameters.accessToken,
          refresh_token: parameters.refreshToken,
        });
        if (error) throw error;
      }

      // Supabase can consume an implicit-flow fragment while the client starts.
      // Always verify the resulting user rather than trusting URL parameters.
      const deadline = Date.now() + 5_000;
      let user = (await supabase.auth.getUser()).data.user;
      while (!user && Date.now() < deadline) {
        await new Promise((resolve) => window.setTimeout(resolve, 100));
        user = (await supabase.auth.getUser()).data.user;
      }
      if (!user) throw new Error("Sign in is required before secure payment setup can continue.");
      if (cancelled) return;

      // Remove one-time tokens before rendering a stable confirmed state.
      window.history.replaceState({}, "", "/auth/confirm");
      setState("confirmed");
      setMessage("Email confirmed — finishing your secure setup…");
      window.setTimeout(() => {
        window.location.replace(confirmedAcquisitionDestination(next));
      }, 500);
    })().catch((cause) => {
      if (cancelled) return;
      setState("failed");
      setMessage(
        cause instanceof Error
          ? confirmationFailureMessage(
              cause.message.toLowerCase().includes("expired") ? "otp_expired" : null,
            )
          : confirmationFailureMessage(null),
      );
      window.history.replaceState({}, "", "/auth/confirm");
    });
    return () => {
      cancelled = true;
    };
  }, [next]);

  return (
    <main className="grid min-h-dvh place-items-center bg-[#07111a] px-5 text-white">
      <section
        className="w-full max-w-xl rounded-3xl border border-white/15 bg-slate-950 p-7 text-center shadow-2xl sm:p-10"
        aria-live="polite"
        aria-busy={state === "confirming"}
      >
        <div className="text-xs font-black uppercase tracking-[0.2em] text-yellow-300">
          Rapid Connect
        </div>
        <span className="mx-auto mt-6 grid h-16 w-16 place-items-center rounded-full bg-yellow-300/10 text-yellow-300">
          {state === "failed" ? (
            <MailWarning className="h-8 w-8" aria-hidden="true" />
          ) : state === "confirmed" ? (
            <CheckCircle2 className="h-8 w-8" aria-hidden="true" />
          ) : (
            <Loader2 className="h-8 w-8 animate-spin" aria-hidden="true" />
          )}
        </span>
        <h1 className="mt-6 text-3xl font-black">{message}</h1>
        <p className="mt-3 text-sm leading-relaxed text-white/70">
          {state === "failed"
            ? "Your saved setup remains protected. No payment or subscription was created."
            : "We’re securely establishing your session and matching it to your saved business before Stripe opens."}
        </p>
        {state === "failed" && (
          <div className="mt-7 grid gap-3 sm:grid-cols-2">
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="inline-flex min-h-12 items-center justify-center gap-2 rounded-xl bg-yellow-300 px-5 font-black text-slate-950 focus-visible:ring-4 focus-visible:ring-yellow-100/50"
            >
              <RefreshCw className="h-4 w-4" aria-hidden="true" /> Try again
            </button>
            <a
              href={`/auth?next=${encodeURIComponent(next)}`}
              className="inline-flex min-h-12 items-center justify-center rounded-xl border border-white/20 px-5 font-black focus-visible:ring-4 focus-visible:ring-white/30"
            >
              Sign in to continue
            </a>
          </div>
        )}
      </section>
    </main>
  );
}
