// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - TanStack devtools (dev-only, first), tanstackStart, viteReact, tailwindcss, tsConfigPaths,
//     nitro (build-only using cloudflare as a default target), VITE_* env injection, @ path alias,
//     React/TanStack dedupe, error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... }, etc... }) if needed.
import { defineConfig } from "@lovable.dev/vite-tanstack-config";
import { mcpPlugin } from "@lovable.dev/mcp-js/stacks/tanstack/vite";

// @lovable.dev/mcp-js 0.24.0 compares mixed slash styles on Windows linked
// worktrees and aborts before Vite can build. Lovable/Linux builds keep the
// plugin; local Windows verification can skip only its route-generation step
// because the generated MCP route files are already committed.
const localWindowsMcpWorkaround = process.env.LOCAL_BUILD_DISABLE_MCP_PLUGIN === "1";

export default defineConfig({
  tanstackStart: {
    // Redirect TanStack Start's bundled server entry to src/server.ts (our SSR error wrapper).
    // nitro/vite builds from this
    server: { entry: "server" },
  },
  vite: {
    plugins: localWindowsMcpWorkaround ? [] : [mcpPlugin()],
  },
});
