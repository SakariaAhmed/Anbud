#!/usr/bin/env node
import { createHmac, randomBytes, scryptSync } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");
const file = path.join(root, "output/speed-quality-2026-09-08/local-environment.json");
if (!existsSync(file)) {
  const password = "speed-quality-local-test-password";
  const salt = randomBytes(24);
  const digest = scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1 });
  const b64 = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const token = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ role: "service_role", exp: Math.floor(Date.now() / 1000) + 7 * 86400 })}`;
  const signature = createHmac("sha256", "anbud-speed-quality-local-jwt-secret-2026").update(token).digest("base64url");
  const env = {
    DATA_API_URL: "http://127.0.0.1:55440",
    DATA_API_SERVICE_ROLE_KEY: `${token}.${signature}`,
    APP_PUBLIC_ORIGIN: "http://localhost:4318",
    APP_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    APP_SESSION_SECRET: randomBytes(32).toString("hex"),
    APP_ADMIN_ACCESS_PASSWORD_HASH: `scrypt$16384$8$1$${salt.toString("base64url")}$${digest.toString("base64url")}`,
    APP_ADMIN_PRINCIPAL_ID: "u_speed_quality_local_admin_2026",
    APP_ADMIN_DISPLAY_NAME: "Lokal testadministrator",
    APP_GUEST_CODE_PEPPER: randomBytes(32).toString("hex"),
    APP_IDENTITY_LOOKUP_SECRET: randomBytes(32).toString("hex"),
    APP_ACTIVITY_HASH_SECRET: randomBytes(32).toString("hex"),
    OPENAI_API_KEY: "local-evaluation-proxy-only",
    OPENAI_BASE_URL: "http://127.0.0.1:4319/v1",
    OPENAI_MODEL: "gpt-5.4",
    OPENAI_DOCUMENT_ANALYSIS_MODEL: "gpt-5.6-terra",
    DOCLING_INGESTION: "off",
    DOCLING_ASYNC_AUTO_RUN: "off",
    DOCUMENT_ANALYSIS_VERSION: "off",
    PROJECT_JOB_WORKER_TOKEN: "speed-quality-local-worker-only",
  };
  writeFileSync(file, JSON.stringify(env, null, 2), { mode: 0o600 });
}
const env = JSON.parse(readFileSync(file, "utf8"));
if (env.DATA_API_URL !== "http://127.0.0.1:55440" || env.OPENAI_BASE_URL !== "http://127.0.0.1:4319/v1" || env.OPENAI_API_KEY !== "local-evaluation-proxy-only") throw new Error("Refusing a nonlocal evaluation configuration.");
const argv = process.argv.slice(2);
const production = argv[0] === "--production";
if (production) argv.shift();
const [command, ...args] = argv;
if (command) {
  const runtime = production ? {
    NODE_ENV: "production",
    DATA_API_URL: "https://db.internal.speed-quality.test:55441",
    DATA_API_ALLOWED_HOST_SUFFIX: ".internal.speed-quality.test",
    NODE_EXTRA_CA_CERTS: "/tmp/anbud-speed-quality-tls/cert.pem",
    NODE_OPTIONS: "--require=/tmp/anbud-speed-quality-tls/dns.cjs",
    PORT: "4318", HOSTNAME: "127.0.0.1",
  } : {};
  const child = spawn(command, args, { cwd: path.join(root, "apps/frontend"), env: { ...process.env, ...env, ...runtime }, stdio: "inherit" });
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => child.kill(signal));
  child.on("exit", (code) => process.exit(code ?? 1));
} else console.log("Local evaluation configuration prepared; no production configuration was loaded.");
