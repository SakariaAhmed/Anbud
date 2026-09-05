#!/usr/bin/env node
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const frontendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = path.resolve(frontendRoot, "../..");

function discover(directory, excludedDirectories = new Set()) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return excludedDirectories.has(file) ? [] : discover(file, excludedDirectories);
    }
    return entry.isFile() && /\.test\.(?:mjs|cjs|js)$/.test(entry.name) ? [file] : [];
  }).sort();
}

export function discoverTestGroups() {
  // This suite owns its disposable database and must run through run.mjs in CI.
  // Loading it via ordinary discovery fails before that database can be set up.
  const excluded = new Set([path.join(frontendRoot, "lib/server/audit-20260905")]);
  return {
    frontend: ["app", "components", "lib", "scripts"].flatMap((directory) =>
      discover(path.join(frontendRoot, directory), excluded)),
    repository: discover(path.join(repositoryRoot, "scripts")),
  };
}

function run(args, cwd) {
  const result = spawnSync(process.execPath, args, { cwd, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const groups = discoverTestGroups();
  if (process.argv.includes("--list")) {
    console.log(JSON.stringify(groups, null, 2));
  } else {
    run(["--test", ...groups.frontend], frontendRoot);
    run(["--test", ...groups.repository], repositoryRoot);
    run([path.join(repositoryRoot, "scripts/run_requirement_parser_golden.mjs")], repositoryRoot);
  }
}
