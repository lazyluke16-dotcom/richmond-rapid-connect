import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "..");

function sha256(path) {
  const normalizedText = readFileSync(path, "utf8").replace(/\r\n?/g, "\n");
  return createHash("sha256").update(normalizedText, "utf8").digest("hex");
}

export function verifyMigrationManifest(root = repositoryRoot) {
  const manifestPath = join(root, "supabase", "migration-manifest.json");
  const migrationsDirectory = join(root, "supabase", "migrations");
  const pendingDirectory = join(root, "supabase", "migrations-pending");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const entries = manifest.migrations;
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error("Migration manifest has no ordered entries");
  }

  const actualFiles = readdirSync(migrationsDirectory)
    .filter((file) => file.endsWith(".sql"))
    .sort();
  const manifestFiles = entries.map((entry) => entry.file);
  if (JSON.stringify(actualFiles) !== JSON.stringify(manifestFiles)) {
    throw new Error("Migration manifest does not exactly match the committed SQL migration set");
  }
  if (new Set(manifestFiles).size !== manifestFiles.length) {
    throw new Error("Migration manifest contains duplicate filenames");
  }

  const seen = new Set();
  let previousTimestamp = "";
  for (const entry of entries) {
    if (!/^\d{14}_[A-Za-z0-9_-]+\.sql$/.test(entry.file)) {
      throw new Error(`Invalid migration filename: ${entry.file}`);
    }
    const timestamp = entry.file.slice(0, 14);
    if (timestamp <= previousTimestamp) {
      throw new Error(`Migration timestamps are not strictly ordered at ${entry.file}`);
    }
    previousTimestamp = timestamp;
    for (const dependency of entry.dependsOn ?? []) {
      if (!seen.has(dependency)) {
        throw new Error(`${entry.file} has a missing or later dependency: ${dependency}`);
      }
    }
    const actualHash = sha256(join(migrationsDirectory, entry.file));
    if (actualHash !== entry.sha256) {
      throw new Error(
        `Migration hash mismatch: ${entry.file} (manifest ${entry.sha256}, actual ${actualHash})`,
      );
    }
    seen.add(entry.file);
  }

  const pendingFiles = existsSync(pendingDirectory)
    ? readdirSync(pendingDirectory).filter((file) => file.endsWith(".sql"))
    : [];
  if (manifest.policy.pendingDirectoryMustBeEmpty && pendingFiles.length > 0) {
    throw new Error(`Pending SQL migrations remain: ${pendingFiles.join(", ")}`);
  }

  const dispositions = manifest.pendingArtifactDispositions ?? [];
  const dispositionFiles = new Set(dispositions.map((entry) => entry.file));
  for (const required of [
    "20260722100000_phase2g1_onboarding_step.sql",
    "20260722200000_phase1_coverage_and_licence.sql",
    "20260725160000_customer_call_handling.sql",
    "20260726120000_text_link_dispatch_hardening.sql",
    "20260727120000_text_link_sms_billable.sql",
  ]) {
    if (!dispositionFiles.has(required)) {
      throw new Error(`Missing pending-artifact disposition: ${required}`);
    }
  }

  return {
    migrationCount: entries.length,
    first: entries[0].file,
    last: entries.at(-1).file,
    pendingSqlCount: pendingFiles.length,
    manifestSha256: sha256(manifestPath),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.stdout.write(`${JSON.stringify(verifyMigrationManifest())}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
