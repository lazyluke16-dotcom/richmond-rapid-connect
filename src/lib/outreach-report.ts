export const OUTREACH_REPORT_DEFAULT_DAYS = 30;
export const OUTREACH_REPORT_MAX_DAYS = 90;

export type AcquisitionEventRow = {
  event_name: string;
  session_id: string;
  campaign: string | null;
  source: string | null;
  created_at: string;
};

export type OutreachCampaignRow = {
  id: string;
  name: string;
  code: string;
  status: "draft" | "ready" | "paused" | "completed";
  created_at: string;
};

export type OutreachRecipientRow = {
  campaign_id: string;
  channel: "sms" | "email" | "social";
  eligibility_status: "pending_review" | "eligible" | "suppressed" | "invalid";
};

export type OutreachMessageRow = {
  campaign_id: string;
  channel: "sms" | "email" | "social";
  status:
    "draft" | "queued" | "sending" | "sent" | "delivered" | "failed" | "suppressed" | "cancelled";
};

export type OutreachSuppressionRow = {
  channel: "sms" | "email" | "social";
  reason: string;
  suppressed_at: string;
};

export type AcquisitionRedemptionRow = {
  campaign: string | null;
  plan: "missed_call_recovery" | "ai_receptionist";
  waived_setup_fee_cents: number;
  redeemed_at: string;
};

export type ActivatedBusinessRow = {
  campaign: string | null;
  billing_status: string | null;
};

export type OutreachReportInput = {
  events: AcquisitionEventRow[];
  campaigns: OutreachCampaignRow[];
  recipients: OutreachRecipientRow[];
  messages: OutreachMessageRow[];
  suppressions: OutreachSuppressionRow[];
  redemptions: AcquisitionRedemptionRow[];
  activatedBusinesses: ActivatedBusinessRow[];
  generatedAt: string;
  windowDays: number;
};

export type OutreachReport = ReturnType<typeof buildOutreachOperationsReport>;

const FUNNEL_STEPS = [
  ["landing_viewed", "Landing views"],
  ["demo_started", "Demo starts"],
  ["demo_completed", "Demo completions"],
  ["signup_opened", "Signup opens"],
  ["signup_submitted", "Signup submissions"],
  ["account_created", "Accounts created"],
  ["checkout_opened", "Checkout opens"],
] as const;

function uniqueSessions(events: AcquisitionEventRow[], eventName: string): number {
  return new Set(
    events.filter((event) => event.event_name === eventName).map((event) => event.session_id),
  ).size;
}

function rate(value: number, denominator: number): number | null {
  return denominator > 0 ? Math.round((value / denominator) * 1000) / 10 : null;
}

function countBy<T extends string>(values: T[]): Record<T, number> {
  return values.reduce(
    (counts, value) => {
      counts[value] = (counts[value] ?? 0) + 1;
      return counts;
    },
    {} as Record<T, number>,
  );
}

export function parseOutreachReportDays(raw: string | null): number {
  if (!raw) return OUTREACH_REPORT_DEFAULT_DAYS;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > OUTREACH_REPORT_MAX_DAYS) {
    throw new Error(`Report window must be between 1 and ${OUTREACH_REPORT_MAX_DAYS} days`);
  }
  return value;
}

export function isOutreachOperator(userId: string, configuredUserIds: string | undefined): boolean {
  if (!configuredUserIds?.trim()) return false;
  return configuredUserIds
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .includes(userId);
}

export function buildOutreachOperationsReport(input: OutreachReportInput) {
  const funnelCounts = Object.fromEntries(
    FUNNEL_STEPS.map(([eventName]) => [eventName, uniqueSessions(input.events, eventName)]),
  ) as Record<(typeof FUNNEL_STEPS)[number][0], number>;
  const activated = input.activatedBusinesses.filter((row) =>
    ["active", "trialing"].includes(row.billing_status ?? ""),
  ).length;
  const landingViews = funnelCounts.landing_viewed;

  const funnel = [
    ...FUNNEL_STEPS.map(([key, label]) => ({
      key,
      label,
      value: funnelCounts[key],
      fromLandingPct: rate(funnelCounts[key], landingViews),
    })),
    {
      key: "activated",
      label: "Activated customers",
      value: activated,
      fromLandingPct: rate(activated, landingViews),
    },
  ];

  const campaignBreakdown = new Map<
    string,
    {
      campaign: string;
      landingViews: number;
      demoCompletions: number;
      signupSubmissions: number;
      accountsCreated: number;
      redemptions: number;
      activated: number;
    }
  >();
  const campaignKeys = new Set([
    ...input.events.map((event) => event.campaign ?? "unattributed"),
    ...input.redemptions.map((row) => row.campaign ?? "unattributed"),
    ...input.activatedBusinesses.map((row) => row.campaign ?? "unattributed"),
  ]);
  for (const campaign of campaignKeys) {
    const events = input.events.filter((event) => (event.campaign ?? "unattributed") === campaign);
    campaignBreakdown.set(campaign, {
      campaign,
      landingViews: uniqueSessions(events, "landing_viewed"),
      demoCompletions: uniqueSessions(events, "demo_completed"),
      signupSubmissions: uniqueSessions(events, "signup_submitted"),
      accountsCreated: uniqueSessions(events, "account_created"),
      redemptions: input.redemptions.filter((row) => (row.campaign ?? "unattributed") === campaign)
        .length,
      activated: input.activatedBusinesses.filter(
        (row) =>
          (row.campaign ?? "unattributed") === campaign &&
          ["active", "trialing"].includes(row.billing_status ?? ""),
      ).length,
    });
  }

  const campaigns = input.campaigns.map((campaign) => {
    const recipients = input.recipients.filter((row) => row.campaign_id === campaign.id);
    const messages = input.messages.filter((row) => row.campaign_id === campaign.id);
    const eligibility = countBy(recipients.map((row) => row.eligibility_status));
    const messageStatus = countBy(messages.map((row) => row.status));
    const channels = countBy(recipients.map((row) => row.channel));
    const blockers: string[] = [];
    if (campaign.status !== "ready") blockers.push("Campaign is not approved as ready");
    if (!eligibility.eligible) blockers.push("No reviewed eligible recipients");
    if (eligibility.pending_review)
      blockers.push(`${eligibility.pending_review} recipients pending review`);
    if (!messages.length) blockers.push("No campaign messages prepared");
    if (messageStatus.failed) blockers.push(`${messageStatus.failed} messages failed`);
    return {
      name: campaign.name,
      code: campaign.code,
      status: campaign.status,
      recipients: recipients.length,
      eligibility,
      messages: messageStatus,
      channels,
      blockers,
      readyForControlledSend: blockers.length === 0,
    };
  });

  return {
    generatedAt: input.generatedAt,
    windowDays: input.windowDays,
    privacy: {
      aggregateOnly: true as const,
      rawContactsReturned: false as const,
      endpointHashesReturned: false as const,
      minimumNecessaryFields: true as const,
    },
    funnel,
    campaignAttribution: [...campaignBreakdown.values()]
      .sort((a, b) => b.landingViews - a.landingViews || a.campaign.localeCompare(b.campaign))
      .slice(0, 20),
    outreach: {
      campaigns,
      totalSuppressions: input.suppressions.length,
      suppressionsByChannel: countBy(input.suppressions.map((row) => row.channel)),
      suppressionsByReason: countBy(input.suppressions.map((row) => row.reason)),
      setupFeesWaivedCents: input.redemptions.reduce(
        (sum, row) => sum + Number(row.waived_setup_fee_cents || 0),
        0,
      ),
      redemptionsByPlan: countBy(input.redemptions.map((row) => row.plan)),
    },
  };
}
