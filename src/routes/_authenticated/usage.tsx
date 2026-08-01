import { createFileRoute } from "@tanstack/react-router";
import { BillingAccountPage } from "./billing";

export const Route = createFileRoute("/_authenticated/usage")({
  head: () => ({ meta: [{ title: "Usage and costs — Rapid Connect" }] }),
  component: () => <BillingAccountPage initialSection="usage" />,
});
