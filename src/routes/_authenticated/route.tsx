import { createFileRoute, Outlet, redirect } from '@tanstack/react-router';
import { supabase } from '@/integrations/supabase/client';

export const Route = createFileRoute('/_authenticated')({
  ssr: false,
  beforeLoad: async ({ location }) => {
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) {
      throw redirect({ to: '/auth' });
    }
    // Route users with incomplete onboarding to the wizard.
    // Skip the check when they're already on /onboarding.
    if (!location.pathname.startsWith('/onboarding')) {
      try {
        const { getOnboardingStatus } = await import('@/lib/onboarding.functions');
        const status = await getOnboardingStatus();
        if (!status.onboarding_completed) {
          throw redirect({ to: '/onboarding' });
        }
      } catch (e) {
        // Re-throw redirect; swallow other errors so dashboard still loads if the check fails transiently.
        if (e && typeof e === 'object' && 'to' in (e as Record<string, unknown>)) throw e;
      }
    }
    return { user: data.user };
  },
  component: () => <Outlet />,
});