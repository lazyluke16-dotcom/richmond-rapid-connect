/**
 * POST /api/public/prospect/revoke — operator-only demo revocation.
 *
 * Revokes the prospect's latest private demo so its link fails closed immediately.
 * Idempotent. Operator-gated.
 */
import { createFileRoute } from "@tanstack/react-router";
import { authorizeOperator, OperatorAuthError } from "@/lib/prospect/operator-auth";
import { DemoAccessService } from "@/lib/prospect/demo-access";
import { createSupabaseProspectStore } from "@/lib/prospect/supabase-store";

const headers = { "Content-Type": "application/json", "Cache-Control": "no-store" };

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers });
}

export async function handleProspectRevoke(request: Request): Promise<Response> {
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

  let body: { prospectId?: string };
  try {
    body = (await request.json()) as { prospectId?: string };
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }
  if (!body.prospectId) return json({ error: "prospectId is required" }, 400);

  try {
    const store = createSupabaseProspectStore(supabaseAdmin);
    const service = new DemoAccessService(store);
    const revoked = await service.revokeLatest(body.prospectId);
    return json({ revoked });
  } catch {
    return json({ error: "Revocation failed" }, 500);
  }
}

export const Route = createFileRoute("/api/public/prospect/revoke")({
  server: { handlers: { POST: async ({ request }) => handleProspectRevoke(request) } },
});
