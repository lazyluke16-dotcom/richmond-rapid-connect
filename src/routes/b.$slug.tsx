import { createFileRoute, Link, notFound, Outlet } from '@tanstack/react-router';
import { getTenantBundleBySlug } from '@/lib/business.functions';
import { tenantCssVars, DAY_NAMES, publicLicenceInfo, type TenantBundle } from '@/lib/business';
import { Phone, ArrowRight, MapPin, Clock, Wrench, ShieldCheck } from 'lucide-react';

export const Route = createFileRoute('/b/$slug')({
  loader: async ({ params }) => {
    const bundle = await getTenantBundleBySlug({ data: { slug: params.slug } });
    if (!bundle) throw notFound();
    return bundle;
  },
  head: ({ loaderData }) => {
    if (!loaderData) {
      return { meta: [{ title: 'Not found' }, { name: 'robots', content: 'noindex' }] };
    }
    const b = loaderData.business;
    const title = `${b.name} — Local plumbers`;
    const desc = b.short_description ?? `${b.name} plumbing services.`;
    return {
      meta: [
        { title },
        { name: 'description', content: desc },
        { property: 'og:title', content: title },
        { property: 'og:description', content: desc },
        { property: 'og:type', content: 'website' },
      ],
    };
  },
  component: TenantLayout,
  notFoundComponent: TenantNotFound,
});

function TenantNotFound() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 text-foreground">
      <div className="max-w-md text-center">
        <h1 className="text-3xl font-black">Business not found</h1>
        <p className="mt-2 text-muted-foreground">This tenant slug isn't registered or isn't active.</p>
      </div>
    </div>
  );
}

function TenantLayout() {
  const bundle = Route.useLoaderData();
  const b = bundle.business;
  return (
    <div
      className="min-h-screen flex flex-col bg-background text-foreground"
      style={tenantCssVars(b)}
      data-tenant-slug={b.slug}
      data-tenant-id={b.id}
    >
      <header className="sticky top-0 z-40 border-b border-border bg-background/95 backdrop-blur">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-3">
          <Link to="/b/$slug" params={{ slug: b.slug }} className="flex items-center gap-2">
            {b.logo_url ? (
              <img src={b.logo_url} alt={`${b.name} logo`} className="h-9 w-9 rounded-md object-cover" />
            ) : (
              <span
                className="grid h-9 w-9 place-items-center rounded-md font-black text-white"
                style={{ background: 'var(--tenant-primary, hsl(var(--primary)))' }}
              >
                {b.name.split(' ').map((w: string) => w[0]).slice(0, 2).join('')}
              </span>
            )}
            <div className="leading-tight">
              <div data-testid="tenant-name" className="font-extrabold tracking-tight text-sm sm:text-base">{b.name}</div>
              {b.emergency_message && (
                <div className="text-[11px] uppercase tracking-widest text-muted-foreground">{b.emergency_message}</div>
              )}
            </div>
          </Link>
          {b.public_phone && (
            <a
              href={`tel:${b.public_phone.replace(/\s/g, '')}`}
              className="hidden sm:inline-flex items-center gap-2 rounded-md px-3 py-2 text-sm font-bold text-white"
              style={{ background: 'var(--tenant-primary, hsl(var(--primary)))' }}
            >
              <Phone className="h-4 w-4" /> {b.public_phone}
            </a>
          )}
        </div>
      </header>
      <main className="flex-1">
        <Outlet />
      </main>
      <footer className="mt-16 border-t border-border">
        <div className="mx-auto max-w-5xl px-4 py-8 text-xs text-muted-foreground">
          <div className="font-bold text-foreground">{b.name}</div>
          <p className="mt-2">Powered by Rapid Connect. Tenant slug: {b.slug}</p>
        </div>
      </footer>
    </div>
  );
}

export function TenantHome() {
  const bundle = Route.useLoaderData() as TenantBundle;
  const b = bundle.business;
  return (
    <div>
      <section
        className="relative overflow-hidden"
        style={{ background: 'linear-gradient(180deg, var(--tenant-secondary, #0F1423) 0%, hsl(var(--background)) 100%)' }}
      >
        <div className="mx-auto max-w-5xl px-4 pt-10 pb-16 sm:pt-16 sm:pb-24">
          {b.emergency_message && (
            <span
              className="inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-bold uppercase tracking-widest text-white"
              style={{ borderColor: 'var(--tenant-primary)', background: 'color-mix(in oklab, var(--tenant-primary) 20%, transparent)' }}
            >
              {b.emergency_message}
            </span>
          )}
          <h1 className="mt-4 text-4xl font-black leading-[1.05] sm:text-6xl text-white">
            <span style={{ color: 'var(--tenant-primary)' }}>{b.hero_heading ?? b.name}</span>
          </h1>
          {b.hero_subheading && (
            <p className="mt-4 max-w-xl text-base text-white/80 sm:text-lg">{b.hero_subheading}</p>
          )}
          <div className="mt-6 flex flex-col gap-3 sm:flex-row">
            <Link
              to="/b/$slug/request"
              params={{ slug: b.slug }}
              className="inline-flex items-center justify-center gap-2 rounded-md px-5 py-4 text-base font-black text-white"
              style={{ background: 'var(--tenant-primary)' }}
            >
              Start job request <ArrowRight className="h-5 w-5" />
            </Link>
            {b.public_phone && (
              <a
                href={`tel:${b.public_phone.replace(/\s/g, '')}`}
                className="inline-flex items-center justify-center gap-2 rounded-md border border-white/20 bg-white/5 px-5 py-4 text-base font-bold text-white"
              >
                <Phone className="h-5 w-5" /> Call {b.public_phone}
              </a>
            )}
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-5xl px-4 py-10">
        <h2 className="text-2xl font-black flex items-center gap-2"><Wrench className="h-5 w-5" style={{ color: 'var(--tenant-primary)' }} /> Services</h2>
        <ul data-testid="tenant-services" className="mt-4 grid gap-3 sm:grid-cols-2">
          {bundle.services.map((s) => (
            <li key={s.id} className="rounded-lg border border-border bg-card p-4">
              <div className="font-bold">{s.display_name}</div>
              {s.description && <div className="mt-1 text-sm text-muted-foreground">{s.description}</div>}
            </li>
          ))}
          {bundle.services.length === 0 && (
            <li className="text-sm text-muted-foreground">No services configured yet.</li>
          )}
        </ul>
      </section>

      <section className="mx-auto max-w-5xl px-4 py-10">
        <h2 className="text-2xl font-black flex items-center gap-2"><MapPin className="h-5 w-5" style={{ color: 'var(--tenant-primary)' }} /> Service areas</h2>
        <ul data-testid="tenant-areas" className="mt-4 flex flex-wrap gap-2">
          {bundle.areas.map((a) => (
            <li key={a.id} className="rounded-full border border-border bg-card px-3 py-1 text-sm">
              {a.suburb}{a.state ? ` · ${a.state}` : ''}
            </li>
          ))}
        </ul>
      </section>

      {bundle.hours.length > 0 && (
        <section className="mx-auto max-w-5xl px-4 py-10">
          <h2 className="text-2xl font-black flex items-center gap-2"><Clock className="h-5 w-5" style={{ color: 'var(--tenant-primary)' }} /> Hours</h2>
          <ul className="mt-4 grid gap-1 sm:max-w-md text-sm">
            {bundle.hours.map((h) => (
              <li key={h.day_of_week} className="flex justify-between border-b border-border/50 py-1">
                <span className="font-semibold">{DAY_NAMES[h.day_of_week]}</span>
                <span className="text-muted-foreground">
                  {h.closed ? 'Closed' : `${(h.open_time ?? '').slice(0, 5)} – ${(h.close_time ?? '').slice(0, 5)}`}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {(() => {
        const licence = publicLicenceInfo(b);
        if (!licence) return null;
        return (
          <section data-testid="tenant-licence" className="mx-auto max-w-5xl px-4 py-10">
            <h2 className="text-2xl font-black flex items-center gap-2">
              <ShieldCheck className="h-5 w-5" style={{ color: 'var(--tenant-primary)' }} /> Licence
            </h2>
            <dl className="mt-4 grid gap-2 sm:max-w-md text-sm">
              {licence.licence_number && (
                <div className="flex justify-between border-b border-border/50 py-1">
                  <dt className="font-semibold">Licence number</dt>
                  <dd data-testid="tenant-licence-number" className="text-muted-foreground">{licence.licence_number}</dd>
                </div>
              )}
              {licence.licence_holder_name && (
                <div className="flex justify-between border-b border-border/50 py-1">
                  <dt className="font-semibold">Holder</dt>
                  <dd data-testid="tenant-licence-holder" className="text-muted-foreground">{licence.licence_holder_name}</dd>
                </div>
              )}
              {licence.licence_expiry && (
                <div className="flex justify-between border-b border-border/50 py-1">
                  <dt className="font-semibold">Expiry</dt>
                  <dd data-testid="tenant-licence-expiry" className="text-muted-foreground">{licence.licence_expiry}</dd>
                </div>
              )}
            </dl>
          </section>
        );
      })()}
    </div>
  );
}