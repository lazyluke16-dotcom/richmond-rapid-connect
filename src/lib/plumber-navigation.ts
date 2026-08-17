import {
  CircleHelp,
  ClipboardList,
  CreditCard,
  LayoutDashboard,
  PhoneCall,
  ShieldCheck,
  type LucideIcon,
} from "lucide-react";

export type PlumberNavigationItem = {
  label: string;
  to: string;
  icon: LucideIcon;
  matches: string[];
};

export const plumberNavigationItems: PlumberNavigationItem[] = [
  { label: "Dashboard", to: "/dashboard", icon: LayoutDashboard, matches: ["/dashboard"] },
  { label: "Missed Jobs", to: "/leads", icon: ClipboardList, matches: ["/leads"] },
  {
    label: "Services",
    to: "/call-handling",
    icon: PhoneCall,
    matches: ["/call-handling", "/ai-receptionist", "/missed-call-settings"],
  },
  {
    label: "Smart Answer",
    to: "/smart-answer",
    icon: ShieldCheck,
    matches: ["/smart-answer"],
  },
  {
    label: "Account & Billing",
    to: "/billing",
    icon: CreditCard,
    matches: ["/billing", "/account", "/usage", "/settings"],
  },
  {
    label: "Help / Setup",
    to: "/setup-guide",
    icon: CircleHelp,
    matches: ["/setup-guide", "/onboarding"],
  },
];

export function isPlumberNavigationItemActive(pathname: string, item: PlumberNavigationItem) {
  return item.matches.some(
    (match) => pathname === match || (match !== "/dashboard" && pathname.startsWith(`${match}/`)),
  );
}
