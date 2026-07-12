#!/usr/bin/env node

import { execFile, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../../..");

const DEFAULT_SIZE_BUDGETS = {
  "runner-lite": 550_000_000,
  "runner-docling": 5_200_000_000,
};

function readArgs(argv) {
  const options = {
    buildTimeoutMs: 15 * 60 * 1000,
    context: ".",
    dockerfile: "apps/frontend/Dockerfile",
    envFile: "",
    fullHealth: false,
    healthTimeoutMs: 2 * 60 * 1000,
    keepImage: false,
    maxBytes: null,
    target: process.env.DOCKER_SMOKE_TARGET || "runner-lite",
    tag: "",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) {
        throw new Error(`${arg} requires a value.`);
      }
      return argv[index];
    };

    if (arg === "--build-timeout-ms") options.buildTimeoutMs = Number(next());
    else if (arg === "--context") options.context = next();
    else if (arg === "--file") options.dockerfile = next();
    else if (arg === "--env-file") options.envFile = next();
    else if (arg === "--full-health") options.fullHealth = true;
    else if (arg === "--health-timeout-ms") options.healthTimeoutMs = Number(next());
    else if (arg === "--keep-image") options.keepImage = true;
    else if (arg === "--max-bytes") options.maxBytes = Number(next());
    else if (arg === "--target") options.target = next();
    else if (arg === "--tag") options.tag = next();
    else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!Number.isFinite(options.buildTimeoutMs) || options.buildTimeoutMs <= 0) {
    throw new Error("--build-timeout-ms must be a positive number.");
  }
  if (!Number.isFinite(options.healthTimeoutMs) || options.healthTimeoutMs <= 0) {
    throw new Error("--health-timeout-ms must be a positive number.");
  }
  if (options.maxBytes !== null && (!Number.isFinite(options.maxBytes) || options.maxBytes <= 0)) {
    throw new Error("--max-bytes must be a positive number.");
  }

  options.maxBytes ??= DEFAULT_SIZE_BUDGETS[options.target] ?? 1_000_000_000;
  options.tag ||= `anbud-frontend-smoke:${options.target}-${process.pid}`;

  return options;
}

function runStreaming(command, args, { timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      env: {
        ...process.env,
        DOCKER_BUILDKIT: "1",
      },
      stdio: "inherit",
    });

    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`${command} ${args.join(" ")} timed out after ${timeoutMs}ms.`));
    }, timeoutMs);

    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });

    child.on("exit", (code, signal) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `${command} ${args.join(" ")} failed with ${signal ? `signal ${signal}` : `exit ${code}`}.`,
        ),
      );
    });
  });
}

function runCapture(command, args, { timeoutMs = 30_000, allowFailure = false } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        cwd: repoRoot,
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error && !allowFailure) {
          reject(
            new Error(
              `${command} ${args.join(" ")} failed: ${stderr.trim() || error.message}`,
            ),
          );
          return;
        }
        resolve({ stdout, stderr, error });
      },
    );
  });
}

async function readImageSize(tag) {
  const { stdout } = await runCapture("docker", [
    "image",
    "inspect",
    tag,
    "--format",
    "{{.Size}}",
  ]);
  const size = Number(stdout.trim());
  if (!Number.isFinite(size) || size <= 0) {
    throw new Error(`Could not read Docker image size for ${tag}.`);
  }
  return size;
}

async function mappedBaseUrl(containerName) {
  const { stdout } = await runCapture("docker", ["port", containerName, "3000/tcp"]);
  const mapping = stdout.trim().split(/\s+/).at(-1);
  if (!mapping) {
    throw new Error(`Could not read mapped port for ${containerName}.`);
  }
  const port = mapping.split(":").at(-1);
  return `http://127.0.0.1:${port}`;
}

async function fetchJson(url, timeoutMs = 2_000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, { signal: controller.signal });
    const body = await response.json().catch(() => null);
    return { body, ok: response.ok, status: response.status };
  } finally {
    clearTimeout(timeout);
  }
}

async function waitForLiveHealth(baseUrl, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "";

  while (Date.now() < deadline) {
    try {
      const result = await fetchJson(`${baseUrl}/api/health/live`);
      if (result.ok && result.body?.status === "healthy") {
        return result.body;
      }
      lastError = `HTTP ${result.status} ${JSON.stringify(result.body)}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }

  throw new Error(`Timed out waiting for /api/health/live: ${lastError}`);
}

async function waitForDockerHealth(containerName, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = "unknown";

  while (Date.now() < deadline) {
    const { stdout } = await runCapture(
      "docker",
      ["inspect", "--format", "{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}", containerName],
      { allowFailure: true },
    );
    lastStatus = stdout.trim() || "unknown";

    if (lastStatus === "healthy" || lastStatus === "none") {
      return lastStatus;
    }
    if (lastStatus === "unhealthy") {
      throw new Error(`${containerName} reported Docker health status unhealthy.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }

  throw new Error(`Timed out waiting for Docker health status: ${lastStatus}`);
}

async function dockerLogs(containerName) {
  const { stdout, stderr } = await runCapture(
    "docker",
    ["logs", "--tail", "200", containerName],
    { allowFailure: true },
  );
  const output = `${stdout}${stderr}`.trim();
  if (output) {
    console.error(output);
  }
}

async function main() {
  const options = readArgs(process.argv.slice(2));
  const containerName = `anbud-frontend-smoke-${process.pid}`;
  let containerStarted = false;

  try {
    await runStreaming(
      "docker",
      [
        "build",
        "--target",
        options.target,
        "--file",
        options.dockerfile,
        "--tag",
        options.tag,
        options.context,
      ],
      { timeoutMs: options.buildTimeoutMs },
    );

    const imageSize = await readImageSize(options.tag);
    console.info(
      JSON.stringify({
        event: "docker_image_size",
        image: options.tag,
        target: options.target,
        size_bytes: imageSize,
        max_bytes: options.maxBytes,
      }),
    );

    if (imageSize > options.maxBytes) {
      throw new Error(
        `${options.tag} is ${imageSize} bytes, above budget ${options.maxBytes}.`,
      );
    }

    const runArgs = [
      "run",
      "--rm",
      "--detach",
      "--name",
      containerName,
      "--publish",
      "127.0.0.1::3000",
      "--env",
      "NODE_ENV=production",
      "--env",
      `APP_VERSION=${options.tag}`,
    ];

    if (options.envFile) {
      runArgs.push("--env-file", options.envFile);
    }

    runArgs.push(options.tag);
    await runCapture("docker", runArgs);
    containerStarted = true;

    const baseUrl = await mappedBaseUrl(containerName);
    const liveModel = await waitForLiveHealth(baseUrl, options.healthTimeoutMs);
    const dockerHealth = await waitForDockerHealth(containerName, options.healthTimeoutMs);

    console.info(
      JSON.stringify({
        event: "docker_smoke_health",
        base_url: baseUrl,
        docker_health: dockerHealth,
        live_status: liveModel.status,
      }),
    );

    if (options.fullHealth) {
      await runStreaming(
        process.execPath,
        ["apps/frontend/scripts/smoke_health.mjs", baseUrl],
        { timeoutMs: options.healthTimeoutMs },
      );
    }
  } catch (error) {
    if (containerStarted) {
      await dockerLogs(containerName);
    }
    throw error;
  } finally {
    if (containerStarted) {
      await runCapture("docker", ["rm", "--force", containerName], {
        allowFailure: true,
      });
    }
    if (!options.keepImage) {
      await runCapture("docker", ["image", "rm", options.tag], {
        allowFailure: true,
      });
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
