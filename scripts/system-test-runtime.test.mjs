import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { isolatedApplicationEnvironment, systemTestStatusPath } from "./system-test-runtime.mjs";

test("local app inherits only OS essentials and explicitly supplied scenario settings", t => {
  const directory = mkdtempSync(path.join(tmpdir(), "anbud-harness-env-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const environment = isolatedApplicationEnvironment(directory, {
    DATA_API_URL: "http://127.0.0.1:55449", OPENAI_API_KEY: "", NODE_ENV: "development",
  }, {
    PATH: "/usr/bin", HOME: directory, OPENAI_API_KEY: "synthetic-parent-credential",
    OPENAI_MAIN_MODEL: "unrequested-model", AZURE_DOCUMENT_INTELLIGENCE_KEY: "synthetic-parent-credential",
    DATA_API_ALLOWED_HOST_SUFFIX: "external.invalid", NODE_OPTIONS: "--require unwanted.cjs",
  });
  assert.equal(environment.PATH, "/usr/bin");
  assert.equal(environment.HOME, directory);
  assert.equal(environment.DATA_API_URL, "http://127.0.0.1:55449");
  assert.equal(environment.OPENAI_API_KEY, "");
  assert.equal(environment.AZURE_DOCUMENT_INTELLIGENCE_KEY, "");
  assert.equal(environment.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT, "");
  for (const key of ["OPENAI_MAIN_MODEL", "DATA_API_ALLOWED_HOST_SUFFIX", "NODE_OPTIONS"]) assert.equal(environment[key], undefined);
});

test("Next dotenv files cannot introduce external credentials into an isolated scenario", t => {
  for (const file of [".env", ".env.local", ".env.development", ".env.development.local"]) {
    const directory = mkdtempSync(path.join(tmpdir(), "anbud-harness-dotenv-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    writeFileSync(path.join(directory, file), "EXTERNAL_SERVICE_KEY=synthetic-credential");
    assert.throws(() => isolatedApplicationEnvironment(directory, {}, {}), /clean checkout/u);
  }
});

test("status paths use the OS temporary directory or an explicit absolute override", () => {
  assert.equal(systemTestStatusPath({}), path.join(tmpdir(), "anbud-system-test-status.json"));
  const override = path.join(tmpdir(), "owned-other-status.json");
  assert.equal(systemTestStatusPath({ ANBUD_SYSTEM_TEST_STATUS: override }), override);
  assert.throws(() => systemTestStatusPath({ ANBUD_SYSTEM_TEST_STATUS: "relative.json" }), /absolute/u);
});
