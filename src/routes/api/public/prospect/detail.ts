/**
 * GET /api/public/prospect/detail?id=... — operator-only single-prospect detail.
 *
 * Includes evidence/provenance, the deterministic score breakdown, branding and demo
 * metadata (never the demo token/hash). Operator-gated.
 */
import { createFileRoute } from "@tanstack/react-router";
import { authorizeOperator, OperatorAuthError } from "@/lib/prospect/operator-auth";
import { toOperatorDetail } from "@/lib/prospect/operator";
import { createSupabaseProspectStore } from "@/lib/prospect/supabase-store";

const headers = { "Content-Type": "application/json", "Cache-Control": "no-store" };

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers });
}

export async function handleProspectDetail(request: Request): Promise<Response> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  try {
    await authorizeOperator(request, supabaseAdmin as never, {
      acquisition: process.env.ACQUISITION_OPERATOR_USER_IDS,
      outreach: process.env.OUTREACH_OPERATOR_USER_IDS,
    });
  } catch (error) {
    if (error instanceof OperatorAuthError) return json({ error: error.message }, error.status);
    return json({ error: "Unauthorized" }, 401);
  }

  const id = new URL(request.url).searchParams.get("id");
  if (!id) return json({ error: "id is required" }, 400);

  try {
    const store = createSupabaseProspectStore(supabaseAdmin);
    const prospect = await store.getById(id);
    if (!prospect) return json({ error: "Not found" }, 404);
    const [facts, score, demo, events] = await Promise.all([
      store.listFacts(id),
      store.getScore(id),
      store.latestDemo(id),
      store.listEvents(id),
    ]);
    return json({ prospect: toOperatorDetail(prospect, facts, score, demo), events });
  } catch {
    return json({ error: "Prospect detail is temporarily unavailable" }, 503);
  }
}

export const Route = createFileRoute("/api/public/prospect/detail")({
  server: { handlers: { GET: async ({ request }) => handleProspectDetail(request) } },
});
