#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

// Uses explicitly supplied environment variables, never implicitly loads a
// production .env file. Default mode reads/counts only; --apply rewrites results.
const args = process.argv.slice(2);
if (args.some((arg) => arg !== "--apply" && arg !== "--help")) {
  throw new Error("Usage: node scripts/clean_historical_job_results.mjs [--apply]");
}
if (args.includes("--help")) {
  console.log("Dry run by default. Set DATA_API_URL, DATA_API_SERVICE_ROLE_KEY and APP_ENCRYPTION_KEY explicitly for the intended environment. Add --apply to remove document details from historical terminal job results. Only aggregate counts are printed.");
} else {
  for (const key of ["DATA_API_URL", "DATA_API_SERVICE_ROLE_KEY", "APP_ENCRYPTION_KEY"]) {
    if (!process.env[key]?.trim()) throw new Error(`${key} is required.`);
  }
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const jiti = createJiti(import.meta.url, { alias: { "@": root, "server-only": "/dev/null" } });
  const { cleanHistoricalProjectJobResults } = jiti(path.join(root, "lib/server/project-job-result-cleanup.ts"));
  try {
    console.log(JSON.stringify({ mode: args.includes("--apply") ? "apply" : "dry-run", ...await cleanHistoricalProjectJobResults({ apply: args.includes("--apply") }) }));
  } catch {
    console.error("Job result cleanup failed; inspect configuration and retry. No source content is logged.");
    process.exitCode = 1;
  }
}
