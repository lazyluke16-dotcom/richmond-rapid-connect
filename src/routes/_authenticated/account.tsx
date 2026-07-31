import { createFileRoute } from "@tanstack/react-router";
import { BillingAccountPage } from "./billing";

export const Route = createFileRoute("/_authenticated/account")({
  head: () => ({ meta: [{ title: "Account centre — Rapid Connect" }] }),
  component: BillingAccountPage,
});
