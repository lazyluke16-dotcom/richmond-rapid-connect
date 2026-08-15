/**
 * Server-only loader for the private personalised demo page.
 *
 * Resolves a demo by unlisted slug + unguessable token via {@link DemoAccessService} and
 * returns only what the public demo page needs to render: the safe display config +
 * resolved colours. It never returns the token hash, other prospects' data, or evidence
 * internals. Fails closed: an invalid/revoked/expired demo returns `{ ok: false }`.
 */
import { createServerFn } from "@tanstack/react-start";
import { resolvedColours } from "./brand";
import { DemoAccessService } from "./demo-access";
import { createSupabaseProspectStore } from "./supabase-store";
import type { DemoConfig } from "./types";

export interface DemoViewData {
  businessName: string;
  greeting: string;
  verifiedServices: string[];
  verifiedServiceAreas: string[];
  openingHours: string;
  emergencyService: "yes" | "no" | "UNKNOWN";
  publicPhone: string;
  exampleEnquiries: string[];
  unknowns: string[];
  disclosure: string;
  logoUrl: string | null;
  faviconUrl: string | null;
  colours: { primary: string; secondary: string; accent: string };
  provenance: DemoConfig["provenance"];
}

function toViewData(config: DemoConfig): DemoViewData {
  return {
    businessName: config.businessName,
    greeting: config.greeting,
    verifiedServices: config.verifiedServices,
    verifiedServiceAreas: config.verifiedServiceAreas,
    openingHours: config.openingHours,
    emergencyService: config.emergencyService,
    publicPhone: config.publicPhone,
    exampleEnquiries: config.exampleEnquiries,
    unknowns: config.unknowns,
    disclosure: config.disclosure,
    logoUrl: config.branding.logoUrl,
    faviconUrl: config.branding.faviconUrl,
    colours: resolvedColours(config.branding),
    provenance: config.provenance,
  };
}

export const loadDemoView = createServerFn({ method: "GET" })
  .inputValidator((data: { slug: string; token: string }) => data)
  .handler(async ({ data }): Promise<{ ok: true; view: DemoViewData } | { ok: false }> => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const store = createSupabaseProspectStore(supabaseAdmin);
    const access = new DemoAccessService(store);
    const resolved = await access.resolve(data.slug, data.token);
    if (!resolved.ok) return { ok: false };
    return { ok: true, view: toViewData(resolved.config) };
  });
