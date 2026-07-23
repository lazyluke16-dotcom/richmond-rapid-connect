import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/api/dashboard/verify-pin')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const body = (await request.json()) as { pin?: string };
        const submitted = (body.pin ?? '').trim();
        const expected = process.env.DASHBOARD_PIN ?? '';

        if (!expected) {
          return new Response(JSON.stringify({ ok: true, noPinSet: true }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }

        const ok = submitted === expected;
        return new Response(JSON.stringify({ ok }), {
          status: ok ? 200 : 401,
          headers: { 'Content-Type': 'application/json' },
        });
      },
    },
  },
});