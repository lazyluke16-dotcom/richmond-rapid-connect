import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { AppShell } from "@/components/AppShell";
import {
  addLead,
  aiQuestionsFor,
  clearDraft,
  jobLabel,
  loadDraft,
  recommendAction,
  saveDraft,
  scoreLead,
  summariseLead,
  type ChatMessage,
  type Draft,
  type JobType,
  type Lead,
  type PropertyType,
  type Urgency,
} from "@/lib/leads";
import { Bot, Send, User, CheckCircle2 } from "lucide-react";
import { insertLead } from "@/lib/db-leads";

export const Route = createFileRoute("/chat")({
  head: () => ({
    meta: [
      { title: "AI receptionist — Richmond Rapid Plumbing" },
      { name: "description", content: "Chat with our AI receptionist so the plumber can assess your job before calling you back." },
    ],
  }),
  component: ChatPage,
});

function ChatPage() {
  const navigate = useNavigate();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [step, setStep] = useState(0);
  const [done, setDone] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const d = loadDraft();
    if (!d.jobType || !d.name || !d.phone) {
      navigate({ to: "/request" });
      return;
    }
    setDraft(d);
    // seed conversation
    const first: ChatMessage[] = [
      {
        role: "ai",
        ts: Date.now(),
        text: `G'day ${d.name?.split(" ")[0] ?? "there"} — thanks for the details. I'm the AI receptionist for Richmond Rapid Plumbing. I'll ask a couple of quick questions so the plumber can assess the job before calling you back.`,
      },
      { role: "ai", ts: Date.now() + 1, text: aiQuestionsFor(d.jobType as JobType)[0] },
    ];
    setMessages(first);
  }, [navigate]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  const send = () => {
    if (!input.trim() || !draft) return;
    const jobType = draft.jobType as JobType;
    const qs = aiQuestionsFor(jobType);
    const newMsgs: ChatMessage[] = [...messages, { role: "customer", text: input.trim(), ts: Date.now() }];
    setInput("");
    const nextStep = step + 1;
    if (nextStep < qs.length) {
      newMsgs.push({ role: "ai", text: qs[nextStep], ts: Date.now() + 1 });
      setStep(nextStep);
      setMessages(newMsgs);
    } else {
      newMsgs.push({
        role: "ai",
        text: "Beauty — that's enough for the plumber to get started. Tap 'Send job request' below and we'll ring you back on the number you gave us.",
        ts: Date.now() + 1,
      });
      setMessages(newMsgs);
      setDone(true);
    }
    // persist chat
    saveDraft({ ...draft, chat: newMsgs });
  };

  const finalise = async () => {
    if (!draft) return;
    const lead: Lead = {
      id: `lead-${Date.now()}`,
      createdAt: Date.now(),
      jobType: draft.jobType as JobType,
      suburb: draft.suburb ?? "Richmond",
      urgency: (draft.urgency as Urgency) ?? "today",
      propertyType: (draft.propertyType as PropertyType) ?? "house",
      photos: draft.photos ?? [],
      name: draft.name ?? "",
      phone: draft.phone ?? "",
      bestTime: draft.bestTime ?? "",
      chat: messages,
      aiSummary: "",
      leadScore: 0,
      recommendedAction: "",
      status: "new",
    };
    lead.aiSummary = summariseLead(lead);
    lead.leadScore = scoreLead(lead);
    lead.recommendedAction = recommendAction(lead.leadScore, lead.urgency);

    const leadSource = (typeof sessionStorage !== 'undefined'
      ? sessionStorage.getItem('lead_source')
      : null) ?? 'form';
    const missedCallId = typeof sessionStorage !== 'undefined'
      ? sessionStorage.getItem('missed_call_id') ?? undefined
      : undefined;

    const finalLead: Lead = {
      ...lead,
      source: leadSource as Lead['source'],
      external_call_id: missedCallId,
    };

    try {
      // Legacy Richmond-only page — pass the tenant slug explicitly since
      // the shared server path no longer has a default-tenant fallback.
      await insertLead({ data: { ...finalLead, businessSlug: 'richmond-rapid-plumbing' } });
    } catch (err) {
      console.error('[DB] insertLead failed, falling back to localStorage:', err);
      addLead(finalLead);
    }

    if (typeof sessionStorage !== 'undefined') {
      sessionStorage.removeItem('lead_source');
      sessionStorage.removeItem('missed_call_id');
    }

    clearDraft();
    navigate({ to: "/confirmation", search: { id: finalLead.id } as never });
  };

  if (!draft) return null;

  return (
    <AppShell showCallBar={false}>
      <div className="mx-auto flex h-[calc(100vh-64px)] max-w-2xl flex-col px-4 pb-6">
        <div className="mt-4 rounded-lg border border-border bg-card p-3 text-sm">
          <div className="text-xs uppercase tracking-widest text-muted-foreground">Your job</div>
          <div className="mt-1 font-bold">
            {jobLabel(draft.jobType as JobType)} · {draft.suburb} · {draft.urgency}
          </div>
        </div>

        <div ref={scrollRef} className="mt-4 flex-1 space-y-3 overflow-y-auto pr-1">
          {messages.map((m, i) => (
            <MessageBubble key={i} m={m} />
          ))}
        </div>

        {done ? (
          <button
            onClick={() => { void finalise(); }}
            className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-md bg-primary px-5 py-4 text-base font-black text-primary-foreground shadow-[var(--shadow-glow)]"
          >
            <CheckCircle2 className="h-5 w-5" /> Send job request
          </button>
        ) : (
          <form
            className="mt-4 flex items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              send();
            }}
          >
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              rows={2}
              placeholder="Type your answer…"
              className="min-w-0 flex-1 resize-none rounded-md border border-border bg-input px-3 py-3 text-base"
            />
            <button
              type="submit"
              disabled={!input.trim()}
              className="grid h-12 w-12 shrink-0 place-items-center rounded-md bg-primary text-primary-foreground disabled:opacity-40"
              aria-label="Send"
            >
              <Send className="h-5 w-5" />
            </button>
          </form>
        )}
      </div>
    </AppShell>
  );
}

function MessageBubble({ m }: { m: ChatMessage }) {
  const isAi = m.role === "ai";
  return (
    <div className={`flex gap-2 ${isAi ? "" : "flex-row-reverse"}`}>
      <div className={`grid h-8 w-8 shrink-0 place-items-center rounded-full ${isAi ? "bg-primary text-primary-foreground" : "bg-secondary text-foreground"}`}>
        {isAi ? <Bot className="h-4 w-4" /> : <User className="h-4 w-4" />}
      </div>
      <div className={`max-w-[80%] rounded-2xl px-4 py-2 text-sm ${isAi ? "bg-card text-foreground" : "bg-primary text-primary-foreground"}`}>
        {m.text}
      </div>
    </div>
  );
}