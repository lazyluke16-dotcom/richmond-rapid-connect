import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { Phone, UserPlus } from "lucide-react";
import { resolveLogoLink } from "@/lib/onboarding-validation";

export interface TenantBrand {
  name: string;
  initials?: string;
  phone?: string | null;
  location?: string | null;
  licence?: string | null;
  /** Own tenant slug — used to route the top-left logo to the caller's own public site. */
  slug?: string | null;
}

interface Props {
  children: ReactNode;
  showCallBar?: boolean;
  tenant?: TenantBrand;
  hidePublicNav?: boolean;
}

function computeInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "??";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

const DEFAULT_TENANT: TenantBrand = {
  name: "Richmond Rapid Plumbing",
  initials: "RR",
  phone: "1300 000 000",
  location: "Melbourne · 24/7",
  licence: "Licensed Victorian plumbers · Lic #12345",
};

export function AppShell({ children, showCallBar = true, tenant, hidePublicNav = false }: Props) {
  const brand: TenantBrand = tenant
    ? {
        ...tenant,
        initials: tenant.initials || computeInitials(tenant.name),
      }
    : DEFAULT_TENANT;
  const phoneDigits = (brand.phone ?? "").replace(/[^\d+]/g, "");
  const phoneDisplay = brand.phone ?? "";
  // Tenant-aware top-left link: authenticated views (hidePublicNav=true)
  // must NEVER send another tenant to Richmond's shared public landing ("/").
  // We route to the caller's own public site when a valid slug exists, or
  // to their own dashboard when it doesn't. Public views keep "/".
  const logoTarget = resolveLogoLink({
    authenticated: hidePublicNav,
    tenantSlug: tenant?.slug ?? null,
  });
  const LogoLink = ({ children }: { children: ReactNode }) => {
    if (logoTarget.kind === "tenant-public") {
      return (
        <Link
          to="/b/$slug"
          params={{ slug: logoTarget.slug }}
          className="flex items-center gap-2"
          aria-label={`${brand.name} — your public site`}
        >
          {children}
        </Link>
      );
    }
    if (logoTarget.kind === "dashboard") {
      return (
        <Link
          to="/dashboard"
          className="flex items-center gap-2"
          aria-label={`${brand.name} — dashboard`}
        >
          {children}
        </Link>
      );
    }
    return (
      <Link to="/" className="flex items-center gap-2">
        {children}
      </Link>
    );
  };
  return (
    <div className="min-h-screen flex flex-col bg-background text-foreground">
      <header className="sticky top-0 z-40 border-b border-border bg-background/95 backdrop-blur">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-3">
          <LogoLink>
            <span className="grid h-9 w-9 place-items-center rounded-md bg-primary text-primary-foreground font-black">
              {brand.initials}
            </span>
            <div className="leading-tight">
              <div className="font-extrabold tracking-tight text-sm sm:text-base">{brand.name}</div>
              {brand.location && (
                <div className="text-[11px] uppercase tracking-widest text-muted-foreground">
                  {brand.location}
                </div>
              )}
            </div>
          </LogoLink>
          {!hidePublicNav && (
            <nav className="hidden md:flex items-center gap-5 text-sm text-muted-foreground">
              <Link to="/services/emergency" className="hover:text-foreground">
                Emergency
              </Link>
              <Link to="/services/blocked-drains" className="hover:text-foreground">
                Blocked drains
              </Link>
              <Link to="/areas" className="hover:text-foreground">
                Areas
              </Link>
              <Link to="/dashboard" className="hover:text-foreground">
                Plumber view
              </Link>
              <Link to="/missed-call" className="hover:text-foreground font-semibold text-primary">
                Demo
              </Link>
              <Link
                to="/signup"
                search={{ partner: undefined, ref: undefined }}
                className="inline-flex items-center gap-1 rounded-md border border-primary/50 bg-primary/10 px-3 py-1.5 font-bold text-primary hover:bg-primary hover:text-primary-foreground"
              >
                <UserPlus className="h-4 w-4" /> Sign Up Free
              </Link>
            </nav>
          )}
          {!hidePublicNav && (
            <Link
              to="/signup"
              search={{ partner: undefined, ref: undefined }}
              className="md:hidden inline-flex items-center gap-1 rounded-md border border-primary/50 bg-primary/10 px-2 py-1.5 text-xs font-bold text-primary"
              aria-label="Sign up free — signup and configuration are free"
            >
              <UserPlus className="h-3.5 w-3.5" /> Sign Up Free
            </Link>
          )}
          {phoneDisplay && (
            <a
              href={`tel:${phoneDigits}`}
              className="hidden sm:inline-flex items-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-bold text-primary-foreground shadow-[var(--shadow-glow)] hover:brightness-110"
            >
              <Phone className="h-4 w-4" /> {phoneDisplay}
            </a>
          )}
        </div>
      </header>

      <main className="flex-1">{children}</main>

      <footer className="mt-16 border-t border-border">
        <div className="mx-auto max-w-5xl px-4 py-8 text-sm text-muted-foreground">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="font-bold text-foreground">{brand.name}</div>
              {brand.licence && <div>{brand.licence}</div>}
            </div>
            {!hidePublicNav && (
              <div className="flex flex-wrap gap-x-4 gap-y-1">
                <Link to="/services/emergency" className="hover:text-foreground">
                  Emergency plumbing
                </Link>
                <Link to="/services/blocked-drains" className="hover:text-foreground">
                  Blocked drains
                </Link>
                <Link to="/areas" className="hover:text-foreground">
                  Service areas
                </Link>
                <Link to="/dashboard" className="hover:text-foreground">
                  Plumber view
                </Link>
                <Link to="/missed-call" className="hover:text-foreground">
                  Demo
                </Link>
              </div>
            )}
          </div>
          {!tenant && (
            <p className="mt-6 text-xs opacity-70">
              Demo site. Job requests here are for demonstration only — no data is sent and no
              plumber will call back.
            </p>
          )}
        </div>
      </footer>

      {showCallBar && phoneDisplay && (
        <a
          href={`tel:${phoneDigits}`}
          className="sm:hidden fixed bottom-4 left-4 right-4 z-50 flex items-center justify-center gap-2 rounded-full bg-primary py-4 text-base font-black text-primary-foreground shadow-[var(--shadow-glow)]"
        >
          <Phone className="h-5 w-5" /> Call now · {phoneDisplay}
        </a>
      )}
    </div>
  );
}
