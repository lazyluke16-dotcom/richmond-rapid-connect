/**
 * GET /api/public/prospect/list — operator-only prospect roster (privacy-minimal).
 *
 * Returns score/band/status summaries with no contact values. There is no public prospect
 * directory; this endpoint requires an authorised operator.
 */
import { createFileRoute } from "@tanstack/react-router";
import { authorizeOperator, OperatorAuthError } from "@/lib/prospect/operator-auth";
import { toOperatorSummary } from "@/lib/prospect/operator";
import { createSupabaseProspectStore } from "@/lib/prospect/supabase-store";
import type { ProspectStatus } from "@/lib/prospect/types";

const headers = { "Content-Type": "application/json", "Cache-Control": "no-store" };

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers });
}

export async function handleProspectList(request: Request): Promise<Response> {
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

  const params = new URL(request.url).searchParams;
  const band = params.get("band") ?? undefined;
  const status = (params.get("status") as ProspectStatus | null) ?? undefined;
  const limit = Math.max(1, Math.min(200, Number(params.get("limit") ?? "100") || 100));

  try {
    const store = createSupabaseProspectStore(supabaseAdmin);
    const prospects = await store.list({ band, status, limit });
    const rows = await Promise.all(
      prospects.map(async (prospect) => {
        const demo = await store.latestDemo(prospect.id);
        return toOperatorSummary(prospect, Boolean(demo && !demo.revokedAt));
      }),
    );
    return json({ prospects: rows, generatedAt: new Date().toISOString() });
  } catch {
    return json({ error: "Prospect list is temporarily unavailable" }, 503);
  }
}

export const Route = createFileRoute("/api/public/prospect/list")({
  server: { handlers: { GET: async ({ request }) => handleProspectList(request) } },
});
