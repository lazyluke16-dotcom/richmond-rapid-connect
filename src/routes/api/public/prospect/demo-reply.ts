/**
 * POST /api/public/prospect/demo-reply — shared demo runtime (text).
 *
 * Public but access-controlled: requires the demo's unlisted slug AND its unguessable
 * token. Fails closed (404) for unknown/revoked/expired/invalid demos. One shared runtime
 * serves every prospect; it provisions NO provider resources and makes NO outbound calls.
 * The reply is a deterministic, anti-hallucination-safe receptionist response.
 */
import { createFileRoute } from "@tanstack/react-router";
import { DemoAccessService } from "@/lib/prospect/demo-access";
import { respond } from "@/lib/prospect/shared-runtime";
import { createSupabaseProspectStore } from "@/lib/prospect/supabase-store";

const headers = { "Content-Type": "application/json", "Cache-Control": "no-store" };

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers });
}

export async function handleDemoReply(request: Request): Promise<Response> {
  let body: { slug?: string; token?: string; message?: string };
  try {
    body = (await request.json()) as { slug?: string; token?: string; message?: string };
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }
  const slug = (body.slug ?? "").trim();
  const token = (body.token ?? "").trim();
  const message = (body.message ?? "").slice(0, 1000);
  if (!slug || !token) return json({ error: "Not found" }, 404);

  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const store = createSupabaseProspectStore(supabaseAdmin);
  const access = new DemoAccessService(store);
  const resolved = await access.resolve(slug, token);
  if (!resolved.ok) return json({ error: "Not found" }, 404);

  const turn = respond(resolved.config, message);
  await access.logView(resolved.prospect.id, { via: "demo-reply", intent: turn.intent });
  return json({ intent: turn.intent, reply: turn.reply, deferredUnknown: turn.deferredUnknown });
}

export const Route = createFileRoute("/api/public/prospect/demo-reply")({
  server: { handlers: { POST: async ({ request }) => handleDemoReply(request) } },
});
