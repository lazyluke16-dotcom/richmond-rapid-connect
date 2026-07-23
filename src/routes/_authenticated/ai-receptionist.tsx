import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { AppShell } from "@/components/AppShell";
import { useMyTenantBrand } from "@/hooks/use-my-tenant-brand";
import { useEffect, useState } from "react";
import {
  getMyAiContext,
  updateMyAiSettings,
  simulateAiCall,
  type AiContextPreview,
} from "@/lib/ai-receptionist.functions";
import {
  createAiAssistantForBusiness,
  deactivateAiAssistantForBusiness,
  updateAiAssistantForBusiness,
} from "@/lib/ai-provisioning.functions";
import {
  Bot,
  Loader2,
  AlertTriangle,
  TestTube2,
  ArrowLeft,
  Radio,
  RefreshCw,
  Power,
} from "lucide-react";

export const Route = createFileRoute("/_authenticated/ai-receptionist")({
  head: () => ({
    meta: [
      { title: "AI receptionist settings" },
      { name: "description", content: "Configure the AI phone receptionist for your business." },
    ],
  }),
  component: Page,
});

function Page() {
  const router = useRouter();
  const tenant = useMyTenantBrand();
  const [ctx, setCtx] = useState<AiContextPreview | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [provisioning, setProvisioning] = useState(false);
  const [simResult, setSimResult] = useState<{ leadId: string; externalCallId: string } | null>(
    null,
  );
  const [sim, setSim] = useState({
    customer_name: "Test Caller",
    customer_phone: "+61400000000",
    suburb: "",
    job_description: "Burst pipe under the kitchen sink, water everywhere",
    urgency: "now",
    callback_preference: "asap",
  });

  const load = async () => {
    try {
      setCtx(await getMyAiContext());
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to load");
    }
  };
  useEffect(() => {
    void load();
  }, []);

  const patch = async (
    p: Parameters<typeof updateMyAiSettings>[0] extends { data: infer D } ? D : never,
  ) => {
    setSaving(true);
    try {
      await updateMyAiSettings({ data: p });
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const runSim = async () => {
    setErr(null);
    try {
      const r = await simulateAiCall({ data: sim });
      setSimResult({ leadId: r.leadId, externalCallId: r.externalCallId });
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Simulator failed");
    }
  };

  const provision = async (action: "create" | "update" | "deactivate") => {
    if (!ctx) return;
    setProvisioning(true);
    setErr(null);
    try {
      if (action === "create") {
        const result = await createAiAssistantForBusiness({
          data: { businessId: ctx.business.id },
        });
        if (!result.provisioned) throw new Error(result.reason);
      } else if (action === "update") {
        const result = await updateAiAssistantForBusiness({
          data: { businessId: ctx.business.id },
        });
        if (!result.updated) throw new Error(result.reason);
      } else {
        await deactivateAiAssistantForBusiness({ data: { businessId: ctx.business.id } });
      }
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Provider setup failed");
    } finally {
      setProvisioning(false);
    }
  };

  if (!ctx) {
    return (
      <AppShell showCallBar={false} tenant={tenant} hidePublicNav>
        <div className="mx-auto max-w-4xl p-6 text-sm text-muted-foreground">
          {err ?? "Loading…"}
        </div>
      </AppShell>
    );
  }
  const s = ctx.settings;
  const locked = !ctx.has_access;
  const isProvisioned = Boolean(s.provider_assistant_id);
  const isLive = isProvisioned && s.status === "active" && s.enabled && s.mode === "live";

  return (
    <AppShell showCallBar={false} tenant={tenant} hidePublicNav>
      <div className="mx-auto max-w-4xl px-4 py-6 space-y-6">
        <div className="flex items-start justify-between gap-3">
          <div>
            <button
              onClick={() => router.navigate({ to: "/dashboard" })}
              className="text-xs uppercase tracking-widest text-muted-foreground inline-flex items-center gap-1"
            >
              <ArrowLeft className="h-3 w-3" /> Dashboard
            </button>
            <h1 className="mt-1 text-2xl font-black flex items-center gap-2">
              <Bot className="h-6 w-6 text-primary" /> AI receptionist
            </h1>
            <p className="text-sm text-muted-foreground">
              Configure {ctx.business.name}'s AI phone receptionist. Plan:{" "}
              <b>{ctx.business.selected_plan ?? "—"}</b> · State: <b>{ctx.feature_state}</b>
            </p>
          </div>
          <span
            className={`rounded-full border px-3 py-1 text-xs uppercase tracking-widest font-bold ${locked ? "border-yellow-500/40 bg-yellow-500/10 text-yellow-400" : "border-green-500/40 bg-green-500/10 text-green-400"}`}
          >
            {locked ? "Locked" : "Available"}
          </span>
        </div>

        {err && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
            {err}
          </div>
        )}

        {locked && (
          <div className="rounded-md border border-yellow-500/40 bg-yellow-500/5 p-4 text-sm">
            <div className="font-bold flex items-center gap-2">
              <AlertTriangle className="h-4 w-4" /> AI receptionist not included in your current
              plan
            </div>
            <p className="mt-1 text-muted-foreground">
              Upgrade to the AI receptionist plan or reactivate your trial to enable this feature.{" "}
              <Link to="/onboarding" className="text-primary underline">
                Manage plan
              </Link>
            </p>
          </div>
        )}

        {!locked && (
          <section
            className={`rounded-md border p-4 text-sm ${isLive ? "border-green-500/40 bg-green-500/5" : "border-yellow-500/40 bg-yellow-500/5"}`}
          >
            <div className="font-bold flex items-center gap-2">
              {isLive ? (
                <Radio className="h-4 w-4 text-green-500" />
              ) : (
                <AlertTriangle className="h-4 w-4" />
              )}
              {isLive ? "AI receptionist is live" : "Provider activation required"}
            </div>
            <p className="mt-1 text-muted-foreground">
              {isLive
                ? "Vapi is configured with your current services, areas, hours and call script. New calls are resolved to this business by the trusted assistant mapping."
                : "Create the managed Vapi assistant after reviewing the settings below. A phone number can then be assigned to this assistant during customer activation."}
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              {!isProvisioned ? (
                <button
                  disabled={provisioning}
                  onClick={() => void provision("create")}
                  className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 font-black text-primary-foreground disabled:opacity-50"
                >
                  {provisioning ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Power className="h-4 w-4" />
                  )}{" "}
                  Create and activate assistant
                </button>
              ) : (
                <>
                  <button
                    disabled={provisioning}
                    onClick={() => void provision("update")}
                    className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 font-black text-primary-foreground disabled:opacity-50"
                  >
                    {provisioning ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <RefreshCw className="h-4 w-4" />
                    )}{" "}
                    Sync current settings
                  </button>
                  <button
                    disabled={provisioning}
                    onClick={() => void provision("deactivate")}
                    className="inline-flex items-center gap-2 rounded-md border border-destructive/50 px-4 py-2 font-bold text-destructive disabled:opacity-50"
                  >
                    <Power className="h-4 w-4" /> Deactivate
                  </button>
                </>
              )}
            </div>
          </section>
        )}

        <section className="rounded-lg border border-border bg-card p-4 space-y-4">
          <h2 className="text-sm uppercase tracking-widest text-muted-foreground">Basics</h2>
          <div className="grid md:grid-cols-2 gap-3">
            <Field label="Enabled">
              <input
                type="checkbox"
                checked={s.enabled}
                disabled={locked || saving}
                onChange={(e) => void patch({ enabled: e.target.checked })}
              />
            </Field>
            <Field label="Mode">
              <select
                value={s.mode}
                disabled={locked || saving}
                onChange={(e) => void patch({ mode: e.target.value as "demo" | "live" })}
                className="w-full rounded-md bg-background border border-border px-2 py-1 text-sm"
              >
                <option value="demo">Demo / simulator</option>
                <option value="live">Live (requires provider mapping)</option>
              </select>
            </Field>
            <Field label="Assistant name">
              <Text
                v={s.assistant_name}
                disabled={locked}
                onSave={(v) => void patch({ assistant_name: v })}
              />
            </Field>
            <Field label="Language">
              <Text v={s.language} disabled={locked} onSave={(v) => void patch({ language: v })} />
            </Field>
            <Field label="Tone">
              <Text v={s.tone} disabled={locked} onSave={(v) => void patch({ tone: v })} />
            </Field>
            <Field label="Max call seconds (30–900)">
              <Text
                v={String(s.max_call_duration_seconds)}
                disabled={locked}
                onSave={(v) => void patch({ max_call_duration_seconds: Number(v) })}
              />
            </Field>
          </div>
          <Field label="First message">
            <Area
              v={s.first_message}
              disabled={locked}
              onSave={(v) => void patch({ first_message: v })}
            />
          </Field>
        </section>

        <section className="rounded-lg border border-border bg-card p-4 space-y-3">
          <h2 className="text-sm uppercase tracking-widest text-muted-foreground">Responses</h2>
          <Field label="Callback message">
            <Area
              v={s.callback_message}
              disabled={locked}
              onSave={(v) => void patch({ callback_message: v })}
            />
          </Field>
          <Field label="Pricing response">
            <Area
              v={s.pricing_response}
              disabled={locked}
              onSave={(v) => void patch({ pricing_response: v })}
            />
          </Field>
          <Field label="Human request response">
            <Area
              v={s.human_request_response}
              disabled={locked}
              onSave={(v) => void patch({ human_request_response: v })}
            />
          </Field>
          <Field label="Emergency response">
            <Area
              v={s.emergency_response}
              disabled={locked}
              onSave={(v) => void patch({ emergency_response: v })}
            />
          </Field>
        </section>

        <section className="rounded-lg border border-border bg-card p-4 space-y-3">
          <h2 className="text-sm uppercase tracking-widest text-muted-foreground">Privacy</h2>
          <div className="grid md:grid-cols-3 gap-3">
            <Field label="Recording">
              <input
                type="checkbox"
                checked={s.recording_enabled}
                disabled={locked || saving}
                onChange={(e) => void patch({ recording_enabled: e.target.checked })}
              />
            </Field>
            <Field label="Transcript">
              <input
                type="checkbox"
                checked={s.transcript_enabled}
                disabled={locked || saving}
                onChange={(e) => void patch({ transcript_enabled: e.target.checked })}
              />
            </Field>
            <Field label="AI summary">
              <input
                type="checkbox"
                checked={s.ai_summary_enabled}
                disabled={locked || saving}
                onChange={(e) => void patch({ ai_summary_enabled: e.target.checked })}
              />
            </Field>
          </div>
          <p className="text-xs text-muted-foreground">
            Note: call recording may require caller disclosure/consent depending on jurisdiction.
            Configure a suitable opening message before enabling recording in production.
          </p>
        </section>

        <section className="rounded-lg border border-border bg-card p-4 space-y-2">
          <h2 className="text-sm uppercase tracking-widest text-muted-foreground">
            Configuration preview (what the AI knows)
          </h2>
          <ul className="text-sm space-y-1">
            <li>
              <b>Business:</b> {ctx.business.name}
            </li>
            <li>
              <b>Services:</b> {ctx.services.map((s) => s.label).join(", ") || "—"}
            </li>
            <li>
              <b>Service areas:</b> {ctx.areas.map((a) => a.name).join(", ") || "—"}
            </li>
            <li>
              <b>Hours:</b>{" "}
              {ctx.hours.length
                ? ctx.hours
                    .map(
                      (h) =>
                        `${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][h.day]} ${h.closed ? "closed" : `${h.open ?? ""}–${h.close ?? ""}`}`,
                    )
                    .join(" · ")
                : "—"}
            </li>
            <li>
              <b>Emergency response:</b> {s.emergency_response}
            </li>
          </ul>
          <details className="mt-2">
            <summary className="cursor-pointer text-xs uppercase tracking-widest text-muted-foreground">
              Effective instructions (advanced)
            </summary>
            <pre className="mt-2 max-h-72 overflow-auto rounded bg-background p-3 text-xs whitespace-pre-wrap">
              {ctx.effective_instructions_preview}
            </pre>
          </details>
        </section>

        <section className="rounded-lg border border-primary/40 bg-primary/5 p-4 space-y-3">
          <h2 className="text-sm uppercase tracking-widest text-primary flex items-center gap-2">
            <TestTube2 className="h-4 w-4" /> Test AI call (DEMO)
          </h2>
          <p className="text-xs text-muted-foreground">
            Simulates an AI-captured call and inserts a lead into your dashboard. No external
            telephony is used.
          </p>
          <div className="grid md:grid-cols-2 gap-3">
            <SimField
              label="Customer name"
              v={sim.customer_name}
              onChange={(v) => setSim((p) => ({ ...p, customer_name: v }))}
            />
            <SimField
              label="Phone"
              v={sim.customer_phone}
              onChange={(v) => setSim((p) => ({ ...p, customer_phone: v }))}
            />
            <SimField
              label="Suburb"
              v={sim.suburb}
              onChange={(v) => setSim((p) => ({ ...p, suburb: v }))}
            />
            <SimField
              label="Urgency (now/today/few-days/flexible)"
              v={sim.urgency}
              onChange={(v) => setSim((p) => ({ ...p, urgency: v }))}
            />
            <SimField
              label="Callback preference"
              v={sim.callback_preference}
              onChange={(v) => setSim((p) => ({ ...p, callback_preference: v }))}
            />
          </div>
          <SimField
            label="Job description"
            v={sim.job_description}
            onChange={(v) => setSim((p) => ({ ...p, job_description: v }))}
          />
          <button
            disabled={locked || saving}
            onClick={() => void runSim()}
            className="rounded-md bg-primary text-primary-foreground px-3 py-2 text-sm font-bold uppercase tracking-widest inline-flex items-center gap-2"
          >
            {saving ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <TestTube2 className="h-4 w-4" />
            )}{" "}
            Run simulated AI call
          </button>
          {simResult && (
            <div className="rounded-md border border-green-500/40 bg-green-500/10 p-3 text-sm">
              ✅ Simulated lead created. Lead id: <code>{simResult.leadId}</code> · call id:{" "}
              <code>{simResult.externalCallId}</code>.{" "}
              <Link to="/dashboard" className="text-primary underline">
                Open dashboard
              </Link>
            </div>
          )}
        </section>
      </div>
    </AppShell>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <div className="text-xs uppercase tracking-widest text-muted-foreground mb-1">{label}</div>
      {children}
    </label>
  );
}
function Text({
  v,
  disabled,
  onSave,
}: {
  v: string;
  disabled: boolean;
  onSave: (v: string) => void;
}) {
  const [local, setLocal] = useState(v);
  useEffect(() => setLocal(v), [v]);
  return (
    <input
      disabled={disabled}
      value={local}
      onChange={(e) => setLocal(e.target.value)}
      onBlur={() => local !== v && onSave(local)}
      className="w-full rounded-md bg-background border border-border px-2 py-1 text-sm"
    />
  );
}
function Area({
  v,
  disabled,
  onSave,
}: {
  v: string;
  disabled: boolean;
  onSave: (v: string) => void;
}) {
  const [local, setLocal] = useState(v);
  useEffect(() => setLocal(v), [v]);
  return (
    <textarea
      disabled={disabled}
      value={local}
      onChange={(e) => setLocal(e.target.value)}
      onBlur={() => local !== v && onSave(local)}
      rows={2}
      className="w-full rounded-md bg-background border border-border px-2 py-1 text-sm"
    />
  );
}
function SimField({
  label,
  v,
  onChange,
}: {
  label: string;
  v: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="block">
      <div className="text-xs uppercase tracking-widest text-muted-foreground mb-1">{label}</div>
      <input
        value={v}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-md bg-background border border-border px-2 py-1 text-sm"
      />
    </label>
  );
}
