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
import { createSupabaseMissionStore } from "./mission-supabase-store";
import { ProviderRegistry } from "./provider";
import type { EngineDeps } from "./mission-engine";

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
