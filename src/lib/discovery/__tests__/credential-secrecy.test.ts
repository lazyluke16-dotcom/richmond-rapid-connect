/**
 * The Google Places credential must stay server-side: it must never be read by a client
 * component and must never travel through a client-imported module. These static checks fail
 * the build if the key name leaks into the operator UI or its import graph.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const UI = "src/routes/_authenticated/acquisition.discovery.tsx";
const ENGINE_CONTEXT = "src/lib/discovery/engine-context.ts";
const PROVIDER = "src/lib/discovery/google-places-provider.ts";

describe("Google Places credential secrecy", () => {
  it("the operator UI never references the API key and never imports server-only provider modules", () => {
    const ui = readFileSync(UI, "utf8");
    expect(ui).not.toContain("GOOGLE_PLACES_API_KEY");
    expect(ui).not.toContain("google-places-provider");
    expect(ui).not.toContain("engine-context");
    // The UI must not read process.env at all (client bundle).
    expect(ui).not.toMatch(/process\.env/);
  });

  it("the raw key env var is only read in the server-side engine-context module", () => {
    // engine-context is imported only by server route handlers, never by a client component.
    const engineCtx = readFileSync(ENGINE_CONTEXT, "utf8");
    expect(engineCtx).toContain("process.env.GOOGLE_PLACES_API_KEY");
    // The provider takes the key as a constructor argument; it does not read env itself.
    const provider = readFileSync(PROVIDER, "utf8");
    expect(provider).not.toContain("process.env");
  });

  it("the provider never logs or embeds the key in error messages by construction", () => {
    const provider = readFileSync(PROVIDER, "utf8");
    // No console.* logging in the provider.
    expect(provider).not.toMatch(/console\.(log|info|warn|error)/);
    // Error messages are static strings (never interpolate the key).
    expect(provider).not.toMatch(/DiscoveryProviderError\([^)]*apiKey/);
  });
});
