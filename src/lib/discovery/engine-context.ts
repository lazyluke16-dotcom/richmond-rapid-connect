/**
 * Builds a discovery {@link EngineDeps} from a service-role Supabase client.
 *
 * For a mission that runs, the import provider is wired from the mission's operator-supplied
 * seed. Lifecycle-only actions (start/pause/cancel) don't need a provider, so the registry
 * may be left empty. No live provider is registered — live discovery is an external
 * dependency (see docs/AUTONOMOUS_DISCOVERY_V1.md).
 */
import { createSupabaseProspectStore } from "../prospect/supabase-store";
import { FixtureDiscoveryProvider } from "./fixture-provider";
import { GooglePlacesProvider } from "./google-places-provider";
import { createSupabaseMissionStore } from "./mission-supabase-store";
import { ProviderRegistry } from "./provider";
import type { EngineDeps } from "./mission-engine";

/** Whether the live Google Places provider is configured (server-side key present). */
export function googlePlacesConfigured(): boolean {
  return Boolean(process.env.GOOGLE_PLACES_API_KEY?.trim());
}

export interface EngineContextOptions {
  missionId?: string;
  baseUrl?: string;
  pageSize?: number;
  demoTtlDays?: number;
  /** Wire the import provider from the mission seed (needed only when advancing). */
  withProvider?: boolean;
}

export async function buildEngineDeps(
  client: unknown,
  options: EngineContextOptions = {},
): Promise<EngineDeps> {
  const pageSize = options.pageSize ?? 25;
  const missionStore = createSupabaseMissionStore(client);
  const prospectStore = createSupabaseProspectStore(client);
  const registry = new ProviderRegistry();

  if (options.withProvider && options.missionId) {
    const seed = await missionStore.getImportSeed(options.missionId);
    registry.register(new FixtureDiscoveryProvider({ name: "import", candidates: seed, pageSize }));

    // Register the live Google Places provider only when a server-side key is configured.
    // The key stays server-side (this module is only imported by server route handlers) and
    // is never returned to the client. Fail closed if it is absent — a google_places mission
    // then errors clearly rather than silently doing nothing.
    const apiKey = process.env.GOOGLE_PLACES_API_KEY?.trim();
    if (apiKey) {
      registry.register(
        new GooglePlacesProvider({
          apiKey,
          perRequestCostCents: Number(process.env.GOOGLE_PLACES_PER_REQUEST_CENTS) || 4,
          regionCode: process.env.GOOGLE_PLACES_REGION_CODE || "AU",
          pageSize: Math.min(20, pageSize),
        }),
      );
    }
  }

  return {
    missionStore,
    prospectStore,
    registry,
    baseUrl: options.baseUrl,
    demoTtlDays: options.demoTtlDays,
    pageSize,
  };
}
