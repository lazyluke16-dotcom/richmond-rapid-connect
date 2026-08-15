/**
 * /api/public/discovery/missions — operator-only mission list (GET) + create (POST).
 *
 * Creating a mission stores the operator-curated import seed and bounded limits; it starts
 * nothing and contacts no one. No public discovery interface exists.
 */
import { createFileRoute } from "@tanstack/react-router";
import { authorizeOperator, OperatorAuthError } from "@/lib/prospect/operator-auth";
import { parseMissionCreate, toMissionSummary } from "@/lib/discovery/mission-operator";
import { createSupabaseMissionStore } from "@/lib/discovery/mission-supabase-store";

const headers = { "Content-Type": "application/json", "Cache-Control": "no-store" };
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers });
}

async function operator(request: Request) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const userId = await authorizeOperator(request, supabaseAdmin as never, {
    acquisition: process.env.ACQUISITION_OPERATOR_USER_IDS,
    outreach: process.env.OUTREACH_OPERATOR_USER_IDS,
  });
  return { supabaseAdmin, userId };
}

export async function handleMissionList(request: Request): Promise<Response> {
  try {
    const { supabaseAdmin } = await operator(request);
    const store = createSupabaseMissionStore(supabaseAdmin);
    const missions = await store.listMissions(100);
    return json({ missions: missions.map(toMissionSummary) });
  } catch (error) {
    if (error instanceof OperatorAuthError) return json({ error: error.message }, error.status);
    return json({ error: "Mission list is temporarily unavailable" }, 503);
  }
}

export async function handleMissionCreate(request: Request): Promise<Response> {
  let ctx;
  try {
    ctx = await operator(request);
  } catch (error) {
    if (error instanceof OperatorAuthError) return json({ error: error.message }, error.status);
    return json({ error: "Unauthorized" }, 401);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  let parsed;
  try {
    parsed = parseMissionCreate((body ?? {}) as never);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Invalid mission" }, 400);
  }

  try {
    const store = createSupabaseMissionStore(ctx.supabaseAdmin);
    const mission = await store.createMission({ ...parsed, createdBy: ctx.userId });
    await store.addMissionEvent(mission.id, "created", {
      geography: parsed.geography,
      target: parsed.targetCount,
    });
    return json({ mission: toMissionSummary(mission) });
  } catch {
    return json({ error: "Mission creation failed" }, 500);
  }
}

export const Route = createFileRoute("/api/public/discovery/missions")({
  server: {
    handlers: {
      GET: async ({ request }) => handleMissionList(request),
      POST: async ({ request }) => handleMissionCreate(request),
    },
  },
});
