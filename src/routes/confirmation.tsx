import { createFileRoute, Link } from "@tanstack/react-router";
import { AppShell } from "@/components/AppShell";
import { loadLeads, jobLabel, urgencyLabel } from "@/lib/leads";
import { CheckCircle2, Phone, ArrowRight } from "lucide-react";
import { useEffect, useState } from "react";
import type { Lead } from "@/lib/leads";

export const Route = createFileRoute("/confirmation")({
  validateSearch: (s: Record<string, unknown>) => ({ id: typeof s.id === "string" ? s.id : "" }),
  head: () => ({ meta: [{ title: "Request sent — Richmond Rapid Plumbing" }] }),
  component: ConfirmationPage,
});

function ConfirmationPage() {
  const { id } = Route.useSearch();
  const [lead, setLead] = useState<Lead | null>(null);

  useEffect(() => {
    const found = loadLeads().find((l) => l.id === id) ?? null;
    setLead(found);
  }, [id]);

  return (
    <AppShell showCallBar={false}>
      <div className="mx-auto max-w-2xl px-4 py-10">
        <div className="grid h-16 w-16 place-items-center rounded-full bg-primary text-primary-foreground">
          <CheckCircle2 className="h-9 w-9" />
        </div>
        <h1 className="mt-5 text-3xl font-black sm:text-4xl">Job request sent</h1>
        <p className="mt-2 text-muted-foreground">
          Nice one{lead?.name ? `, ${lead.name.split(" ")[0]}` : ""}. The plumber has your details and will give you a call-back{lead?.urgency === "now" ? " within the next few minutes" : ""}.
        </p>

        {lead && (
          <div className="mt-6 space-y-3 rounded-lg border border-border bg-card p-5">
            <Row k="Job" v={jobLabel(lead.jobType)} />
            <Row k="Suburb" v={`${lead.suburb} · ${lead.propertyType}`} />
            <Row k="Urgency" v={urgencyLabel(lead.urgency)} />
            <Row k="Best time" v={lead.bestTime || "—"} />
            <Row k="Phone" v={lead.phone} />
            <Row k="Photos" v={`${lead.photos.length} attached`} />
            <div className="mt-3 rounded-md bg-secondary p-3 text-sm">
              <div className="text-xs uppercase tracking-widest text-muted-foreground">AI summary for the plumber</div>
              <p className="mt-1">{lead.aiSummary}</p>
            </div>
          </div>
        )}

        <div className="mt-4 rounded-lg border border-primary/30 bg-primary/5 p-4">
          <div className="flex items-center gap-2 text-sm font-bold text-primary">
            <CheckCircle2 className="h-4 w-4" />
            Plumber notified
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {import.meta.env.VITE_SMS_MODE === 'twilio'
              ? 'An SMS has been sent to the plumber with your job summary.'
              : 'Demo mode: in a live deployment, the plumber would receive an SMS with your job summary immediately.'}
          </p>
        </div>

        <div className="mt-6 flex flex-col gap-3 sm:flex-row">
          <a
            href="tel:1300000000"
            className="inline-flex items-center justify-center gap-2 rounded-md bg-primary px-5 py-4 font-black text-primary-foreground"
          >
            <Phone className="h-5 w-5" /> Or call 1300 000 000
          </a>
          <Link
            to="/dashboard"
            className="inline-flex items-center justify-center gap-2 rounded-md border border-border bg-card px-5 py-4 font-bold hover:bg-secondary"
          >
            See the plumber's view <ArrowRight className="h-5 w-5" />
          </Link>
        </div>

        <p className="mt-6 text-xs text-muted-foreground">
          Reminder: we don't promise exact quotes from the chat. The plumber will confirm an estimate once they've spoken with you or seen the job on-site.
        </p>
      </div>
    </AppShell>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-start justify-between gap-4 text-sm">
      <div className="text-muted-foreground">{k}</div>
      <div className="text-right font-semibold">{v}</div>
    </div>
  );
}