import {
  Bot,
  ChartNoAxesCombined,
  CircleHelp,
  ClipboardList,
  CreditCard,
  LayoutDashboard,
  MessageSquareText,
  PhoneCall,
  Settings,
  type LucideIcon,
} from "lucide-react";

export type PlumberNavigationItem = {
  label: string;
  to: string;
  icon: LucideIcon;
  matches: string[];
};

export const plumberNavigationItems: PlumberNavigationItem[] = [
  { label: "Home", to: "/dashboard", icon: LayoutDashboard, matches: ["/dashboard"] },
  { label: "Missed jobs", to: "/leads", icon: ClipboardList, matches: ["/leads"] },
  {
    label: "Call handling",
    to: "/call-handling",
    icon: PhoneCall,
    matches: ["/call-handling"],
  },
  {
    label: "AI Receptionist",
    to: "/ai-receptionist",
    icon: Bot,
    matches: ["/ai-receptionist"],
  },
  {
    label: "Account & Billing",
    to: "/billing",
    icon: CreditCard,
    matches: ["/billing", "/account"],
  },
  {
    label: "Usage and costs",
    to: "/usage",
    icon: ChartNoAxesCombined,
    matches: ["/usage"],
  },
  {
    label: "Business profile",
    to: "/settings",
    icon: Settings,
    matches: ["/settings"],
  },
  {
    label: "Help & setup guide",
    to: "/setup-guide",
    icon: CircleHelp,
    matches: ["/setup-guide", "/onboarding"],
  },
];

export const plumberServiceTool: PlumberNavigationItem = {
  label: "Missed-call texts",
  to: "/missed-call-settings",
  icon: MessageSquareText,
  matches: ["/missed-call-settings"],
};

export function isPlumberNavigationItemActive(pathname: string, item: PlumberNavigationItem) {
  return item.matches.some(
    (match) => pathname === match || (match !== "/dashboard" && pathname.startsWith(`${match}/`)),
  );
}
