#!/usr/bin/env node
// Owns an isolated local app/PostgREST/PostgreSQL/Azurite stack. No paid AI
// calls are enabled by default. Secrets remain in a 0600 temporary file.
import { createHmac, randomBytes, scryptSync } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { assertOwnedSystemTestStack, dockerEngineSocketPath, isolatedApplicationEnvironment, ownedContainerCreateArguments, startContainerThroughEngine, systemTestPorts, systemTestStatusPath } from "./system-test-runtime.mjs";

const root = path.resolve(import.meta.dirname, "..");
const frontend = path.join(root, "apps/frontend");
const statusPath = systemTestStatusPath();
const command = process.argv[2] ?? "start";
const liveAi = process.argv.includes("--live-ai");
// Optional real parser/OCR runtime: an existing local runner-docling image, used
// offline. Without it the stack keeps its fast parser-only default.
const doclingImage = process.argv.find(argument => argument.startsWith("--docling-image="))?.slice("--docling-image=".length);
const node = process.execPath;
const ports = systemTestPorts();

function run(binary, args, options = {}) {
  const result = spawnSync(binary, args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 120_000, ...options });
  if (result.status !== 0 || result.error) throw new Error(`${path.basename(binary)} failed: ${(result.stderr || result.error?.message || "command failed").slice(-1800)}`);
  return result.stdout.trim();
}
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(test, label) {
  for (let attempt = 0; attempt < 60; attempt++) {
    if (await test()) return;
    await pause(1000);
  }
  throw new Error(`${label} did not become ready within 60 seconds.`);
}
async function available(port) {
  await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => server.close(resolve));
  });
}
function stop(state) {
  if (state.appPid) {
    try { process.kill(-state.appPid, "SIGTERM"); } catch { /* Already stopped. */ }
  }
  if (state.browserLoginPid) {
    try { process.kill(-state.browserLoginPid, "SIGTERM"); } catch { /* Already stopped. */ }
  }
  for (const name of state.containers ?? []) {
    if (!name.startsWith(`anbud-system-test-${state.id}-`)) throw new Error("Refusing to stop an unowned container.");
    spawnSync("docker", ["rm", "-f", name], { stdio: "ignore" });
  }
  if (state.network === `anbud-system-test-${state.id}`) spawnSync("docker", ["network", "rm", state.network], { stdio: "ignore" });
}

async function startApplication(state, environment) {
  const childEnvironment = isolatedApplicationEnvironment(frontend, environment);
  const log = openSync(path.join(state.directory, "app.log"), "a", 0o600);
  const child = spawn(node, ["node_modules/next/dist/bin/next", "dev", "--hostname", "127.0.0.1", "--port", String(ports.app)], { cwd: frontend, env: childEnvironment, detached: true, stdio: ["ignore", log, log] });
  state.appPid = child.pid;
  writeFileSync(path.join(state.directory, "state.json"), JSON.stringify(state, null, 2), { mode: 0o600 });
  child.unref(); closeSync(log);
  await waitFor(async () => { try { return (await fetch(`${environment.APP_PUBLIC_ORIGIN}/api/health/live`, { signal: AbortSignal.timeout(1500) })).ok; } catch { return false; } }, "Next.js");
}

if (command === "stop") {
  const status = JSON.parse(readFileSync(statusPath, "utf8"));
  const state = JSON.parse(readFileSync(path.join(status.directory, "state.json"), "utf8"));
  stop(state);
  writeFileSync(statusPath, JSON.stringify({ ...status, running: false }, null, 2));
  console.log("Stopped the owned local system-test stack.");
} else if (command === "restart-ai") {
  isolatedApplicationEnvironment(frontend, {});
  const status = JSON.parse(readFileSync(statusPath, "utf8"));
  const state = JSON.parse(readFileSync(path.join(status.directory, "state.json"), "utf8"));
  const privatePath = path.join(status.directory, "environment.json");
  const runtime = JSON.parse(readFileSync(privatePath, "utf8"));
  assertOwnedSystemTestStack(status, runtime);
  const queued = await fetch(`${runtime.env.DATA_API_URL}/project_jobs?select=id,status&status=in.(queued,running)`, { headers: { authorization: `Bearer ${runtime.env.DATA_API_SERVICE_ROLE_KEY}` } });
  if (!queued.ok || (await queued.json()).length) throw new Error("Finish pending local jobs before enabling a model endpoint.");
  // This endpoint is the parent's budget-enforcing local proxy. No upstream
  // credential is exposed to the app, arguments, status file, or logs.
  runtime.env.OPENAI_API_KEY = "local-budget-proxy-only";
  runtime.env.OPENAI_BASE_URL = "http://127.0.0.1:4340/v1";
  runtime.env.RAG_MODEL_RERANK = "on";
  runtime.env.PROJECT_JOB_WORKER_PROCESS = process.argv.includes("--web-mode") ? "0" : "1";
  for (const key of ["AZURE_COMMUNICATION_EMAIL_ENDPOINT", "AZURE_COMMUNICATION_EMAIL_SENDER", "AZURE_COMMUNICATION_EMAIL_CONNECTION_STRING", "MICROSOFT_ENTRA_CLIENT_ID", "MICROSOFT_ENTRA_CLIENT_SECRET", "MICROSOFT_ENTRA_TENANT_SUBDOMAIN"]) runtime.env[key] = "";
  writeFileSync(privatePath, JSON.stringify(runtime, null, 2), { mode: 0o600 });
  try { process.kill(-state.appPid, "SIGTERM"); } catch { /* Already stopped. */ }
  await waitFor(async () => { try { await available(ports.app); return true; } catch { return false; } }, "App shutdown");
  await startApplication(state, runtime.env);
  writeFileSync(statusPath, JSON.stringify({ ...status, appMode: "development", aiMode: "budgeted loopback model proxy" }, null, 2));
  console.log("Restarted the owned app with the explicit budgeted loopback model proxy. No AI requests were sent by this command.");
} else if (command === "start") {
  isolatedApplicationEnvironment(frontend, {});
  if (liveAi && !process.env.OPENAI_API_KEY) throw new Error("--live-ai requires an explicitly supplied OPENAI_API_KEY; no credential files are loaded automatically.");
  for (const port of Object.values(ports)) await available(port);
  if (existsSync(statusPath)) {
    const previous = JSON.parse(readFileSync(statusPath, "utf8"));
    if (previous.running) throw new Error("A system-test stack is already recorded as running; stop it explicitly first.");
  }
  const directory = mkdtempSync(path.join(tmpdir(), "anbud-system-test-"));
  const id = randomBytes(4).toString("hex");
  const state = { id, directory, network: `anbud-system-test-${id}`, containers: [], appPid: null };
  const statePath = path.join(directory, "state.json");
  const save = () => writeFileSync(statePath, JSON.stringify(state, null, 2), { mode: 0o600 });
  const password = randomBytes(24).toString("hex");
  const jwtSecret = randomBytes(32).toString("hex");
  const jwtPart = value => Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsignedJwt = `${jwtPart({ alg: "HS256", typ: "JWT" })}.${jwtPart({ role: "service_role", exp: Math.floor(Date.now() / 1000) + 86400 })}`;
  const serviceJwt = `${unsignedJwt}.${createHmac("sha256", jwtSecret).update(unsignedJwt).digest("base64url")}`;
  const blobKey = randomBytes(32).toString("base64");
  const blobConnection = `DefaultEndpointsProtocol=http;AccountName=anbudtest;AccountKey=${blobKey};BlobEndpoint=http://127.0.0.1:${ports.blob}/anbudtest`;
  const adminPassword = randomBytes(18).toString("base64url");
  const salt = randomBytes(24);
  const hash = scryptSync(adminPassword, salt, 32, { N: 16384, r: 8, p: 1 });
  const env = {
    NODE_ENV: "development", NEXT_TELEMETRY_DISABLED: "1",
    DATA_API_URL: `http://127.0.0.1:${ports.postgrest}`, DATA_API_SERVICE_ROLE_KEY: serviceJwt,
    AZURE_STORAGE_EMULATOR_CONNECTION_STRING: blobConnection, AZURE_STORAGE_CONTAINER: "anbud-system-test", AZURE_STORAGE_ACCOUNT_URL: "",
    AZURE_COMMUNICATION_EMAIL_ENDPOINT: "", AZURE_COMMUNICATION_EMAIL_SENDER: "", AZURE_COMMUNICATION_EMAIL_CONNECTION_STRING: "",
    MICROSOFT_ENTRA_CLIENT_ID: "", MICROSOFT_ENTRA_CLIENT_SECRET: "", MICROSOFT_ENTRA_TENANT_SUBDOMAIN: "",
    APP_PUBLIC_ORIGIN: `http://127.0.0.1:${ports.app}`,
    APP_ENCRYPTION_KEY: randomBytes(32).toString("base64"), APP_SESSION_SECRET: randomBytes(32).toString("hex"),
    APP_ADMIN_ACCESS_PASSWORD_HASH: `scrypt$16384$8$1$${salt.toString("base64url")}$${hash.toString("base64url")}`,
    APP_ADMIN_PRINCIPAL_ID: `u_system_test_admin_${id}`, APP_ADMIN_DISPLAY_NAME: "Lokal systemtest",
    APP_GUEST_CODE_PEPPER: randomBytes(32).toString("hex"), APP_IDENTITY_LOOKUP_SECRET: randomBytes(32).toString("hex"),
    APP_ACTIVITY_HASH_SECRET: randomBytes(32).toString("hex"), PROJECT_JOB_WORKER_TOKEN: randomBytes(32).toString("hex"),
    PROJECT_JOB_WORKER_PROCESS: "1", DOCLING_INGESTION: "off", DOCLING_ASYNC_AUTO_RUN: "off",
    DOCUMENT_ANALYSIS_VERSION: "off", OPENAI_API_KEY: liveAi ? process.env.OPENAI_API_KEY : "",
    OPENAI_BASE_URL: liveAi ? process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1" : "",
    RAG_MODEL_RERANK: liveAi ? "on" : "off",
  };
  writeFileSync(path.join(directory, "environment.json"), JSON.stringify({ env, adminPassword, browserLoginToken: randomBytes(32).toString("hex"), databaseUrl: `postgresql://postgres:${password}@127.0.0.1:${ports.postgres}/postgres` }, null, 2), { mode: 0o600 });
  const dockerEnv = (file, values) => {
    const target = path.join(directory, file);
    writeFileSync(target, Object.entries(values).map(([key, value]) => `${key}=${value}`).join("\n"), { mode: 0o600 });
    return target;
  };
  const engineSocket = dockerEngineSocketPath(run("docker", ["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"]));
  async function container(suffix, image, args = [], values = {}, publish = [], options = {}) {
    const name = `anbud-system-test-${id}-${suffix}`;
    const file = dockerEnv(`${suffix}.env`, values);
    state.containers.push(name); save();
    run("docker", ownedContainerCreateArguments({ name, network: options.network ?? state.network, envFile: file, publish, label: `anbud.system-test=${id}`, image, args, ...options }), { timeout: 600_000 });
    await startContainerThroughEngine(engineSocket, name);
    return name;
  }
  try {
    run("docker", ["network", "create", state.network]); save();
    const pg = await container("pg", "pgvector/pgvector:pg17", [], { POSTGRES_PASSWORD: password }, [`127.0.0.1:${ports.postgres}:5432`]);
    await waitFor(() => spawnSync("docker", ["exec", pg, "pg_isready", "-U", "postgres"], { stdio: "ignore" }).status === 0, "PostgreSQL");
    const sql = statement => run("docker", ["exec", "-i", pg, "psql", "-U", "postgres", "-X", "-q", "-v", "ON_ERROR_STOP=1"], { input: statement });
    sql(`create role anon; create role authenticated; create role service_role bypassrls; create role authenticator login password '${password}'; grant anon, authenticated, service_role to authenticator;`);
    sql(`set anbud.allow_destructive_schema_rebuild=on;\n${readFileSync(path.join(root, "database/schema.sql"), "utf8")}`);
    await container("api", "postgrest/postgrest:v14.17", [], { PGRST_DB_URI: `postgres://authenticator:${password}@${pg}:5432/postgres`, PGRST_DB_SCHEMAS: "public", PGRST_DB_ANON_ROLE: "anon", PGRST_JWT_SECRET: jwtSecret }, [`127.0.0.1:${ports.postgrest}:3000`]);
    await container("blob", "mcr.microsoft.com/azure-storage/azurite:3.35.0", ["azurite-blob", "--blobHost", "0.0.0.0", "--skipApiVersionCheck", "--disableProductStyleUrl", "--silent"], { AZURITE_ACCOUNTS: `anbudtest:${blobKey}` }, [`127.0.0.1:${ports.blob}:10000`]);
    await waitFor(async () => { try { return (await fetch(env.DATA_API_URL, { signal: AbortSignal.timeout(1500) })).ok; } catch { return false; } }, "PostgREST");
    const require = createRequire(path.join(frontend, "package.json"));
    const { BlobServiceClient } = require("@azure/storage-blob");
    await waitFor(async () => { try { await BlobServiceClient.fromConnectionString(blobConnection).getContainerClient(env.AZURE_STORAGE_CONTAINER).createIfNotExists(); return true; } catch { return false; } }, "Azurite");
    if (doclingImage) {
      // Offline, without credentials or any host mount: the command streams each
      // file through `docker exec`, keeping the app's real CLI arguments intact.
      const parser = await container("docling", doclingImage, ["infinity"], { HOME: "/home/node" }, [], { network: "none", user: "1001:1001", entrypoint: "sleep" });
      Object.assign(env, {
        DOCLING_INGESTION: "on", DOCLING_FORMATS: "pdf,docx", DOCLING_ENHANCEMENT_MODE: "async", DOCLING_ASYNC_AUTO_RUN: "off",
        DOCLING_CLI_COMMAND: path.join(root, "scripts/system-test-docling-command.mjs"), DOCLING_ARTIFACTS_PATH: "/opt/docling-models", DOCLING_OCR: "auto",
        DOCLING_NUM_THREADS: "2", DOCLING_TABLE_MODE: "accurate", DOCLING_LARGE_PDF_TABLE_MODE: "fast", DOCLING_PDF_CHUNKING: "auto", DOCLING_TIMEOUT_MS: "420000",
        ANBUD_SYSTEM_TEST_DOCLING_CONTAINER: parser, ANBUD_SYSTEM_TEST_DOCLING_FAILURE_MARKER: path.join(directory, "inject-docling-failure"),
      });
      const stored = JSON.parse(readFileSync(path.join(directory, "environment.json"), "utf8"));
      writeFileSync(path.join(directory, "environment.json"), JSON.stringify({ ...stored, env }, null, 2), { mode: 0o600 });
    }
    await startApplication(state, env);
    const status = { running: true, directory, baseUrl: env.APP_PUBLIC_ORIGIN, browserLoginUrlFile: path.join(directory, "browser-login-url.txt"), ports, aiMode: liveAi ? "explicit model endpoint" : "disabled", docling: doclingImage ? { image: doclingImage, imageId: run("docker", ["image", "inspect", doclingImage, "--format", "{{.Id}}"]) } : null, createdAt: new Date().toISOString() };
    const { browserLoginToken } = JSON.parse(readFileSync(path.join(directory, "environment.json"), "utf8"));
    writeFileSync(status.browserLoginUrlFile, `http://127.0.0.1:4339/browser-login?token=${browserLoginToken}`, { mode: 0o600 });
    writeFileSync(statusPath, JSON.stringify(status, null, 2));
    const bridgeLog = openSync(path.join(directory, "browser-login.log"), "a", 0o600);
    const bridge = spawn(node, [path.join(root, "scripts/system-test-browser-login.mjs")], { cwd: root, detached: true, stdio: ["ignore", bridgeLog, bridgeLog] });
    state.browserLoginPid = bridge.pid; save(); bridge.unref(); closeSync(bridgeLog);
    console.log(`Local system-test stack ready: ${env.APP_PUBLIC_ORIGIN}. Status: ${statusPath}`);
  } catch (error) { stop(state); throw error; }
} else throw new Error("Usage: node scripts/system-test-environment.mjs start|restart-ai|stop");
