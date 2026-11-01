import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export function systemTestStatusPath(environment = process.env) {
  const override = environment.ANBUD_SYSTEM_TEST_STATUS;
  if (override && !path.isAbsolute(override)) throw new Error("ANBUD_SYSTEM_TEST_STATUS must be an absolute path.");
  return override || path.join(tmpdir(), "anbud-system-test-status.json");
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
