import { createFileRoute } from "@tanstack/react-router";
import { handleOutreachUnsubscribe, type OutreachSuppressionStore } from "@/lib/outreach.server";

export const Route = createFileRoute("/api/public/outreach/unsubscribe")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const store: OutreachSuppressionStore = {
          async suppress() {
            throw new Error("Endpoint suppression is not used by this route");
          },
          async suppressByToken({ tokenHash, source }) {
            const { error } = await supabaseAdmin.rpc(
              "unsubscribe_outreach_recipient" as never,
              { _token_hash: tokenHash, _source: source } as never,
            );
            if (error) throw new Error("Unsubscribe failed");
          },
        };
        return handleOutreachUnsubscribe(request, store);
      },
    },
  },
});
