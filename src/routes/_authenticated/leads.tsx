import { createFileRoute } from "@tanstack/react-router";
import { DashboardWorkspace } from "./dashboard";

export const Route = createFileRoute("/_authenticated/leads")({
  head: () => ({ meta: [{ title: "Missed jobs — Rapid Connect" }] }),
  component: () => <DashboardWorkspace />,
});
