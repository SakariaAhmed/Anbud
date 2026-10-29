#!/usr/bin/env node
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const frontendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = path.resolve(frontendRoot, "../..");

function discover(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return discover(file);
    }
    return entry.isFile() && /\.test\.(?:mjs|cjs|js)$/.test(entry.name) ? [file] : [];
  }).sort();
}

export function discoverTestGroups() {
  // tests/audit-20260905 owns its disposable database and runs through its
  // own run.mjs in CI, so it lives outside these discovered directories.
  return {
    frontend: ["app", "components", "lib", "scripts"].flatMap((directory) =>
      discover(path.join(frontendRoot, directory))),
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
