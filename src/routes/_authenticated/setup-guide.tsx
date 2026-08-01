import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowRight, Bot, Building2, CheckCircle2, ClipboardList, PhoneCall } from "lucide-react";

export const Route = createFileRoute("/_authenticated/setup-guide")({
  head: () => ({ meta: [{ title: "Setup guide — Rapid Connect" }] }),
  component: SetupGuidePage,
});

const steps = [
  {
    title: "Set up and switch on your service",
    description: "Verify your existing business number, then use the large service switch.",
    to: "/call-handling",
    action: "Open Services",
    icon: PhoneCall,
  },
  {
    title: "Send your first safe test job",
    description: "Create a clearly marked test entry and see the exact details in Missed Jobs.",
    to: "/call-handling",
    action: "Send a test job",
    icon: ClipboardList,
  },
  {
    title: "Check your customer reply",
    description: "Choose the text customers receive after you miss their call.",
    to: "/missed-call-settings",
    action: "Review missed-call texts",
    icon: CheckCircle2,
  },
  {
    title: "Complete your business profile",
    description: "Keep your contact details and service information accurate.",
    to: "/settings",
    action: "Open business profile",
    icon: Building2,
  },
  {
    title: "Explore the AI Receptionist",
    description: "See how calls can be answered when you are on a job or after hours.",
    to: "/ai-receptionist",
    action: "Open AI Receptionist",
    icon: Bot,
  },
] as const;

function SetupGuidePage() {
  return (
    <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6">
      <p className="text-xs font-black uppercase tracking-[0.2em] text-primary">
        Help & setup guide
      </p>
      <h1 className="mt-2 text-3xl font-black">Get to your first captured job</h1>
      <p className="mt-2 max-w-2xl text-muted-foreground">
        Work through these short steps. Your settings stay editable, so you do not need to get
        everything perfect the first time.
      </p>
      <ol className="mt-8 space-y-3">
        {steps.map((step, index) => {
          const Icon = step.icon;
          return (
            <li key={step.title} className="rounded-xl border border-border bg-card p-5">
              <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
                <span className="grid h-11 w-11 shrink-0 place-items-center rounded-lg bg-primary/15 font-black text-primary">
                  <Icon className="h-5 w-5" aria-hidden="true" />
                  <span className="sr-only">Step {index + 1}</span>
                </span>
                <div className="min-w-0 flex-1">
                  <h2 className="font-black">
                    {index + 1}. {step.title}
                  </h2>
                  <p className="mt-1 text-sm text-muted-foreground">{step.description}</p>
                </div>
                <Link
                  to={step.to}
                  className="inline-flex min-h-11 shrink-0 items-center justify-center gap-2 rounded-lg border border-primary/45 px-4 text-sm font-black text-primary outline-none hover:bg-primary hover:text-primary-foreground focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {step.action} <ArrowRight className="h-4 w-4" aria-hidden="true" />
                </Link>
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
