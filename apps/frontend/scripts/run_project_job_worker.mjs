#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

const port = process.env.PORT || "3000";
const token = process.env.PROJECT_JOB_WORKER_TOKEN || "";
const configuredLimit = Number(process.env.PROJECT_JOB_WORKER_LIMIT || "1");
const limit = 1;
const healthUrl = `http://127.0.0.1:${port}/api/health/ready`;
const workerUrl = `http://127.0.0.1:${port}/api/project-jobs/worker`;

if (!token && process.env.NODE_ENV === "production") {
  console.error("PROJECT_JOB_WORKER_TOKEN must be set in production.");
  process.exit(1);
}

if (configuredLimit !== limit) {
  console.error("PROJECT_JOB_WORKER_LIMIT must be 1.");
  process.exit(1);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stopServer(server) {
  if (server.killed) {
    return;
  }

  server.kill("SIGTERM");
  setTimeout(() => {
    if (!server.killed) {
      server.kill("SIGKILL");
    }
  }, 5_000).unref();
}

const serverArgs = existsSync("server.js")
  ? ["server.js"]
  : ["node_modules/next/dist/bin/next", "start"];

const server = spawn("node", serverArgs, {
  env: {
    ...process.env,
    HOSTNAME: process.env.HOSTNAME || "0.0.0.0",
    PORT: port,
  },
  stdio: ["ignore", "pipe", "pipe"],
});

server.stdout.on("data", (chunk) => process.stdout.write(chunk));
server.stderr.on("data", (chunk) => process.stderr.write(chunk));

try {
  const deadline = Date.now() + 120_000;
  let ready = false;
  while (Date.now() < deadline) {
    const response = await fetch(healthUrl).catch(() => null);
    if (response?.ok) {
      ready = true;
      break;
    }
    await sleep(2_000);
  }

  if (!ready) {
    throw new Error("Next server did not become ready before worker timeout.");
  }

  const response = await fetch(workerUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { "x-worker-token": token } : {}),
    },
    body: JSON.stringify({ limit }),
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`Worker request failed with ${response.status}: ${body}`);
  }

  console.info(body);
} finally {
  stopServer(server);
}
