import { createFileRoute } from '@tanstack/react-router';
import { getStripe } from '@/lib/stripe.server';
import { extractBearerToken, requireAuthAndBusiness } from '@/lib/billing.server';

export const Route = createFileRoute('/api/public/billing/portal')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const token = extractBearerToken(request);
        if (!token) {
          return new Response(JSON.stringify({ error: 'Unauthorized' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' },
          });
        }

        const { supabaseAdmin } = await import('@/integrations/supabase/client.server');

        let businessId: string;
        try {
          ({ businessId } = await requireAuthAndBusiness(token, supabaseAdmin));
        } catch (e) {
          const err = e as { status?: number; message?: string };
          return new Response(JSON.stringify({ error: err.message ?? 'Auth failed' }), {
            status: err.status ?? 401,
            headers: { 'Content-Type': 'application/json' },
          });
        }

        // Enforce: only access the Stripe customer linked to THIS user's business.
        const { data: billingData, error: billingLookupError } = await supabaseAdmin
          .from('business_billing')
          .select('stripe_customer_id')
          .eq('business_id', businessId)
          .maybeSingle();
        if (billingLookupError) {
          return new Response(JSON.stringify({ error: 'Billing lookup failed' }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
          });
        }

        const customerId = (billingData as { stripe_customer_id?: string | null } | null)?.stripe_customer_id;
        if (!customerId) {
          return new Response(
            JSON.stringify({ error: 'No Stripe customer found. Complete checkout first.' }),
            { status: 404, headers: { 'Content-Type': 'application/json' } },
          );
        }

        const stripe = getStripe();
        const origin = request.headers.get('origin') ?? 'https://your-ai-trade-assistant.lovable.app';

        const portalSession = await stripe.billingPortal.sessions.create({
          customer: customerId,
          return_url: `${origin}/dashboard`,
        });

        return new Response(JSON.stringify({ url: portalSession.url }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
    },
  },
});
