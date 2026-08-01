import { Link, useLocation, useRouter } from "@tanstack/react-router";
import { CheckCircle2, ChevronRight, LogOut, Menu, Wrench } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useMyTenantBrand } from "@/hooks/use-my-tenant-brand";
import {
  isPlumberNavigationItemActive,
  plumberNavigationItems,
  plumberServiceTool,
  type PlumberNavigationItem,
} from "@/lib/plumber-navigation";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";

type ShellBilling = {
  billingStatus: string;
  effectiveState: string;
  selectedPlan: "missed_call_recovery" | "ai_receptionist" | null;
};

function planName(plan: ShellBilling["selectedPlan"]) {
  if (plan === "ai_receptionist") return "AI Receptionist";
  if (plan === "missed_call_recovery") return "Missed-call recovery";
  return "Plan not selected";
}

function NavLink({ item }: { item: PlumberNavigationItem }) {
  const pathname = useLocation({ select: (location) => location.pathname });
  const active = isPlumberNavigationItemActive(pathname, item);
  const Icon = item.icon;
  return (
    <Link
      to={item.to as never}
      aria-current={active ? "page" : undefined}
      data-active={active || undefined}
      className="group flex min-h-11 items-center gap-3 rounded-lg border border-transparent px-3 py-2.5 text-sm font-bold text-sidebar-foreground/75 outline-none transition hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring data-[active=true]:border-primary/35 data-[active=true]:bg-primary/12 data-[active=true]:text-primary"
    >
      <Icon className="h-4.5 w-4.5 shrink-0" aria-hidden="true" />
      <span className="min-w-0 flex-1">{item.label}</span>
      {active && <ChevronRight className="h-4 w-4" aria-hidden="true" />}
    </Link>
  );
}

function NavigationPanel({
  billing,
  onSignOut,
  closeOnNavigate = false,
}: {
  billing: ShellBilling | null;
  onSignOut: () => void;
  closeOnNavigate?: boolean;
}) {
  const isActive = billing?.effectiveState === "active" || billing?.billingStatus === "active";
  return (
    <div className="flex h-full flex-col">
      <Link
        to="/dashboard"
        className="flex items-center gap-3 rounded-lg p-2 outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring"
        aria-label="Rapid Connect dashboard"
      >
        <span className="grid h-10 w-10 place-items-center rounded-lg bg-primary text-primary-foreground shadow-[var(--shadow-glow)]">
          <Wrench className="h-5 w-5" aria-hidden="true" />
        </span>
        <span>
          <span className="block text-[11px] font-black uppercase tracking-[0.22em] text-primary">
            Rapid Connect
          </span>
          <span className="block text-sm font-black text-sidebar-foreground">
            Plumber workspace
          </span>
        </span>
      </Link>

      <div className="mt-5 rounded-xl border border-sidebar-border bg-background/35 p-3">
        <div className="flex items-center gap-2 text-xs font-black uppercase tracking-wider">
          <span
            className={`h-2.5 w-2.5 rounded-full ${isActive ? "bg-emerald-400" : "bg-amber-400"}`}
          />
          {isActive ? "Subscription active" : "Setup in progress"}
        </div>
        <div className="mt-1 text-xs text-sidebar-foreground/65">
          {billing ? planName(billing.selectedPlan) : "Checking your account…"}
        </div>
      </div>

      <nav className="mt-5 space-y-1" aria-label="Plumber workspace">
        {plumberNavigationItems.map((item) =>
          closeOnNavigate ? (
            <SheetClose asChild key={item.to}>
              <div>
                <NavLink item={item} />
              </div>
            </SheetClose>
          ) : (
            <NavLink item={item} key={item.to} />
          ),
        )}
      </nav>

      <div className="mt-5 border-t border-sidebar-border pt-4">
        <div className="mb-2 px-3 text-[10px] font-black uppercase tracking-[0.2em] text-sidebar-foreground/45">
          Service tools
        </div>
        {closeOnNavigate ? (
          <SheetClose asChild>
            <div>
              <NavLink item={plumberServiceTool} />
            </div>
          </SheetClose>
        ) : (
          <NavLink item={plumberServiceTool} />
        )}
      </div>

      <button
        type="button"
        onClick={onSignOut}
        className="mt-auto flex min-h-11 w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm font-bold text-sidebar-foreground/70 outline-none hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring"
      >
        <LogOut className="h-4.5 w-4.5" aria-hidden="true" /> Log out
      </button>
    </div>
  );
}

export function AuthenticatedAppShell({ children }: { children: ReactNode }) {
  const router = useRouter();
  const tenant = useMyTenantBrand();
  const [billing, setBilling] = useState<ShellBilling | null>(null);

  useEffect(() => {
    let cancelled = false;
    const refreshBilling = () => {
      void supabase.auth.getSession().then(async ({ data }) => {
        const token = data.session?.access_token;
        if (!token) return;
        const response = await fetch("/api/public/billing/summary", {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!response.ok || cancelled) return;
        const payload = (await response.json()) as { billing?: ShellBilling };
        if (!cancelled && payload.billing) setBilling(payload.billing);
      });
    };
    refreshBilling();
    window.addEventListener("rapid-connect:billing-activated", refreshBilling);
    return () => {
      cancelled = true;
      window.removeEventListener("rapid-connect:billing-activated", refreshBilling);
    };
  }, []);

  const signOut = async () => {
    await supabase.auth.signOut();
    await router.navigate({ to: "/auth", search: { next: undefined }, replace: true });
  };

  return (
    <div className="plumber-workspace min-h-screen bg-background text-foreground">
      <a
        href="#workspace-main"
        className="fixed left-3 top-3 z-[70] -translate-y-20 rounded-md bg-primary px-4 py-2 font-bold text-primary-foreground focus:translate-y-0"
      >
        Skip to page content
      </a>

      <aside className="fixed inset-y-0 left-0 z-40 hidden w-72 border-r border-sidebar-border bg-sidebar p-4 lg:block">
        <NavigationPanel billing={billing} onSignOut={() => void signOut()} />
      </aside>

      <header className="sticky top-0 z-30 flex min-h-16 items-center justify-between border-b border-border bg-background/95 px-4 backdrop-blur lg:ml-72 lg:px-8">
        <div className="min-w-0">
          <div className="truncate text-sm font-black">
            {tenant?.name ?? "Your plumbing business"}
          </div>
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            {billing?.billingStatus === "active" && (
              <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" aria-hidden="true" />
            )}
            {billing ? planName(billing.selectedPlan) : "Loading workspace…"}
          </div>
        </div>
        <Sheet>
          <SheetTrigger asChild>
            <button
              type="button"
              className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-border bg-card px-3 text-sm font-black outline-none focus-visible:ring-2 focus-visible:ring-ring lg:hidden"
              aria-label="Open plumber workspace menu"
            >
              <Menu className="h-5 w-5" aria-hidden="true" /> Menu
            </button>
          </SheetTrigger>
          <SheetContent
            side="left"
            className="w-[min(88vw,20rem)] border-sidebar-border bg-sidebar p-4"
          >
            <SheetHeader className="sr-only">
              <SheetTitle>Plumber workspace menu</SheetTitle>
              <SheetDescription>Navigate your Rapid Connect account.</SheetDescription>
            </SheetHeader>
            <NavigationPanel billing={billing} onSignOut={() => void signOut()} closeOnNavigate />
          </SheetContent>
        </Sheet>
      </header>

      <main id="workspace-main" tabIndex={-1} className="min-w-0 lg:ml-72">
        {children}
      </main>
    </div>
  );
}
