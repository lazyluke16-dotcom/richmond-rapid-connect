/**
 * POST /api/public/discovery/control — operator-only mission lifecycle control.
 *
 * { missionId, action: 'start' | 'pause' | 'resume' | 'cancel' }. Lifecycle only; contacts
 * no one. 'start'/'resume' both move the mission to running via startMission.
 */
import { createFileRoute } from "@tanstack/react-router";
import { authorizeOperator, OperatorAuthError } from "@/lib/prospect/operator-auth";
import { buildEngineDeps } from "@/lib/discovery/engine-context";
import { cancelMission, pauseMission, startMission } from "@/lib/discovery/mission-engine";
import { toMissionSummary } from "@/lib/discovery/mission-operator";

const headers = { "Content-Type": "application/json", "Cache-Control": "no-store" };
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers });
}

const ACTIONS = new Set(["start", "pause", "resume", "cancel"]);

export async function handleMissionControl(request: Request): Promise<Response> {
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

  let body: { missionId?: string; action?: string };
  try {
    body = (await request.json()) as { missionId?: string; action?: string };
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }
  if (!body.missionId) return json({ error: "missionId is required" }, 400);
  if (!body.action || !ACTIONS.has(body.action)) return json({ error: "invalid action" }, 400);

  try {
    const deps = await buildEngineDeps(supabaseAdmin);
    let mission;
    if (body.action === "start" || body.action === "resume")
      mission = await startMission(deps, body.missionId);
    else if (body.action === "pause") mission = await pauseMission(deps, body.missionId);
    else mission = await cancelMission(deps, body.missionId);
    return json({ mission: toMissionSummary(mission) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "control failed";
    return json({ error: message }, /not found/i.test(message) ? 404 : 409);
  }
}

export const Route = createFileRoute("/api/public/discovery/control")({
  server: { handlers: { POST: async ({ request }) => handleMissionControl(request) } },
});
