/**
 * POST /api/public/prospect/build — controlled internal demo-build entry point.
 *
 * Operator-only. Given a plumbing business website it researches the business and
 * produces a private, branded demo, advancing the prospect to `demo_ready`. It performs
 * NO outreach and provisions NO provider resources. The raw demo token is returned once.
 */
import { createFileRoute } from "@tanstack/react-router";
import { buildProspectDemo } from "@/lib/prospect/build-demo";
import { authorizeOperator, OperatorAuthError } from "@/lib/prospect/operator-auth";
import { createSupabaseProspectStore } from "@/lib/prospect/supabase-store";

const headers = { "Content-Type": "application/json", "Cache-Control": "no-store" };

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers });
}

export async function handleProspectBuild(request: Request): Promise<Response> {
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

  let body: { website?: string; ttlDays?: number };
  try {
    body = (await request.json()) as { website?: string; ttlDays?: number };
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }
  const website = (body.website ?? "").trim();
  if (!website) return json({ error: "website is required" }, 400);

  const ttlDays = Number.isFinite(body.ttlDays)
    ? Math.max(0, Math.min(365, Number(body.ttlDays)))
    : 30;
  const baseUrl = process.env.PUBLIC_BASE_URL ?? new URL(request.url).origin;

  try {
    const store = createSupabaseProspectStore(supabaseAdmin);
    const result = await buildProspectDemo(store, website, { baseUrl, demoTtlDays: ttlDays });
    return json({
      prospectId: result.prospectId,
      canonicalDomain: result.canonicalDomain,
      created: result.created,
      businessName: result.businessName,
      score: result.score,
      band: result.band,
      demo: result.demo, // includes the one-time token + URL
      notes: result.notes,
    });
  } catch (error) {
    // Surface safe validation errors; never leak internals.
    const message = error instanceof Error ? error.message : "Demo build failed";
    const isValidation =
      /required|canonical|Protocol|Port|not allowed|not public|credentials|hostname|parsed/i.test(
        message,
      );
    return json({ error: isValidation ? message : "Demo build failed" }, isValidation ? 400 : 500);
  }
}

export const Route = createFileRoute("/api/public/prospect/build")({
  server: { handlers: { POST: async ({ request }) => handleProspectBuild(request) } },
});
