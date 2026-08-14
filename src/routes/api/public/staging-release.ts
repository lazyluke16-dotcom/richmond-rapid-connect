import { createFileRoute } from "@tanstack/react-router";

import { stagingReleaseIdentity } from "@/lib/staging-release.server";

export const Route = createFileRoute("/api/public/staging-release")({
  server: {
    handlers: {
      GET: async () => {
        const identity = stagingReleaseIdentity();
        if (!identity) return new Response(null, { status: 404 });
        return Response.json(identity, {
          headers: {
            "cache-control": "no-store",
          },
        });
      },
    },
  },
});
