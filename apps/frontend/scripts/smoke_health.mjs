#!/usr/bin/env node

const baseUrl = (
  process.argv[2] ||
  process.env.APP_BASE_URL ||
  "http://127.0.0.1:3000"
).replace(/\/+$/, "");

const checks = [
  { path: "/api/health/live", requiredStatus: "healthy" },
  { path: "/api/health/ready", rejectStatus: "unhealthy" },
  { path: "/api/health", rejectStatus: "unhealthy" },
];

async function readHealth(path) {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: {
      "x-correlation-id": `smoke-${Date.now()}`,
    },
  });
  const body = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(`${path} returned HTTP ${response.status}`);
  }

  if (!body || typeof body !== "object" || typeof body.status !== "string") {
    throw new Error(`${path} did not return a health model`);
  }

  return body;
}

for (const check of checks) {
  const body = await readHealth(check.path);

  if (check.requiredStatus && body.status !== check.requiredStatus) {
    throw new Error(
      `${check.path} expected ${check.requiredStatus}, received ${body.status}`,
    );
  }

  if (check.rejectStatus && body.status === check.rejectStatus) {
    throw new Error(`${check.path} reported ${body.status}`);
  }

  console.info(
    JSON.stringify({
      event: "smoke_health",
      path: check.path,
      status: body.status,
    }),
  );
}
