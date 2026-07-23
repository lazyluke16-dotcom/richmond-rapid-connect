import { createFileRoute, Link, getRouteApi } from '@tanstack/react-router';
import { CheckCircle2, Phone } from 'lucide-react';

const parentRoute = getRouteApi('/b/$slug');

export const Route = createFileRoute('/b/$slug/confirmation')({
  validateSearch: (s: Record<string, unknown>) => ({ id: typeof s.id === 'string' ? s.id : '' }),
  component: TenantConfirmation,
});

function TenantConfirmation() {
  const bundle = parentRoute.useLoaderData();
  const { slug } = Route.useParams();
  const b = bundle.business;
  return (
    <div className="mx-auto max-w-2xl px-4 py-10">
      <div className="grid h-16 w-16 place-items-center rounded-full text-white" style={{ background: 'var(--tenant-primary)' }}>
        <CheckCircle2 className="h-9 w-9" />
      </div>
      <h1 className="mt-5 text-3xl font-black">Job request sent</h1>
      <p className="mt-2 text-muted-foreground">{b.name} has your details and will call you back shortly.</p>
      <div className="mt-6 flex flex-col gap-3 sm:flex-row">
        {b.public_phone && (
          <a href={`tel:${b.public_phone.replace(/\s/g, '')}`} className="inline-flex items-center justify-center gap-2 rounded-md px-5 py-4 font-black text-white" style={{ background: 'var(--tenant-primary)' }}>
            <Phone className="h-5 w-5" /> Or call {b.public_phone}
          </a>
        )}
        <Link to="/b/$slug" params={{ slug }} className="inline-flex items-center justify-center gap-2 rounded-md border border-border bg-card px-5 py-4 font-bold">Back to {b.name}</Link>
      </div>
    </div>
  );
}