import { existsSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

export function systemTestStatusPath(environment = process.env) {
  const override = environment.ANBUD_SYSTEM_TEST_STATUS;
  if (override && !path.isAbsolute(override)) throw new Error("ANBUD_SYSTEM_TEST_STATUS must be an absolute path.");
  return override || path.join(tmpdir(), "anbud-system-test-status.json");
}

const DEFAULT_PORTS = Object.freeze({ postgres: 55448, postgrest: 55449, blob: 55450, app: 4338, browserLogin: 4339 });

/** The app/login ports stay fixed; the data ports move together when another
 * local process (for example a stale Docker Desktop listener) already holds them. */
export function systemTestPorts(environment = process.env) {
  const raw = environment.ANBUD_SYSTEM_TEST_DATA_PORT_BASE;
  if (!raw) return { ...DEFAULT_PORTS };
  const base = Number(raw);
  if (!Number.isSafeInteger(base) || base < 1024 || base > 65533) throw new Error("ANBUD_SYSTEM_TEST_DATA_PORT_BASE must be an unprivileged TCP port with two free successors.");
  return { ...DEFAULT_PORTS, postgres: base, postgrest: base + 1, blob: base + 2 };
}

/** Destructive fixture and worker calls may only target the recorded loopback stack. */
export function assertOwnedSystemTestStack(status, runtime) {
  if (status?.running !== true) throw new Error("Start scripts/system-test-environment.mjs first.");
  if (status.baseUrl !== `http://127.0.0.1:${DEFAULT_PORTS.app}`) throw new Error("Only the owned loopback system-test app is allowed.");
  const postgrest = status.ports?.postgrest;
  if (!Number.isSafeInteger(postgrest) || runtime?.env?.DATA_API_URL !== `http://127.0.0.1:${postgrest}`) throw new Error("Only the owned loopback data API is allowed.");
}

export function ownedContainerCreateArguments({ name, network, envFile, publish = [], label, user, entrypoint, image, args = [] }) {
  return ["create", "--rm", "--name", name, "--label", label, ...(network ? ["--network", network] : []), ...(envFile ? ["--env-file", envFile] : []), ...(user ? ["--user", user] : []),
    ...publish.flatMap(mapping => ["-p", mapping]), ...(entrypoint ? ["--no-healthcheck", "--entrypoint", entrypoint] : []), image, ...args];
}

export function dockerEngineSocketPath(dockerHost) {
  const socket = /^unix:\/\/(\/.+)$/u.exec(dockerHost ?? "")?.[1];
  if (!socket) throw new Error("The owned test stack needs a local Docker Engine socket.");
  return socket;
}

function requestContainerStart(socketPath, name, timeoutMs) {
  return new Promise((resolve, reject) => {
    const request = http.request({ socketPath, method: "POST", path: `/containers/${encodeURIComponent(name)}/start`, timeout: timeoutMs }, response => {
      response.resume();
      response.once("end", () => [204, 304].includes(response.statusCode) ? resolve("started") : reject(new Error(`Docker Engine refused to start ${name}: HTTP ${response.statusCode}.`)));
    });
    request.once("timeout", () => { request.destroy(); resolve("stalled"); });
    request.once("error", reject);
    request.end();
  });
}

/** On this Docker Desktop release the first `POST /start` for a created container
 * can stay in the host proxy indefinitely, which is what leaves `docker run` and
 * `docker start` at `created`. Abandoning it lets the next identical request
 * complete in under a second. HTTP 304 means an earlier request took effect. */
export async function startContainerThroughEngine(socketPath, name, { attempts = 5, timeoutMs = 8_000 } = {}) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (await requestContainerStart(socketPath, name, timeoutMs) === "started") return;
  }
  throw new Error(`Docker Engine did not start ${name} in ${attempts} attempts of ${timeoutMs} ms.`);
}

/** Next loads dotenv files independently of its inherited process environment. */
export function isolatedApplicationEnvironment(frontend, scenario, inherited = process.env) {
  const dotenvFiles = [".env", ".env.local", ".env.development", ".env.development.local"];
  if (dotenvFiles.some(file => existsSync(path.join(frontend, file)))) {
    throw new Error("Run the system harness in a clean checkout without frontend dotenv files; it must not load external service credentials.");
  }
  const environment = {};
  for (const key of ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "TZ"]) {
    if (inherited[key] !== undefined) environment[key] = inherited[key];
  }
  return {
    ...environment,
    ...scenario,
    AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT: "",
    AZURE_DOCUMENT_INTELLIGENCE_KEY: "",
  };
}
