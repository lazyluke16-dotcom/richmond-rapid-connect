import { auth, defineMcp } from "@lovable.dev/mcp-js";
import listMyBusinesses from "./tools/list-my-businesses";
import listRecentLeads from "./tools/list-recent-leads";
import listMissedCalls from "./tools/list-missed-calls";

// The OAuth issuer MUST be the direct Supabase host. On publish, SUPABASE_URL
// is rewritten to the `.lovable.cloud` proxy, which mcp-js rejects (RFC 8414
// issuer mismatch). The project ref survives publish unchanged.
const projectRef = import.meta.env.VITE_SUPABASE_PROJECT_ID ?? "project-ref-unset";

export default defineMcp({
  name: "your-ai-trade-assistant-mcp",
  title: "Your AI Trade Assistant",
  version: "0.1.0",
  instructions:
    "Tools for plumbers using Your AI Trade Assistant. Call list_my_businesses first to get a business id, then list_recent_leads or list_missed_calls to inspect that business's inbox. All calls act as the signed-in user; tenant isolation is enforced by RLS.",
  auth: auth.oauth.issuer({
    issuer: `https://${projectRef}.supabase.co/auth/v1`,
    acceptedAudiences: "authenticated",
  }),
  tools: [listMyBusinesses, listRecentLeads, listMissedCalls],
});