// Entry point for the isolated-staging Smart Answer certification PHONE
// provisioning (purchase/reuse one AU mobile Voice number in the staging Twilio
// subaccount + allocate to the certification tenant). Bundled with esbuild and
// run inside the protected GitHub `staging` environment. Prints only sanitised
// evidence (phone numbers/SIDs are the staging platform's own resources; no
// auth tokens are emitted).
import { provisionStagingCertificationPhone } from "@/lib/staging-phone-provisioning.core";

async function main(): Promise<void> {
  const result = await provisionStagingCertificationPhone();
  console.log(JSON.stringify({ ...result, valuesPrinted: false }, null, 2));
}

main().catch((error) => {
  console.error(
    "staging phone provisioning failed:",
    error && error.message ? error.message : String(error),
  );
  process.exit(1);
});
