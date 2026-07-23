export type JobType =
  | "burst-pipe"
  | "blocked-drain"
  | "hot-water"
  | "leaking-tap"
  | "toilet"
  | "gas"
  | "other";

export type Urgency = "now" | "today" | "few-days" | "flexible";
export type PropertyType = "house" | "apartment" | "commercial";

export interface ChatMessage {
  role: "ai" | "customer";
  text: string;
  ts: number;
}

export interface Lead {
  id: string;
  createdAt: number;
  jobType: JobType;
  suburb: string;
  urgency: Urgency;
  propertyType: PropertyType;
  photos: string[]; // data URLs or placeholder URLs
  name: string;
  phone: string;
  bestTime: string;
  chat: ChatMessage[];
  aiSummary: string;
  leadScore: number; // 0-100
  recommendedAction: string;
  status: "new" | "called-back" | "booked" | "closed";
  source?: 'form' | 'missed_call' | 'ai_phone_agent';
  external_call_id?: string;
  call_recording_url?: string;
}

export const JOB_TYPES: { value: JobType; label: string; icon: string; blurb: string }[] = [
  { value: "burst-pipe", label: "Burst pipe / leak", icon: "💥", blurb: "Water where it shouldn't be" },
  { value: "blocked-drain", label: "Blocked drain", icon: "🌀", blurb: "Sink, shower, sewer or stormwater" },
  { value: "hot-water", label: "No hot water", icon: "🔥", blurb: "Cold showers, pilot out, tank leaking" },
  { value: "leaking-tap", label: "Leaking tap or fitting", icon: "💧", blurb: "Drip, spray or loose tap" },
  { value: "toilet", label: "Toilet problem", icon: "🚽", blurb: "Blocked, running or won't flush" },
  { value: "gas", label: "Gas issue", icon: "⚠️", blurb: "Smell of gas, stove or heater" },
  { value: "other", label: "Something else", icon: "🛠️", blurb: "Tell us what's going on" },
];

export const SUBURBS = ["Richmond", "Cremorne", "South Yarra", "Hawthorn", "Abbotsford", "Prahran", "Other"];

const KEY = "rrp_leads_v1";
const DRAFT_KEY = "rrp_draft_v1";

export function loadLeads(): Lead[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return seedLeads();
    const parsed: Lead[] = JSON.parse(raw);
    return parsed;
  } catch {
    return [];
  }
}

export function saveLeads(leads: Lead[]) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(KEY, JSON.stringify(leads));
}

export function addLead(lead: Lead) {
  const all = loadLeads();
  all.unshift(lead);
  saveLeads(all);
}

export type Draft = Partial<Omit<Lead, "id" | "createdAt" | "chat" | "aiSummary" | "leadScore" | "recommendedAction" | "status">> & {
  chat?: ChatMessage[];
};

export function loadDraft(): Draft {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(DRAFT_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

export function saveDraft(d: Draft) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(DRAFT_KEY, JSON.stringify(d));
}

export function clearDraft() {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(DRAFT_KEY);
}

export function jobLabel(t: JobType) {
  return JOB_TYPES.find((j) => j.value === t)?.label ?? "Job";
}

export function urgencyLabel(u: Urgency) {
  return (
    {
      now: "Emergency — right now",
      today: "Today if possible",
      "few-days": "Next few days",
      flexible: "Flexible / booking",
    } as const
  )[u];
}

export function scoreLead(l: Pick<Lead, "urgency" | "jobType" | "photos" | "phone" | "propertyType">): number {
  let score = 40;
  if (l.urgency === "now") score += 35;
  else if (l.urgency === "today") score += 20;
  else if (l.urgency === "few-days") score += 8;
  if (["burst-pipe", "gas", "hot-water"].includes(l.jobType)) score += 15;
  if (l.jobType === "blocked-drain") score += 8;
  if (l.photos.length > 0) score += 8;
  if (l.phone.replace(/\D/g, "").length >= 8) score += 4;
  if (l.propertyType === "commercial") score += 5;
  return Math.min(100, score);
}

export function recommendAction(score: number, urgency: Urgency): string {
  if (urgency === "now" || score >= 85) return "Call back within 5 minutes — dispatch nearest van";
  if (score >= 65) return "Call back within 30 minutes — likely same-day booking";
  if (score >= 45) return "Call back today — book an on-site estimate";
  return "Call back tomorrow — quote over the phone if possible";
}

export function summariseLead(l: Pick<Lead, "jobType" | "suburb" | "urgency" | "propertyType" | "chat" | "photos">): string {
  const bits: string[] = [];
  bits.push(`${jobLabel(l.jobType)} in ${l.suburb} (${l.propertyType}).`);
  bits.push(urgencyLabel(l.urgency) + ".");
  const custMsgs = l.chat.filter((c) => c.role === "customer").map((c) => c.text.trim()).filter(Boolean);
  if (custMsgs.length) {
    bits.push("Customer notes: " + custMsgs.join(" | "));
  }
  if (l.photos.length) bits.push(`${l.photos.length} photo(s) attached.`);
  bits.push("Helps the plumber assess the job before calling.");
  return bits.join(" ");
}

// Scripted AI receptionist follow-ups per job type
export function aiQuestionsFor(job: JobType): string[] {
  switch (job) {
    case "burst-pipe":
      return [
        "Got it — a burst or leak. Have you been able to turn the water off at the mains?",
        "Where's the water coming from — under a sink, in the wall, ceiling, or outside?",
        "How much water — a drip, steady stream, or flooding?",
      ];
    case "blocked-drain":
      return [
        "No worries — which drain is blocked? Kitchen sink, shower, toilet or outside?",
        "Is water backing up, or is it draining slowly?",
        "Any gurgling sounds or bad smells coming from other drains?",
      ];
    case "hot-water":
      return [
        "Righto — is your hot water system gas, electric or heat pump (if you know)?",
        "How old is the unit roughly, and is it inside or outside?",
        "Any water pooling around the base of the tank?",
      ];
    case "leaking-tap":
      return [
        "Sweet — which tap is leaking? Kitchen, bathroom basin, shower or laundry?",
        "Is it dripping from the spout, or leaking around the base/handle?",
        "Roughly how old are the tapware fittings?",
      ];
    case "toilet":
      return [
        "Cheers — is the toilet blocked, running constantly, or not flushing?",
        "Is it the only toilet in the property?",
        "Any water on the floor around the base?",
      ];
    case "gas":
      return [
        "Safety first — can you smell gas right now? If yes, please open windows and stay outside if strong.",
        "Is it near an appliance (stove, heater, hot water) or a fitting?",
        "Have you turned the gas off at the meter?",
      ];
    default:
      return [
        "No worries — can you describe what's happening in a sentence or two?",
        "How long has it been going on?",
        "Anything else the plumber should know before calling you back?",
      ];
  }
}

function seedLeads(): Lead[] {
  const now = Date.now();
  const demo: Lead[] = [
    {
      id: "seed-1",
      createdAt: now - 1000 * 60 * 8,
      jobType: "burst-pipe",
      suburb: "Richmond",
      urgency: "now",
      propertyType: "house",
      photos: [placeholderPhoto("#1f2a44", "leak under sink")],
      name: "Sarah Nguyen",
      phone: "0412 884 221",
      bestTime: "ASAP — I'm home",
      chat: [
        { role: "ai", text: "Have you turned the water off at the mains?", ts: now - 1000 * 60 * 9 },
        { role: "customer", text: "Yes, mains is off. Water was pouring out from under the kitchen sink.", ts: now - 1000 * 60 * 8 },
        { role: "ai", text: "Great job. Any damage to the cabinet or floor?", ts: now - 1000 * 60 * 8 },
        { role: "customer", text: "Cabinet base is soaked and it's spreading onto the timber floor.", ts: now - 1000 * 60 * 7 },
      ],
      aiSummary:
        "Burst pipe under kitchen sink in Richmond (house). Emergency — right now. Customer notes: Mains water is off. | Water spreading onto timber floor. 1 photo(s) attached. Helps the plumber assess the job before calling.",
      leadScore: 96,
      recommendedAction: "Call back within 5 minutes — dispatch nearest van",
      status: "new",
    },
    {
      id: "seed-2",
      createdAt: now - 1000 * 60 * 55,
      jobType: "hot-water",
      suburb: "South Yarra",
      urgency: "today",
      propertyType: "apartment",
      photos: [placeholderPhoto("#2a2033", "hot water unit")],
      name: "Marcus O'Brien",
      phone: "0433 210 909",
      bestTime: "After 4pm today",
      chat: [
        { role: "ai", text: "Is your hot water system gas, electric or heat pump?", ts: now - 1000 * 60 * 56 },
        { role: "customer", text: "Gas, external. Probably 12 years old.", ts: now - 1000 * 60 * 55 },
        { role: "ai", text: "Any water pooling at the base?", ts: now - 1000 * 60 * 55 },
        { role: "customer", text: "Small puddle underneath, pilot won't stay lit.", ts: now - 1000 * 60 * 54 },
      ],
      aiSummary:
        "No hot water in South Yarra (apartment). Today if possible. Customer notes: 12-year-old external gas unit. | Small puddle at base, pilot won't stay lit. 1 photo(s) attached. Helps the plumber assess the job before calling.",
      leadScore: 78,
      recommendedAction: "Call back within 30 minutes — likely same-day booking",
      status: "new",
    },
    {
      id: "seed-3",
      createdAt: now - 1000 * 60 * 60 * 3,
      jobType: "blocked-drain",
      suburb: "Hawthorn",
      urgency: "few-days",
      propertyType: "house",
      photos: [],
      name: "Priya Shah",
      phone: "0400 118 442",
      bestTime: "Weekday mornings",
      chat: [
        { role: "ai", text: "Which drain is blocked?", ts: now - 1000 * 60 * 190 },
        { role: "customer", text: "Shower is draining super slowly, been getting worse over a week.", ts: now - 1000 * 60 * 188 },
      ],
      aiSummary:
        "Blocked drain in Hawthorn (house). Next few days. Customer notes: Shower draining slowly, worsening over a week. Helps the plumber assess the job before calling.",
      leadScore: 56,
      recommendedAction: "Call back today — book an on-site estimate",
      status: "called-back",
    },
  ];
  saveLeads(demo);
  return demo;
}

function placeholderPhoto(bg: string, label: string): string {
  const svg = `<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="400" height="300" viewBox="0 0 400 300"><rect width="400" height="300" fill="${bg}"/><g fill="#f4c430" font-family="system-ui" font-size="18" text-anchor="middle"><text x="200" y="140">📷</text><text x="200" y="175">${label}</text><text x="200" y="200" font-size="12" fill="#aaa">demo photo</text></g></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

export { placeholderPhoto };