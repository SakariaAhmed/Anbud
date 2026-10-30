#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import http from "node:http";

// Measured from process start, which is the replica start in the scheduled job.
const processStartedAt = Date.now() - Math.round(process.uptime() * 1000);
const shutdownAllowanceMs = 60_000;
const maximumJobs = 10;

const port = process.env.PORT || "3000";
const token = process.env.PROJECT_JOB_WORKER_TOKEN || "";
// Worker images before the replica budget read only PROJECT_JOB_WORKER_LIMIT
// and exit unless it is 1. Rollback restores just the image, so that variable
// stays 1 and the job count has its own variable that older images ignore.
const legacyLimit = Number(process.env.PROJECT_JOB_WORKER_LIMIT || "1");
const maxJobs = Number(process.env.PROJECT_JOB_WORKER_MAX_JOBS || "1");
const replicaTimeoutSeconds = Number(
  process.env.PROJECT_JOB_WORKER_REPLICA_TIMEOUT_SECONDS || "2100",
);
const deadlineAt = processStartedAt + replicaTimeoutSeconds * 1000 - shutdownAllowanceMs;
const healthUrl = `http://127.0.0.1:${port}/api/health/live`;

if (!token && process.env.NODE_ENV === "production") {
  console.error("PROJECT_JOB_WORKER_TOKEN must be set in production.");
  process.exit(1);
}

if (legacyLimit !== 1) {
  console.error("PROJECT_JOB_WORKER_LIMIT must be 1.");
  process.exit(1);
}

if (!Number.isSafeInteger(maxJobs) || maxJobs < 1 || maxJobs > maximumJobs) {
  console.error(`PROJECT_JOB_WORKER_MAX_JOBS must be an integer from 1 to ${maximumJobs}.`);
  process.exit(1);
}

if (!Number.isSafeInteger(replicaTimeoutSeconds) || replicaTimeoutSeconds < 60) {
  console.error("PROJECT_JOB_WORKER_REPLICA_TIMEOUT_SECONDS must be an integer of at least 60.");
  process.exit(1);
}

/**
 * The worker route answers only after its last job. Global fetch would give up
 * after undici's default 300-second headers timeout and the finally block would
 * then stop the server mid-job, so wait on a plain request until the replica
 * deadline instead.
 */
function postWorkerRequest(body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: "127.0.0.1",
      port,
      path: "/api/project-jobs/worker",
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { "x-worker-token": token } : {}),
      },
      signal: AbortSignal.timeout(Math.max(1_000, timeoutMs)),
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("error", reject);
      response.on("end", () => resolve({
        status: response.statusCode ?? 0,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    request.on("error", reject);
    request.end(JSON.stringify(body));
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function serverHasExited(server) {
  // `killed` only records that a signal was sent, not that the process exited.
  return server.exitCode !== null || server.signalCode !== null;
}

function stopServer(server) {
  if (serverHasExited(server)) {
    return;
  }

  server.kill("SIGTERM");
  setTimeout(() => {
    if (!serverHasExited(server)) {
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
    // Keeps finished jobs from handing the next queued job to this server's
    // in-memory autorun queue, which ends with this process.
    PROJECT_JOB_WORKER_PROCESS: "1",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

server.stdout.on("data", (chunk) => process.stdout.write(chunk));
server.stderr.on("data", (chunk) => process.stderr.write(chunk));

// The replica is stopped with SIGTERM; pass it on so the server stops too
// instead of being left behind when this process exits.
let stopSignal = null;
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.once(signal, () => {
    stopSignal = signal;
    stopServer(server);
    const exit = () => process.exit(signal === "SIGTERM" ? 143 : 130);
    if (serverHasExited(server)) exit();
    server.once("exit", exit);
    setTimeout(exit, 6_000).unref();
  });
}

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

  const response = await postWorkerRequest(
    { limit: maxJobs, deadline_at: deadlineAt },
    deadlineAt + shutdownAllowanceMs / 2 - Date.now(),
  );
  const body = response.body;
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Worker request failed with ${response.status}: ${body}`);
  }

  console.info(body);
} catch (error) {
  // Stopping the server ends the pending request; the signal handler owns
  // the exit once the server is gone.
  if (stopSignal) await new Promise(() => {});
  throw error;
} finally {
  stopServer(server);
}
