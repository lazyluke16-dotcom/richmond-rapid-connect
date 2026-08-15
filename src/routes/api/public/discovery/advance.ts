/**
 * POST /api/public/discovery/advance — operator-only bounded mission advance.
 *
 * { missionId, maxSteps? }. Advances a running mission by up to a small, request-bounded
 * number of provider pages (Cloudflare/Nitro friendly — no long-lived worker). All state is
 * persisted, so the operator (or a scheduler) simply re-invokes this to resume. Accepted
 * candidates flow into the Slice-1 pipeline; NO outreach and NO provider resources are
 * created.
 */
import { createFileRoute } from "@tanstack/react-router";
import { authorizeOperator, OperatorAuthError } from "@/lib/prospect/operator-auth";
import { buildEngineDeps } from "@/lib/discovery/engine-context";
import { advanceMission } from "@/lib/discovery/mission-engine";
import { toMissionSummary } from "@/lib/discovery/mission-operator";

const headers = { "Content-Type": "application/json", "Cache-Control": "no-store" };
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers });
}

// Hard cap on pages processed per HTTP request, to stay within edge CPU/time budgets.
const MAX_STEPS_PER_REQUEST = 20;

export async function handleMissionAdvance(request: Request): Promise<Response> {
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

  let body: { missionId?: string; maxSteps?: number };
  try {
    body = (await request.json()) as { missionId?: string; maxSteps?: number };
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }
  if (!body.missionId) return json({ error: "missionId is required" }, 400);
  const maxSteps = Math.max(1, Math.min(MAX_STEPS_PER_REQUEST, Number(body.maxSteps) || 5));
  const baseUrl = process.env.PUBLIC_BASE_URL ?? new URL(request.url).origin;

  try {
    const deps = await buildEngineDeps(supabaseAdmin, {
      missionId: body.missionId,
      withProvider: true,
      baseUrl,
      demoTtlDays: 30,
    });
    let processed = 0;
    let accepted = 0;
    let done = false;
    for (let step = 0; step < maxSteps; step++) {
      const result = await advanceMission(deps, body.missionId);
      processed += result.processed;
      accepted += result.accepted;
      if (
        result.completed ||
        ["completed", "failed", "cancelled", "paused"].includes(result.status)
      ) {
        done = true;
        break;
      }
    }
    const mission = await deps.missionStore.getMission(body.missionId);
    if (!mission) return json({ error: "Not found" }, 404);
    return json({
      mission: toMissionSummary(mission),
      stepProcessed: processed,
      stepAccepted: accepted,
      done,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "advance failed";
    return json(
      { error: /not found/i.test(message) ? "Not found" : "Advance failed" },
      /not found/i.test(message) ? 404 : 500,
    );
  }
}

export const Route = createFileRoute("/api/public/discovery/advance")({
  server: { handlers: { POST: async ({ request }) => handleMissionAdvance(request) } },
});
