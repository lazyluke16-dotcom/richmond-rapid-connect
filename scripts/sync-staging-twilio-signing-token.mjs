// Canonical, reusable Twilio -> Cloudflare signing-token sync for the isolated
// staging Worker. Every staging deployment path that can deploy
// richmond-rapid-connect-acquisition-staging runs THIS script so the Worker's
// runtime TWILIO_AUTH_TOKEN always equals Twilio's CURRENT Auth Token for the
// exact staging subaccount (the token Twilio signs inbound webhooks with).
//
// The current account Auth Token is read from Twilio Account.json into process
// memory ONLY and streamed straight to the Cloudflare Worker Secrets API. It is
// never printed, hashed/fingerprinted, written to disk, put in GITHUB_OUTPUT,
// stored as a GitHub secret, or passed through --var. Fails closed on any
// account/worker mismatch. Staging-only; never targets production.
//
// Required env:
//   TWILIO_ACCOUNT_SID              (staging subaccount SID; also the REST identity)
//   TWILIO_AUTH_TOKEN              (REST automation credential for read access)
//   CLOUDFLARE_ACCOUNT_ID
//   CLOUDFLARE_API_TOKEN
//   CLOUDFLARE_STAGING_WORKER_NAME (must equal the expected staging worker name)
// Optional env:
//   EXPECTED_STAGING_ACCOUNT_SID   (defaults to TWILIO_ACCOUNT_SID)
//   CERTIFICATION_BASE_URL         (if set, runs a mutation-free synthetic verify)

import { createHmac } from "node:crypto";

const EXPECTED_ACCOUNT_FRIENDLY_NAME = "Richmond Rapid Connect Hosted Staging";
const EXPECTED_WORKER_NAME = "richmond-rapid-connect-acquisition-staging";
const WEBHOOK_PATH = "/api/public/webhooks/twilio-smart-answer";

const clean = (value) => (value ?? "").toString().trim();

function fail(reason) {
  // Reason text never contains the token.
  console.error(`SIGNING_TOKEN_SYNC_BLOCKED: ${reason}`);
  process.exit(1);
}

const SID = clean(process.env.TWILIO_ACCOUNT_SID);
const REST_TOKEN = clean(process.env.TWILIO_AUTH_TOKEN);
const CF_ACCOUNT = clean(process.env.CLOUDFLARE_ACCOUNT_ID);
const CF_TOKEN = clean(process.env.CLOUDFLARE_API_TOKEN);
const WORKER = clean(process.env.CLOUDFLARE_STAGING_WORKER_NAME);
const EXPECTED_SID = clean(process.env.EXPECTED_STAGING_ACCOUNT_SID) || SID;
const BASE_URL = clean(process.env.CERTIFICATION_BASE_URL).replace(/\/+$/, "");

const basicAuth = (user, pass) => "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  // ---- Fail-closed guards (no token involved yet) ----
  if (!SID || !REST_TOKEN) fail("missing_twilio_credentials");
  if (!CF_ACCOUNT || !CF_TOKEN) fail("missing_cloudflare_credentials");
  if (!WORKER) fail("missing_worker_name");
  if (WORKER !== EXPECTED_WORKER_NAME) fail(`worker_name_unexpected:${WORKER}`);
  if (/prod/i.test(WORKER)) fail("worker_looks_production");
  if (SID !== EXPECTED_SID) fail("account_sid_mismatch");

  // ---- Twilio account identity + CURRENT auth token (memory only) ----
  const acctRes = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(SID)}.json`,
    { headers: { Authorization: basicAuth(SID, REST_TOKEN) } },
  );
  if (!acctRes.ok) fail(`twilio_account_http_${acctRes.status}`);
  const acct = await acctRes.json().catch(() => ({}));
  if (acct.friendly_name !== EXPECTED_ACCOUNT_FRIENDLY_NAME) fail("account_friendly_name_unexpected");
  if (acct.sid !== SID) fail("resolved_account_sid_mismatch");

  let token = typeof acct.auth_token === "string" ? acct.auth_token.trim() : "";
  if (!token) fail("current_auth_token_missing");
  if (!/^[0-9a-f]{32}$/i.test(token)) fail("current_auth_token_shape_invalid");

  // ---- Stream directly into the Worker encrypted secret ----
  const putRes = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(CF_ACCOUNT)}/workers/scripts/${encodeURIComponent(WORKER)}/secrets`,
    {
      method: "PUT",
      headers: { Authorization: `Bearer ${CF_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "TWILIO_AUTH_TOKEN", text: token, type: "secret_text" }),
    },
  );
  const putBody = await putRes.json().catch(() => ({}));
  if (!putRes.ok || putBody.success !== true) fail(`worker_secret_put_http_${putRes.status}`);

  // ---- Verify the binding exists (names only) ----
  const listRes = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(CF_ACCOUNT)}/workers/scripts/${encodeURIComponent(WORKER)}/secrets`,
    { headers: { Authorization: `Bearer ${CF_TOKEN}` } },
  );
  const listBody = await listRes.json().catch(() => ({}));
  const present = (listBody.result || []).some((s) => s.name === "TWILIO_AUTH_TOKEN");
  if (!present) fail("worker_secret_not_present_after_put");

  // ---- Optional mutation-free synthetic verify (fictional non-tenant To) ----
  let syntheticAccepted = null;
  let badSignatureRejected = null;
  if (BASE_URL) {
    await sleep(5000); // secret propagation
    const url = `${BASE_URL}${WEBHOOK_PATH}`;
    const fields = {
      AccountSid: SID,
      ApiVersion: "2010-04-01",
      CallSid: "CAsyncdeployverify0000000000000000",
      CallStatus: "ringing",
      Called: "+61491570156",
      Caller: "+61491570199",
      Direction: "inbound",
      From: "+61491570199",
      To: "+61491570156",
    };
    const usp = new URLSearchParams(fields);
    const body = usp.toString();
    const grouped = new Map();
    for (const [k, v] of usp.entries()) {
      const existing = grouped.get(k);
      if (existing) existing.push(v);
      else grouped.set(k, [v]);
    }
    let tail = "";
    for (const key of [...grouped.keys()].sort()) {
      for (const value of [...new Set(grouped.get(key))].sort()) tail += `${key}${value}`;
    }
    const signature = createHmac("sha1", token).update(Buffer.from(url + tail, "utf-8")).digest("base64");

    const post = async (sig) => {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Twilio-Signature": sig },
        body,
      });
      return { status: res.status, text: await res.text() };
    };
    for (let i = 0; i < 4 && syntheticAccepted !== true; i += 1) {
      const r = await post(signature);
      if (r.status === 200 && /reject/i.test(r.text)) syntheticAccepted = true;
      else await sleep(4000);
    }
    const control = await post("AAAAdeliberatelyWrongSignature0000000000=");
    badSignatureRejected = control.status === 401;
  }

  token = null; // drop from memory

  if (BASE_URL && !(syntheticAccepted === true && badSignatureRejected === true)) {
    fail(`synthetic_verify_failed:accepted=${syntheticAccepted}:control401=${badSignatureRejected}`);
  }

  // Booleans/identifiers only — never the token.
  console.log(
    JSON.stringify({
      workerTwilioAuthTokenSynced: true,
      worker: WORKER,
      accountIdentityVerified: true,
      syntheticAccepted,
      badSignatureRejected,
      valuesPrinted: false,
    }),
  );
}

main().catch((error) => {
  console.error("SIGNING_TOKEN_SYNC_ERROR:", String(error?.message ?? error).slice(0, 160));
  process.exit(1);
});
