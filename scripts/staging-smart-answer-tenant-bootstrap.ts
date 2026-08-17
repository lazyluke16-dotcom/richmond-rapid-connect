// Entry point for the isolated-staging Smart Answer certification tenant
// bootstrap. Intended to be bundled with esbuild (platform=node) and executed
// inside the protected GitHub `staging` environment. Prints only sanitised,
// non-secret evidence.
import { bootstrapSmartAnswerCertificationTenant } from "@/lib/staging-tenant-bootstrap.core";

async function main(): Promise<void> {
  const result = await bootstrapSmartAnswerCertificationTenant();
  // Assistant/business IDs are not secrets; no credential values are emitted.
  console.log(JSON.stringify({ ...result, valuesPrinted: false }, null, 2));
}

main().catch((error) => {
  console.error(
    "staging tenant bootstrap failed:",
    error && error.message ? error.message : String(error),
  );
  process.exit(1);
});
