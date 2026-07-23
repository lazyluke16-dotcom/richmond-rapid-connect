import { createClient } from "@supabase/supabase-js";
import { defineTool, type ToolContext } from "@lovable.dev/mcp-js";

function supabaseForUser(ctx: ToolContext) {
  return createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_PUBLISHABLE_KEY!, {
    global: { headers: { Authorization: `Bearer ${ctx.getToken()}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export default defineTool({
  name: "list_my_businesses",
  title: "List my businesses",
  description: "List the plumbing businesses the signed-in user is a member of (id, name, slug).",
  inputSchema: {},
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  handler: async (_input, ctx) => {
    if (!ctx.isAuthenticated()) {
      return { content: [{ type: "text", text: "Not authenticated" }], isError: true };
    }
    const db = supabaseForUser(ctx);
    const { data, error } = await db
      .from("business_users")
      .select("business_id, businesses:business_id(id, name, slug, public_phone)");
    if (error) return { content: [{ type: "text", text: error.message }], isError: true };
    const businesses = (data ?? []).map((r: { businesses: unknown }) => r.businesses).filter(Boolean);
    return {
      content: [{ type: "text", text: JSON.stringify(businesses, null, 2) }],
      structuredContent: { businesses },
    };
  },
});