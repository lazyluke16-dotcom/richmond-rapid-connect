/**
 * GET /api/public/discovery/detail?id=... — operator-only mission detail.
 *
 * Returns mission progress, disposition counts and explainable candidate outcomes (no
 * contact values beyond public business identity). Operator-gated.
 */
import { createFileRoute } from "@tanstack/react-router";
import { authorizeOperator, OperatorAuthError } from "@/lib/prospect/operator-auth";
import { toMissionDetail } from "@/lib/discovery/mission-operator";
import { createSupabaseMissionStore } from "@/lib/discovery/mission-supabase-store";

const headers = { "Content-Type": "application/json", "Cache-Control": "no-store" };
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers });
}

export async function handleMissionDetail(request: Request): Promise<Response> {
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
    const store = createSupabaseMissionStore(supabaseAdmin);
    const mission = await store.getMission(id);
    if (!mission) return json({ error: "Not found" }, 404);
    const candidates = await store.listCandidates(id, { limit: 500 });
    return json({ detail: toMissionDetail(mission, candidates) });
  } catch {
    return json({ error: "Mission detail is temporarily unavailable" }, 503);
  }
}

export const Route = createFileRoute("/api/public/discovery/detail")({
  server: { handlers: { GET: async ({ request }) => handleMissionDetail(request) } },
});
