import { createFileRoute, useLocation } from "@tanstack/react-router";
import { AppShell } from "@/components/AppShell";
import { useMyTenantBrand } from "@/hooks/use-my-tenant-brand";
import { useEffect, useState } from "react";
import { fetchLeads, updateLeadStatus } from "@/lib/db-leads";
import { jobLabel, urgencyLabel, type Lead } from "@/lib/leads";
import { SubscriptionSuccess } from "@/components/SubscriptionSuccess";
import { supabase } from "@/integrations/supabase/client";
import {
  AlertTriangle,
  Phone,
  MapPin,
  Camera,
  TrendingUp,
  Clock,
  Bot,
  PhoneCall,
  Search,
  ArrowRight,
  Wrench,
  Power,
  ClipboardList,
  MessageSquareText,
} from "lucide-react";
import { Link } from "@tanstack/react-router";

export const Route = createFileRoute("/_authenticated/dashboard")({
  head: () => ({ meta: [{ title: "Plumber dashboard — Richmond Rapid Plumbing" }] }),
  component: DashboardHome,
});

function DashboardHome() {
  const search = useLocation({
    select: (location) => {
      const values = location.search as Record<string, unknown>;
      return {
        billing: typeof values.billing === "string" ? values.billing : undefined,
        session_id: typeof values.session_id === "string" ? values.session_id : undefined,
      };
    },
  });
  return <DashboardWorkspace home search={search} />;
}

export function DashboardWorkspace({
  home = false,
  search: returnSearch = {},
}: {
  home?: boolean;
  search?: { billing?: string; session_id?: string };
}) {
  const [leads, setLeads] = useState<Lead[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<Lead["status"] | "all">("all");
  const [sourceFilter, setSourceFilter] = useState<NonNullable<Lead["source"]> | "all">("all");
  const [urgentOnly, setUrgentOnly] = useState(false);
  const tenant = useMyTenantBrand();
  const [homeSummary, setHomeSummary] = useState<{
    billing?: { selectedPlan?: string | null; billingStatus?: string };
    connections?: {
      missedCallRecoveryEnabled?: boolean;
      aiReceptionistEnabled?: boolean;
    };
  } | null>(null);

  const loadAll = async () => {
    try {
      const dbLeads = await fetchLeads();
      setLeads(dbLeads);
      const requestedId =
        typeof window === "undefined" ? null : decodeURIComponent(window.location.hash.slice(1));
      setActiveId((prev) =>
        requestedId && dbLeads.some((lead) => lead.id === requestedId)
          ? requestedId
          : (prev ?? dbLeads[0]?.id ?? null),
      );
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load leads");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadAll();
    const interval = setInterval(() => {
      void loadAll();
    }, 5000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (!home) return;
    void supabase.auth.getSession().then(async ({ data }) => {
      const token = data.session?.access_token;
      if (!token) return;
      const response = await fetch("/api/public/billing/summary", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (response.ok) setHomeSummary((await response.json()) as never);
    });
  }, [home]);

  const active = leads.find((l) => l.id === activeId) ?? null;
  const normalisedSearch = search.trim().toLowerCase();
  const visibleLeads = leads.filter((lead) => {
    if (statusFilter !== "all" && lead.status !== statusFilter) return false;
    if (sourceFilter !== "all" && (lead.source ?? "form") !== sourceFilter) return false;
    if (urgentOnly && lead.urgency !== "now" && lead.leadScore < 85) return false;
    if (!normalisedSearch) return true;
    return [lead.name, lead.phone, lead.suburb, jobLabel(lead.jobType), lead.aiSummary]
      .join(" ")
      .toLowerCase()
      .includes(normalisedSearch);
  });

  const handleStatus = async (id: string, status: Lead["status"]) => {
    setLeads((prev) => prev.map((l) => (l.id === id ? { ...l, status } : l)));
    try {
      await updateLeadStatus({ data: { id, status } });
    } catch {
      void loadAll();
    }
  };

  return (
    <AppShell showCallBar={false} tenant={tenant} hidePublicNav>
      <div className="mx-auto max-w-6xl px-4 py-6">
        {home && <SubscriptionSuccess search={returnSearch} />}
        <div className="flex flex-col items-start justify-between gap-4 xl:flex-row">
          <div>
            <div className="text-xs uppercase tracking-widest text-primary">
              {home ? "Your workbench" : "Plumber view"}
            </div>
            <h1 className="mt-1 text-2xl font-black sm:text-3xl">
              {home ? "Dashboard" : "Missed jobs"}
            </h1>
            <p className="text-sm text-muted-foreground">
              {home
                ? "See what needs attention and keep your service ready."
                : "Customer opportunities, prioritised by urgency."}
            </p>
          </div>
          <div className="w-full xl:w-auto">
            <div className="hidden sm:block rounded-md border border-border bg-card px-4 py-2 text-sm">
              <div className="text-muted-foreground text-xs uppercase tracking-widest">
                New today
              </div>
              <div className="text-2xl font-black">
                {leads.filter((l) => l.status === "new").length}
              </div>
            </div>
          </div>
        </div>

        {home && (
          <section className="mt-6 grid gap-3 md:grid-cols-3" aria-label="Workspace status">
            <DashboardStatus
              icon={MessageSquareText}
              title="Missed-Call Recovery"
              state={
                homeSummary?.connections?.missedCallRecoveryEnabled
                  ? "On and operating"
                  : homeSummary?.billing?.selectedPlan === "missed_call_recovery" ||
                      homeSummary?.billing?.selectedPlan === "both"
                    ? "Purchased — finish setup or switch on"
                    : "Not purchased"
              }
              active={Boolean(homeSummary?.connections?.missedCallRecoveryEnabled)}
              to="/call-handling"
            />
            <DashboardStatus
              icon={Bot}
              title="AI Receptionist"
              state={
                homeSummary?.connections?.aiReceptionistEnabled
                  ? "On and operating"
                  : homeSummary?.billing?.selectedPlan === "ai_receptionist" ||
                      homeSummary?.billing?.selectedPlan === "both"
                    ? "Purchased — finish setup or switch on"
                    : "Not purchased"
              }
              active={Boolean(homeSummary?.connections?.aiReceptionistEnabled)}
              to="/call-handling"
            />
            <DashboardStatus
              icon={ClipboardList}
              title="New Missed Jobs"
              state={`${leads.filter((lead) => lead.status === "new").length} waiting for you`}
              active={leads.some((lead) => lead.status === "new")}
              to="/leads"
            />
          </section>
        )}

        {home && !loading && leads.length === 0 && !error && (
          <section className="mt-6 rounded-xl border border-primary/30 bg-card p-5 sm:p-6">
            <div className="flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex gap-4">
                <span className="grid h-11 w-11 shrink-0 place-items-center rounded-lg bg-primary/15 text-primary">
                  <Wrench className="h-5 w-5" aria-hidden="true" />
                </span>
                <div>
                  <h2 className="text-lg font-black">Your first job: connect call handling</h2>
                  <p className="mt-1 max-w-xl text-sm text-muted-foreground">
                    Add your call-forwarding details so Rapid Connect can start recovering the jobs
                    you would otherwise miss.
                  </p>
                </div>
              </div>
              <Link
                to="/call-handling"
                className="inline-flex min-h-11 shrink-0 items-center justify-center gap-2 rounded-lg bg-primary px-4 text-sm font-black text-primary-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                Set up call handling <ArrowRight className="h-4 w-4" aria-hidden="true" />
              </Link>
            </div>
          </section>
        )}

        {loading && (
          <div className="mt-8 text-center text-sm text-muted-foreground">Loading leads…</div>
        )}

        {error && !loading && (
          <div className="mt-6 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
            {error}
          </div>
        )}

        {!loading && (
          <>
            <div className="mt-6 grid gap-2 rounded-lg border border-border bg-card p-3 sm:grid-cols-2 lg:grid-cols-[1fr_auto_auto_auto]">
              <label className="relative block">
                <span className="sr-only">Search jobs</span>
                <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
                <input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search name, phone, suburb or job"
                  className="w-full rounded-md border border-border bg-input py-2 pl-9 pr-3 text-sm"
                />
              </label>
              <select
                aria-label="Filter by status"
                value={statusFilter}
                onChange={(event) => setStatusFilter(event.target.value as Lead["status"] | "all")}
                className="rounded-md border border-border bg-input px-3 py-2 text-sm"
              >
                <option value="all">All statuses</option>
                <option value="new">New</option>
                <option value="called-back">Called back</option>
                <option value="booked">Booked</option>
                <option value="closed">Closed</option>
              </select>
              <select
                aria-label="Filter by source"
                value={sourceFilter}
                onChange={(event) =>
                  setSourceFilter(event.target.value as NonNullable<Lead["source"]> | "all")
                }
                className="rounded-md border border-border bg-input px-3 py-2 text-sm"
              >
                <option value="all">All sources</option>
                <option value="form">Website</option>
                <option value="missed_call">Missed call</option>
                <option value="ai_phone_agent">AI phone</option>
              </select>
              <label className="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm">
                <input
                  type="checkbox"
                  checked={urgentOnly}
                  onChange={(event) => setUrgentOnly(event.target.checked)}
                />
                Urgent only
              </label>
            </div>
            <div className="mt-4 grid gap-4 lg:grid-cols-[360px_1fr]">
              <div className="space-y-2">
                {visibleLeads.map((l) => (
                  <button
                    key={l.id}
                    onClick={() => setActiveId(l.id)}
                    className={`w-full rounded-lg border p-3 text-left transition ${
                      activeId === l.id
                        ? "border-primary bg-primary/10"
                        : "border-border bg-card hover:border-primary/50"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <div className="truncate font-bold">{l.name}</div>
                        {l.isTest && (
                          <span className="mt-1 inline-flex rounded-full bg-sky-500/15 px-2 py-0.5 text-[10px] font-black uppercase tracking-wider text-sky-600 dark:text-sky-300">
                            Test job
                          </span>
                        )}
                        <div className="truncate text-xs text-muted-foreground">
                          {jobLabel(l.jobType)} · {l.suburb}
                        </div>
                      </div>
                      <ScoreBadge score={l.leadScore} urgency={l.urgency} />
                    </div>
                    <div className="mt-2 flex items-center justify-between text-xs text-muted-foreground">
                      <span className="inline-flex items-center gap-1">
                        <Clock className="h-3 w-3" /> {timeAgo(l.createdAt)}
                      </span>
                      <div className="flex items-center gap-2">
                        <SourceChip source={l.source} />
                        <StatusPill status={l.status} />
                      </div>
                    </div>
                  </button>
                ))}
                {visibleLeads.length === 0 && !error && (
                  <div className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
                    {leads.length === 0
                      ? "No jobs have arrived yet."
                      : "No jobs match these filters."}
                  </div>
                )}
              </div>

              <div>
                {active ? (
                  <LeadDetail lead={active} onStatus={(s) => void handleStatus(active.id, s)} />
                ) : (
                  <div className="rounded-lg border border-border bg-card p-8 text-center text-muted-foreground">
                    Select a lead to see the AI summary and recommended action.
                  </div>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </AppShell>
  );
}

function LeadDetail({ lead, onStatus }: { lead: Lead; onStatus: (s: Lead["status"]) => void }) {
  const isUrgent = lead.urgency === "now" || lead.leadScore >= 85;
  return (
    <div className="rounded-lg border border-border bg-card">
      <div
        className={`flex items-start justify-between gap-4 border-b border-border p-5 ${isUrgent ? "bg-destructive/10" : ""}`}
      >
        <div>
          <div className="flex items-center gap-2 text-xs uppercase tracking-widest text-muted-foreground">
            {isUrgent && <AlertTriangle className="h-3.5 w-3.5 text-destructive" />}
            {lead.isTest
              ? "Test job — no customer contact"
              : isUrgent
                ? "Emergency lead"
                : "New job request"}
            <SourceChip source={lead.source} />
          </div>
          <h2 className="mt-1 text-xl font-black">{jobLabel(lead.jobType)}</h2>
          <div className="mt-1 text-sm text-muted-foreground inline-flex items-center gap-2">
            <MapPin className="h-3.5 w-3.5" /> {lead.suburb} · {lead.propertyType}
          </div>
        </div>
        <ScoreBadge score={lead.leadScore} urgency={lead.urgency} large />
      </div>

      <div className="grid gap-5 p-5 md:grid-cols-2">
        <div>
          <SectionTitle>Customer</SectionTitle>
          <div className="mt-2 space-y-1 text-sm">
            <div className="font-bold text-base">{lead.name}</div>
            {lead.isTest ? (
              <div className="inline-flex items-center gap-2 font-semibold text-sky-600 dark:text-sky-300">
                <Phone className="h-4 w-4" /> {lead.phone}
              </div>
            ) : (
              <a
                href={`tel:${lead.phone.replace(/\s/g, "")}`}
                className="inline-flex items-center gap-2 text-primary font-semibold"
              >
                <Phone className="h-4 w-4" /> {lead.phone}
              </a>
            )}
            <div className="text-muted-foreground">Best time: {lead.bestTime || "—"}</div>
            <div className="text-muted-foreground">Urgency: {urgencyLabel(lead.urgency)}</div>
            <div className="text-muted-foreground">Received {timeAgo(lead.createdAt)}</div>
            {lead.external_call_id && (
              <div className="text-muted-foreground text-xs">Call ref: {lead.external_call_id}</div>
            )}
            {lead.call_recording_url && (
              <a
                href={lead.call_recording_url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-primary underline"
              >
                Listen to call recording
              </a>
            )}
          </div>

          <SectionTitle className="mt-6">Recommended action</SectionTitle>
          <div className="mt-2 rounded-md border border-primary/40 bg-primary/10 p-3 text-sm">
            <div className="flex items-center gap-2 font-bold text-primary">
              <TrendingUp className="h-4 w-4" /> {lead.recommendedAction}
            </div>
          </div>

          <SectionTitle className="mt-6">Update status</SectionTitle>
          <div className="mt-2 flex flex-wrap gap-2">
            {(["new", "called-back", "booked", "closed"] as const).map((s) => (
              <button
                key={s}
                onClick={() => onStatus(s)}
                className={`rounded-full border px-3 py-1 text-xs font-bold uppercase tracking-widest ${lead.status === s ? "border-primary bg-primary text-primary-foreground" : "border-border bg-card text-muted-foreground hover:text-foreground"}`}
              >
                {s.replace("-", " ")}
              </button>
            ))}
          </div>
        </div>

        <div>
          <SectionTitle>AI summary</SectionTitle>
          <p className="mt-2 rounded-md bg-secondary p-3 text-sm">{lead.aiSummary}</p>

          <SectionTitle className="mt-6">Photos ({lead.photos.length})</SectionTitle>
          {lead.photos.length ? (
            <div className="mt-2 grid grid-cols-2 gap-2">
              {lead.photos.map((p, i) => (
                <img
                  key={i}
                  src={p}
                  alt={`Job photo ${i + 1}`}
                  className="aspect-square w-full rounded-md border border-border object-cover"
                />
              ))}
            </div>
          ) : (
            <div className="mt-2 flex items-center gap-2 rounded-md border border-dashed border-border p-3 text-xs text-muted-foreground">
              <Camera className="h-4 w-4" /> No photos attached
            </div>
          )}

          <SectionTitle className="mt-6">AI receptionist chat</SectionTitle>
          <div className="mt-2 space-y-2 rounded-md border border-border bg-background p-3 text-sm max-h-72 overflow-y-auto">
            {lead.chat.map((m, i) => (
              <div key={i} className={m.role === "ai" ? "" : "text-primary"}>
                <span className="font-bold uppercase text-[10px] tracking-widest mr-2 text-muted-foreground">
                  {m.role === "ai" ? "AI" : "Cust"}
                </span>
                {m.text}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function DashboardStatus({
  icon: Icon,
  title,
  state,
  active,
  to,
}: {
  icon: typeof Power;
  title: string;
  state: string;
  active: boolean;
  to: string;
}) {
  return (
    <Link
      to={to as never}
      className="rounded-xl border border-border bg-card p-4 outline-none transition hover:border-primary/50 focus-visible:ring-2 focus-visible:ring-ring"
    >
      <div className="flex items-center justify-between gap-3">
        <span className="grid h-10 w-10 place-items-center rounded-lg bg-primary/10 text-primary">
          <Icon className="h-5 w-5" aria-hidden="true" />
        </span>
        <span
          className={`h-2.5 w-2.5 rounded-full ${active ? "bg-emerald-500" : "bg-amber-400"}`}
        />
      </div>
      <div className="mt-3 font-black">{title}</div>
      <div className="mt-1 text-xs text-muted-foreground">{state}</div>
    </Link>
  );
}

function SourceChip({ source }: { source?: Lead["source"] }) {
  if (!source || source === "form") return null;
  const map = {
    missed_call: {
      label: "Missed call",
      icon: PhoneCall,
      cls: "bg-yellow-500/15 text-yellow-400 border-yellow-500/30",
    },
    ai_phone_agent: {
      label: "AI phone",
      icon: Bot,
      cls: "bg-blue-500/15 text-blue-400 border-blue-500/30",
    },
  } as const;
  const cfg = map[source as keyof typeof map];
  if (!cfg) return null;
  const Icon = cfg.icon;
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest ${cfg.cls}`}
    >
      <Icon className="h-2.5 w-2.5" /> {cfg.label}
    </span>
  );
}

function SectionTitle({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`text-xs uppercase tracking-widest text-muted-foreground ${className}`}>
      {children}
    </div>
  );
}

function ScoreBadge({
  score,
  urgency,
  large,
}: {
  score: number;
  urgency: Lead["urgency"];
  large?: boolean;
}) {
  const isHot = urgency === "now" || score >= 85;
  const isWarm = !isHot && score >= 60;
  const cls = isHot
    ? "bg-destructive text-destructive-foreground"
    : isWarm
      ? "bg-primary text-primary-foreground"
      : "bg-secondary text-foreground";
  return (
    <div className={`rounded-md ${cls} ${large ? "px-3 py-2" : "px-2 py-1"} text-center`}>
      <div className={`font-black ${large ? "text-2xl" : "text-sm"} leading-none`}>{score}</div>
      <div
        className={`${large ? "text-[10px]" : "text-[9px]"} uppercase tracking-widest opacity-90`}
      >
        score
      </div>
    </div>
  );
}

function StatusPill({ status }: { status: Lead["status"] }) {
  const label = status.replace("-", " ");
  const cls =
    status === "new"
      ? "text-primary"
      : status === "called-back"
        ? "text-yellow-400"
        : status === "booked"
          ? "text-green-400"
          : "text-muted-foreground";
  return <span className={`uppercase font-bold tracking-widest ${cls}`}>{label}</span>;
}

function timeAgo(ts: number) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
