#!/usr/bin/env node
// DOCLING_CLI_COMMAND for the owned local stack. It runs the application's real
// arguments in the offline parser container and streams files through
// `docker exec`, so no host path is shared with that container. A marker file
// makes conversions fail as the CLI itself would: the enhancement harness uses
// it to inject a failure without touching application code.
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const container = process.env.ANBUD_SYSTEM_TEST_DOCLING_CONTAINER;
const marker = process.env.ANBUD_SYSTEM_TEST_DOCLING_FAILURE_MARKER;
if (!container?.startsWith("anbud-system-test-") || !marker) {
  process.stderr.write("This command only runs inside the owned system-test stack.\n");
  process.exit(64);
}
if (existsSync(marker)) {
  process.stderr.write("Injected Docling failure from the owned system-test harness.\n");
  process.exit(75);
}

const args = process.argv.slice(2);
const outputIndex = args.indexOf("--output") + 1;
const hostOutput = args[outputIndex];
const hostInput = args.at(-1);
const workspace = `/tmp/anbud-docling-${randomUUID()}`;
const insideInput = `${workspace}/input/${path.basename(hostInput)}`;
const docker = (dockerArguments, options = {}) => spawnSync("docker", ["exec", ...dockerArguments], { maxBuffer: 256 * 1024 * 1024, ...options });

function required(result, stage) {
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.stderr.write(`Parser container ${stage} failed.\n${result.stderr ?? ""}`);
    process.exit(result.status ?? 1);
  }
}

try {
  required(docker([container, "mkdir", "-p", `${workspace}/input`, `${workspace}/output`]), "setup");
  required(docker(["-i", container, "sh", "-c", 'cat > "$1"', "sh", insideInput], { input: readFileSync(hostInput) }), "input transfer");
  args[outputIndex] = `${workspace}/output`;
  args[args.length - 1] = insideInput;
  const conversion = docker(["--env", "HOME=/home/node", container, "/opt/docling/bin/docling", ...args], { stdio: ["ignore", "inherit", "inherit"] });
  if (conversion.error) throw conversion.error;
  if (conversion.status !== 0) process.exitCode = conversion.status ?? 1;
  else {
    const archive = docker([container, "tar", "-C", `${workspace}/output`, "-cf", "-", "."]);
    required(archive, "output transfer");
    const unpacked = spawnSync("tar", ["-xf", "-", "-C", hostOutput], { input: archive.stdout });
    if (unpacked.error) throw unpacked.error;
    if (unpacked.status !== 0) { process.stderr.write("Could not unpack parser output.\n"); process.exitCode = 1; }
  }
} finally {
  docker([container, "rm", "-rf", workspace]);
}
