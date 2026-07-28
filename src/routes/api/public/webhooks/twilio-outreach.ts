import { createFileRoute } from "@tanstack/react-router";
import { handleTwilioOutreachReply, type OutreachSuppressionStore } from "@/lib/outreach.server";

export const Route = createFileRoute("/api/public/webhooks/twilio-outreach")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const store: OutreachSuppressionStore = {
          async suppress({ channel, endpointHash, reason, source, sourceEventId }) {
            const { error } = await supabaseAdmin.rpc(
              "record_outreach_suppression" as never,
              {
                _channel: channel,
                _endpoint_hash: endpointHash,
                _reason: reason,
                _source: source,
                _source_event_id: sourceEventId,
              } as never,
            );
            if (error) throw new Error("Suppression failed");
          },
          async suppressByToken() {
            throw new Error("Token suppression is not used by this route");
          },
        };
        return handleTwilioOutreachReply(
          request,
          {
            authToken: process.env.TWILIO_AUTH_TOKEN ?? "",
            publicBaseUrl:
              process.env.OUTREACH_PUBLIC_BASE_URL ?? process.env.PUBLIC_JOB_REQUEST_URL ?? "",
          },
          store,
        );
      },
    },
  },
});
