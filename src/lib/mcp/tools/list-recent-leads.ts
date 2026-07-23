import { createClient } from "@supabase/supabase-js";
import { defineTool, type ToolContext } from "@lovable.dev/mcp-js";
import { z } from "zod";

function supabaseForUser(ctx: ToolContext) {
  return createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_PUBLISHABLE_KEY!, {
    global: { headers: { Authorization: `Bearer ${ctx.getToken()}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export default defineTool({
  name: "list_recent_leads",
  title: "List recent leads",
  description:
    "List recent leads for a business the signed-in user owns. RLS enforces access — passing another business id returns no rows.",
  inputSchema: {
    business_id: z.string().uuid().describe("Business id (from list_my_businesses)."),
    limit: z.number().int().min(1).max(50).optional().describe("Max leads to return (default 20)."),
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  handler: async ({ business_id, limit }, ctx) => {
    if (!ctx.isAuthenticated()) {
      return { content: [{ type: "text", text: "Not authenticated" }], isError: true };
    }
    const db = supabaseForUser(ctx);
    const { data, error } = await db
      .from("leads")
      .select(
        "id, created_at, name, phone, suburb, job_type, urgency, status, source, ai_summary, lead_score",
      )
      .eq("business_id", business_id)
      .order("created_at", { ascending: false })
      .limit(limit ?? 20);
    if (error) return { content: [{ type: "text", text: error.message }], isError: true };
    return {
      content: [{ type: "text", text: JSON.stringify(data ?? [], null, 2) }],
      structuredContent: { leads: data ?? [] },
    };
  },
});