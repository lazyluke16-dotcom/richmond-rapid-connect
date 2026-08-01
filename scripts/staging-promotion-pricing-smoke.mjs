import { pathToFileURL } from "node:url";

const PRODUCTION_LIKE = /(^|[-_.])(prod|production|live)([-_.]|$)/i;
const plans = ["missed_call_recovery", "ai_receptionist", "both"];

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required staging variable: ${name}`);
  return value;
}

function stagingBaseUrl() {
  const baseUrl = new URL(required("CERTIFICATION_BASE_URL"));
  if (
    process.env.DEPLOYMENT_TARGET !== "staging" ||
    baseUrl.protocol !== "https:" ||
    !baseUrl.hostname.includes("staging") ||
    PRODUCTION_LIKE.test(baseUrl.hostname)
  ) {
    throw new Error("Promotion smoke requires an explicit HTTPS staging host");
  }
  return baseUrl;
}

async function validate(baseUrl, code, plan) {
  const response = await fetch(new URL("/api/public/acquisition", baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "validate_promo", code, plan }),
  });
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body };
}

export async function smokePromotionPricing(baseUrl = stagingBaseUrl()) {
  const offerResults = [];
  for (const plan of plans) {
    const result = await validate(baseUrl, "FOUNDINGPLUMBER", plan);
    if (
      result.status !== 200 ||
      result.body.state !== "valid" ||
      result.body.valid !== true ||
      result.body.waivedSetupFeeCents !== 49_900 ||
      result.body.subscriptionMonthsFree !== 3 ||
      result.body.offerVersion !== "founding-2026-three-months"
    ) {
      throw new Error(`Founding offer validation failed for ${plan} (${result.status})`);
    }
    offerResults.push({
      plan,
      state: result.body.state,
      waivedSetupFeeCents: result.body.waivedSetupFeeCents,
      subscriptionMonthsFree: result.body.subscriptionMonthsFree,
    });
  }

  const invalid = await validate(baseUrl, "NOT-A-REAL-OFFER", "missed_call_recovery");
  if (invalid.status !== 200 || invalid.body.state !== "invalid" || invalid.body.valid !== false) {
    throw new Error(`Invalid-code state was not explicit (${invalid.status})`);
  }

  const campaignUrl = new URL("/plumbers", baseUrl);
  campaignUrl.search = new URLSearchParams({
    code: "FOUNDINGPLUMBER",
    source: "human-certification",
    medium: "direct",
    campaign: "pr7-offer-retest",
    content: "campaign",
  }).toString();
  const standardUrl = new URL("/plumbers", baseUrl);
  standardUrl.search = new URLSearchParams({
    source: "human-certification",
    medium: "direct",
    campaign: "pr7-standard-retest",
    content: "standard",
  }).toString();
  const [campaignPage, standardPage] = await Promise.all([fetch(campaignUrl), fetch(standardUrl)]);
  if (!campaignPage.ok || !standardPage.ok) throw new Error("A certification entry URL is down");

  return {
    target: "staging",
    offerResults,
    invalidState: invalid.body.state,
    campaignUrl: campaignUrl.toString(),
    standardUrl: standardUrl.toString(),
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  smokePromotionPricing()
    .then((evidence) => process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`))
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
