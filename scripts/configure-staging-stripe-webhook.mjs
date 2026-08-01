import Stripe from "stripe";
import { pathToFileURL } from "node:url";

const LEGACY_HOST = "your-ai-trade-assistant.lovable.app";
const WEBHOOK_PATH = "/api/public/webhooks/stripe-inbound";

function required(env, name) {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export async function configureStagingStripeWebhook(env = process.env, StripeClient = Stripe) {
  if (env.DEPLOYMENT_TARGET !== "staging" || env.STRIPE_MODE !== "test") {
    throw new Error("Stripe webhook repair is restricted to staging test mode");
  }
  const key = required(env, "STRIPE_SECRET_KEY");
  if (!key.startsWith("sk_test_")) {
    throw new Error("Stripe webhook repair requires a test secret key");
  }

  const baseUrl = new URL(env.CERTIFICATION_BASE_URL ?? "");
  if (baseUrl.protocol !== "https:" || !baseUrl.hostname.includes("staging")) {
    throw new Error("CERTIFICATION_BASE_URL must be an HTTPS staging origin");
  }
  const desiredUrl = new URL(WEBHOOK_PATH, baseUrl).toString();
  const stripe = new StripeClient(key, { apiVersion: "2026-06-24.dahlia" });
  const endpoints = await stripe.webhookEndpoints.list({ limit: 100 });
  const eligible = endpoints.data.filter((endpoint) => {
    const url = new URL(endpoint.url);
    return (
      !endpoint.livemode &&
      endpoint.status === "enabled" &&
      url.pathname === WEBHOOK_PATH &&
      (url.hostname === LEGACY_HOST || endpoint.url === desiredUrl)
    );
  });
  if (eligible.length !== 1) {
    throw new Error(
      `Expected exactly one eligible test webhook endpoint; found ${eligible.length}`,
    );
  }

  const endpoint = eligible[0];
  if (endpoint.url !== desiredUrl) {
    await stripe.webhookEndpoints.update(endpoint.id, { url: desiredUrl });
  }
  return { endpointId: endpoint.id, changed: endpoint.url !== desiredUrl, url: desiredUrl };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  configureStagingStripeWebhook()
    .then((result) => {
      console.log(
        JSON.stringify({
          ok: true,
          changed: result.changed,
          targetHost: new URL(result.url).hostname,
          mode: "test",
        }),
      );
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : "Stripe webhook repair failed");
      process.exitCode = 1;
    });
}
