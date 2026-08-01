#!/usr/bin/env node
import { createHash } from "node:crypto";

const MAX_INPUT_BYTES = 5 * 1024 * 1024;
const PUBLIC_LIST_ONLY = /\b(public|online)\s+(directory|listing)|published\s+(online|website)/i;
const HARVESTED = /\bharvest(ed|ing)?\b|scrap(ed|ing)?|bought\s+list/i;

function fail(message) {
  process.stdout.write(
    `${JSON.stringify({ ok: false, eligibleRecipients: 0, errors: [message] })}\n`,
  );
  process.exitCode = 1;
}

function normalizeEndpoint(channel, value) {
  const trimmed = String(value ?? "").trim();
  if (channel === "email") {
    const email = trimmed.toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 254) {
      throw new Error("invalid email destination");
    }
    return email;
  }
  if (channel === "sms") {
    const compact = trimmed.replace(/[\s().-]/g, "");
    const e164 = compact.startsWith("04") ? `+61${compact.slice(1)}` : compact;
    if (!/^\+61\d{9}$/.test(e164)) throw new Error("invalid Australian SMS destination");
    return e164;
  }
  if (channel === "social" && trimmed && trimmed.length <= 320) {
    return trimmed.toLowerCase();
  }
  throw new Error("invalid social destination");
}

function endpointHash(channel, value) {
  return createHash("sha256")
    .update(`${channel}:${normalizeEndpoint(channel, value)}`, "utf8")
    .digest("hex");
}

function nonEmpty(value, min = 1) {
  return typeof value === "string" && value.trim().length >= min;
}

function validateManifest(input) {
  const errors = [];
  const campaign = input?.campaign;
  const recipients = input?.recipients;

  if (!campaign || typeof campaign !== "object") errors.push("campaign is required");
  if (!Array.isArray(recipients) || recipients.length === 0) {
    errors.push("at least one recipient is required");
  }
  if (errors.length) return { errors, eligible: [] };

  if (!nonEmpty(campaign.code, 3) || !/^[a-z0-9][a-z0-9-]{2,63}$/.test(campaign.code)) {
    errors.push("campaign.code must be a lowercase campaign key");
  }
  if (!nonEmpty(campaign.senderLegalName, 2)) {
    errors.push("campaign.senderLegalName is required");
  }
  if (!nonEmpty(campaign.senderContact, 3)) {
    errors.push("campaign.senderContact is required");
  }
  if (!nonEmpty(campaign.baseUrl, 8) || !String(campaign.baseUrl).startsWith("https://")) {
    errors.push("campaign.baseUrl must be an HTTPS URL");
  }
  if (!campaign.templates || typeof campaign.templates !== "object") {
    errors.push("campaign.templates is required");
  }

  for (const [channel, template] of Object.entries(campaign.templates ?? {})) {
    if (!["sms", "email", "social"].includes(channel)) {
      errors.push(`template channel ${channel} is unsupported`);
      continue;
    }
    const body = String(template?.body ?? "");
    const instruction = String(template?.unsubscribeInstruction ?? "");
    if (!body.includes("{{campaign_link}}")) {
      errors.push(`${channel} template must contain {{campaign_link}}`);
    }
    if (!body.toLowerCase().includes(String(campaign.senderLegalName).toLowerCase())) {
      errors.push(`${channel} template must identify campaign.senderLegalName`);
    }
    if (!instruction || !body.toLowerCase().includes(instruction.toLowerCase())) {
      errors.push(`${channel} template must contain its exact unsubscribeInstruction`);
    }
    if (channel === "sms" && !/\breply\s+stop\b/i.test(instruction)) {
      errors.push("SMS unsubscribeInstruction must clearly say Reply STOP");
    }
  }

  const seen = new Set();
  const eligible = [];
  const now = Date.now();
  recipients.forEach((recipient, index) => {
    const ref = `recipient ${index + 1}`;
    const channel = String(recipient?.channel ?? "");
    if (!["sms", "email", "social"].includes(channel)) {
      errors.push(`${ref}: unsupported channel`);
      return;
    }
    if (!campaign.templates?.[channel]) {
      errors.push(`${ref}: no template exists for ${channel}`);
    }
    if (!nonEmpty(recipient.businessName, 2)) errors.push(`${ref}: businessName is required`);
    if (!["express", "inferred"].includes(recipient.permissionBasis)) {
      errors.push(`${ref}: permissionBasis must be express or inferred`);
    }
    if (!nonEmpty(recipient.permissionSource, 3)) {
      errors.push(`${ref}: permissionSource is required`);
    }
    if (HARVESTED.test(String(recipient.permissionSource ?? ""))) {
      errors.push(`${ref}: harvested, scraped or bought-list sources are prohibited`);
    }
    if (
      recipient.permissionBasis === "inferred" &&
      PUBLIC_LIST_ONLY.test(String(recipient.permissionSource ?? ""))
    ) {
      errors.push(`${ref}: a public listing alone is not an inferred-consent basis`);
    }

    const recorded = Date.parse(recipient.permissionRecordedAt);
    const reviewed = Date.parse(recipient.permissionReviewedAt);
    if (!Number.isFinite(recorded) || recorded > now) {
      errors.push(`${ref}: permissionRecordedAt must be a valid past time`);
    }
    if (!Number.isFinite(reviewed) || reviewed > now) {
      errors.push(`${ref}: permissionReviewedAt must be a valid past time`);
    }
    if (!nonEmpty(recipient.permissionReviewedBy, 2)) {
      errors.push(`${ref}: permissionReviewedBy is required`);
    }

    try {
      const hash = endpointHash(channel, recipient.contactValue);
      const dedupeKey = `${channel}:${hash}`;
      if (seen.has(dedupeKey)) {
        errors.push(`${ref}: duplicate destination in this manifest`);
      } else {
        seen.add(dedupeKey);
        eligible.push({ channel, endpointHash: hash });
      }
    } catch (cause) {
      errors.push(`${ref}: ${cause instanceof Error ? cause.message : "invalid destination"}`);
    }
  });

  return { errors, eligible };
}

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  raw += chunk;
  if (Buffer.byteLength(raw, "utf8") > MAX_INPUT_BYTES) {
    fail("input exceeds 5 MB");
    process.stdin.destroy();
  }
});
process.stdin.on("end", () => {
  if (process.exitCode) return;
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    fail("stdin must contain one valid JSON campaign manifest");
    return;
  }

  const { errors, eligible } = validateManifest(input);
  const countsByChannel = eligible.reduce(
    (counts, item) => ({ ...counts, [item.channel]: (counts[item.channel] ?? 0) + 1 }),
    {},
  );
  const report = {
    ok: errors.length === 0,
    campaignCode: nonEmpty(input?.campaign?.code) ? input.campaign.code : null,
    eligibleRecipients: errors.length === 0 ? eligible.length : 0,
    countsByChannel: errors.length === 0 ? countsByChannel : {},
    errors,
    containsContactValues: false,
    sendsPerformed: 0,
  };
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (errors.length) process.exitCode = 1;
});
