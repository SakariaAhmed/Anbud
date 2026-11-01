import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const frontend = path.resolve(import.meta.dirname, "../..");
test("readiness recognizes an explicit local Blob emulator only outside production", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "anbud-health-test-"));
  const values = {
    APP_ENCRYPTION_KEY: "local-test", APP_ADMIN_ACCESS_PASSWORD_HASH: "local-test", APP_ADMIN_PRINCIPAL_ID: "u_health_local_test_admin", APP_SESSION_SECRET: "local-test",
    OPENAI_API_KEY: "local-test", PROJECT_JOB_WORKER_TOKEN: "local-test", DATA_API_URL: "https://db.internal.test", DATA_API_SERVICE_ROLE_KEY: "local-test", DATA_API_ALLOWED_HOST_SUFFIX: ".internal.test",
    AZURE_STORAGE_ACCOUNT_URL: "", AZURE_STORAGE_EMULATOR_CONNECTION_STRING: "DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=local-test;BlobEndpoint=http://127.0.0.1:55450/devstoreaccount1",
  };
  const names = [...Object.keys(values), "NODE_ENV"];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  try {
    const dataApi = path.join(directory, "data.cjs"), blob = path.join(directory, "blob.cjs");
    writeFileSync(dataApi, "exports.createServiceClient=()=>({from:()=>({select:()=>({limit:()=>({abortSignal:async()=>({error:null})})})})});");
    writeFileSync(blob, "exports.BlobServiceClient=class {static fromConnectionString(){return new this();} getContainerClient(){return {getProperties:async()=>({})};}};");
    Object.assign(process.env, values);
    for (const mode of ["development", "production"]) {
      process.env.NODE_ENV = mode;
      const load = createJiti(import.meta.url, { moduleCache: false, alias: { "@": frontend, "server-only": "/dev/null", "@/lib/server/data-api": dataApi, "@azure/storage-blob": blob } });
      const { createReadinessModel } = load(path.join(frontend, "lib/server/health.ts"));
      const result = await createReadinessModel();
      assert.equal(result.status, mode === "development" ? "healthy" : "unhealthy");
      assert.equal(result.components.find(component => component.name === "configuration").metadata.file_storage_backend, mode === "development" ? "azure_blob_emulator" : "azure_blob");
    }
  } finally {
    for (const name of names) { if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name]; }
    rmSync(directory, { recursive: true, force: true });
  }
});
