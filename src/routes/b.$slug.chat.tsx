import { createFileRoute, useNavigate, getRouteApi } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import {
  aiQuestionsFor, clearDraft, jobLabel, loadDraft, recommendAction,
  saveDraft, scoreLead, summariseLead,
  type ChatMessage, type Draft, type JobType, type Lead, type PropertyType, type Urgency,
} from '@/lib/leads';
import { insertLead } from '@/lib/db-leads';
import { Bot, Send, User, CheckCircle2 } from 'lucide-react';

const parentRoute = getRouteApi('/b/$slug');

export const Route = createFileRoute('/b/$slug/chat')({
  component: TenantChat,
});

function TenantChat() {
  const bundle = parentRoute.useLoaderData();
  const { slug } = Route.useParams();
  const navigate = useNavigate();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [step, setStep] = useState(0);
  const [done, setDone] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const d = loadDraft();
    if (!d.jobType || !d.name || !d.phone) {
      navigate({ to: '/b/$slug/request', params: { slug } });
      return;
    }
    setDraft(d);
    setMessages([
      { role: 'ai', ts: Date.now(), text: `G'day ${d.name?.split(' ')[0] ?? 'there'} — thanks for the details. I'm the AI receptionist for ${bundle.business.name}.` },
      { role: 'ai', ts: Date.now() + 1, text: aiQuestionsFor(d.jobType as JobType)[0] },
    ]);
  }, [navigate, slug, bundle.business.name]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  const send = () => {
    if (!input.trim() || !draft) return;
    const jobType = draft.jobType as JobType;
    const qs = aiQuestionsFor(jobType);
    const newMsgs: ChatMessage[] = [...messages, { role: 'customer', text: input.trim(), ts: Date.now() }];
    setInput('');
    const nextStep = step + 1;
    if (nextStep < qs.length) {
      newMsgs.push({ role: 'ai', text: qs[nextStep], ts: Date.now() + 1 });
      setStep(nextStep);
      setMessages(newMsgs);
    } else {
      newMsgs.push({ role: 'ai', text: "Beauty — enough for the plumber. Tap 'Send job request'.", ts: Date.now() + 1 });
      setMessages(newMsgs);
      setDone(true);
    }
    saveDraft({ ...draft, chat: newMsgs });
  };

  const finalise = async () => {
    if (!draft) return;
    const firstArea = bundle.areas[0] as { suburb: string } | undefined;
    const lead: Lead = {
      id: `lead-${Date.now()}`,
      createdAt: Date.now(),
      jobType: draft.jobType as JobType,
      suburb: draft.suburb ?? firstArea?.suburb ?? 'Unknown',
      urgency: (draft.urgency as Urgency) ?? 'today',
      propertyType: (draft.propertyType as PropertyType) ?? 'house',
      photos: draft.photos ?? [],
      name: draft.name ?? '',
      phone: draft.phone ?? '',
      bestTime: draft.bestTime ?? '',
      chat: messages,
      aiSummary: '',
      leadScore: 0,
      recommendedAction: '',
      status: 'new',
    };
    lead.aiSummary = summariseLead(lead);
    lead.leadScore = scoreLead(lead);
    lead.recommendedAction = recommendAction(lead.leadScore, lead.urgency);

    const leadSource = (typeof sessionStorage !== 'undefined' ? sessionStorage.getItem('lead_source') : null) ?? 'form';
    const missedCallId = typeof sessionStorage !== 'undefined' ? sessionStorage.getItem('missed_call_id') ?? undefined : undefined;

    await insertLead({ data: {
      ...lead,
      source: leadSource as Lead['source'],
      external_call_id: missedCallId,
      businessSlug: slug,
    } });
    if (typeof sessionStorage !== 'undefined') {
      sessionStorage.removeItem('lead_source');
      sessionStorage.removeItem('missed_call_id');
    }
    clearDraft();
    navigate({ to: '/b/$slug/confirmation', params: { slug }, search: { id: lead.id } as never });
  };

  if (!draft) return null;

  return (
    <div className="mx-auto flex h-[calc(100vh-64px)] max-w-2xl flex-col px-4 pb-6">
      <div className="mt-4 rounded-lg border border-border bg-card p-3 text-sm">
        <div className="text-xs uppercase tracking-widest text-muted-foreground">Your job</div>
        <div className="mt-1 font-bold">{jobLabel(draft.jobType as JobType)} · {draft.suburb} · {draft.urgency}</div>
      </div>
      <div ref={scrollRef} className="mt-4 flex-1 space-y-3 overflow-y-auto pr-1">
        {messages.map((m, i) => (
          <div key={i} className={`flex gap-2 ${m.role === 'ai' ? '' : 'flex-row-reverse'}`}>
            <div className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-white" style={{ background: m.role === 'ai' ? 'var(--tenant-primary)' : 'hsl(var(--secondary))' }}>
              {m.role === 'ai' ? <Bot className="h-4 w-4" /> : <User className="h-4 w-4" />}
            </div>
            <div className={`max-w-[80%] rounded-2xl px-4 py-2 text-sm ${m.role === 'ai' ? 'bg-card text-foreground' : 'text-white'}`} style={m.role === 'ai' ? {} : { background: 'var(--tenant-primary)' }}>{m.text}</div>
          </div>
        ))}
      </div>
      {done ? (
        <button onClick={() => { void finalise(); }} className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-md px-5 py-4 text-base font-black text-white" style={{ background: 'var(--tenant-primary)' }}>
          <CheckCircle2 className="h-5 w-5" /> Send job request
        </button>
      ) : (
        <form className="mt-4 flex items-end gap-2" onSubmit={(e) => { e.preventDefault(); send(); }}>
          <textarea value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }} rows={2} placeholder="Type your answer…" className="min-w-0 flex-1 resize-none rounded-md border border-border bg-input px-3 py-3" />
          <button type="submit" disabled={!input.trim()} className="grid h-12 w-12 shrink-0 place-items-center rounded-md text-white disabled:opacity-40" style={{ background: 'var(--tenant-primary)' }} aria-label="Send"><Send className="h-5 w-5" /></button>
        </form>
      )}
    </div>
  );
}