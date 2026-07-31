import { createFileRoute } from "@tanstack/react-router";
import type { SupabaseClient } from "@supabase/supabase-js";

import { handleSmsInvoiceCertificationRequest } from "@/lib/sms-invoice-certification.server";
import { getStagingStripeSmsInvoiceProvider } from "@/lib/sms-invoice-stripe.server";
import { SupabaseSmsInvoiceRepository } from "@/lib/sms-invoicing.server";

export const Route = createFileRoute("/api/public/process-sms-invoice")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        return handleSmsInvoiceCertificationRequest(request, {
          createRepository: () =>
            new SupabaseSmsInvoiceRepository(supabaseAdmin as unknown as SupabaseClient),
          createProvider: () => getStagingStripeSmsInvoiceProvider(),
        });
      },
    },
  },
});
