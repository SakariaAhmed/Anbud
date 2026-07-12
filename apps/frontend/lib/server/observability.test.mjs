import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const frontendRoot = path.resolve(__dirname, "../..");
const require = createRequire(import.meta.url);
const { createJiti } = require(path.join(frontendRoot, "node_modules", "jiti"));
const testSupportPath = path.join(
  frontendRoot,
  "lib/server/storage-observability.test-support.ts",
);
const jiti = createJiti(path.join(frontendRoot, "observability-tests.cjs"), {
  interopDefault: true,
  alias: {
    "@/lib/server/supabase": testSupportPath,
    "@": frontendRoot,
    "server-only": "/dev/null",
  },
});

const { setStorageObservabilityTestClient } = jiti(testSupportPath);
const { AuditEventPersistenceError, auditEvent } = jiti(
  path.join(frontendRoot, "lib/server/observability.ts"),
);

function auditClient(results) {
  const inserts = [];
  return {
    inserts,
    client: {
      from(table) {
        assert.equal(table, "audit_events");
        return {
          async insert(payload) {
            inserts.push(structuredClone(payload));
            const next = results.shift() ?? { error: null };
            if (next.throw) throw next.throw;
            if (next.hang) return new Promise(() => {});
            return next;
          },
        };
      },
    },
  };
}

test("required project deletion audit is persisted with null project FK and entity metadata", async () => {
  const audit = auditClient([{ error: null }]);
  setStorageObservabilityTestClient(audit.client);
  const projectId = "00000000-0000-4000-8000-000000000123";
  const originalInfo = console.info;
  console.info = () => {};
  try {
    const result = await auditEvent({
      action: "project_deleted",
      projectId: null,
      entityType: "project",
      entityId: projectId,
      metadata: { deleted_project_id: projectId },
      required: true,
    });

    assert.equal(result.persisted, true);
    assert.equal(audit.inserts.length, 1);
    assert.equal(audit.inserts[0].project_id, null);
    assert.equal(audit.inserts[0].entity_type, "project");
    assert.equal(audit.inserts[0].entity_id, projectId);
    assert.deepEqual(audit.inserts[0].metadata, {
      deleted_project_id: projectId,
    });
    assert.equal(audit.inserts[0].id, result.eventId);
  } finally {
    console.info = originalInfo;
  }
});

test("audit accepts a caller-supplied id for idempotent terminal events", async () => {
  const audit = auditClient([{ error: null }]);
  setStorageObservabilityTestClient(audit.client);
  const eventId = "00000000-0000-4000-8000-000000000456";
  const originalInfo = console.info;
  console.info = () => {};
  try {
    const result = await auditEvent({
      eventId,
      action: "project_job_completed",
      projectId: eventId,
      entityType: "project_job",
      entityId: eventId,
    });

    assert.equal(result.persisted, true);
    assert.equal(result.eventId, eventId);
    assert.equal(audit.inserts.length, 1);
    assert.equal(audit.inserts[0].id, eventId);
    assert.equal(audit.inserts[0].subject_project_id, eventId);
  } finally {
    console.info = originalInfo;
  }
});

test("required audit retries idempotently, emits telemetry and fails the caller", async () => {
  const audit = auditClient([
    { error: { code: "500", message: "forced audit failure" } },
    { error: { code: "500", message: "forced audit failure" } },
    { error: { code: "500", message: "forced audit failure" } },
  ]);
  setStorageObservabilityTestClient(audit.client);
  const telemetry = [];
  const originalError = console.error;
  const originalInfo = console.info;
  console.error = (value) => telemetry.push(JSON.parse(String(value)));
  console.info = () => {};
  try {
    await assert.rejects(
      auditEvent({ action: "project_deleted", required: true }),
      (error) =>
        error instanceof AuditEventPersistenceError &&
        error.action === "project_deleted",
    );
    assert.equal(audit.inserts.length, 3);
    assert.equal(new Set(audit.inserts.map((row) => row.id)).size, 1);
    assert.deepEqual(telemetry, [
      {
        event: "audit_persistence_failed",
        audit_event_id: audit.inserts[0].id,
        action: "project_deleted",
        project_id: null,
        entity_type: null,
        entity_id: null,
        required: true,
        attempts: 3,
        error_code: "500",
        error: "forced audit failure",
      },
    ]);
  } finally {
    console.error = originalError;
    console.info = originalInfo;
  }
});

test("best-effort audit failures are observable instead of silently swallowed", async () => {
  const audit = auditClient([
    { error: { code: "42P01", message: "audit_events is missing" } },
  ]);
  setStorageObservabilityTestClient(audit.client);
  const telemetry = [];
  const originalError = console.error;
  const originalInfo = console.info;
  console.error = (value) => telemetry.push(JSON.parse(String(value)));
  console.info = () => {};
  try {
    const result = await auditEvent({ action: "project_created" });
    assert.equal(result.persisted, false);
    assert.equal(result.error, "audit_events is missing");
    assert.equal(telemetry[0].event, "audit_persistence_failed");
    assert.equal(telemetry[0].required, false);
  } finally {
    console.error = originalError;
    console.info = originalInfo;
  }
});

test("best-effort audit writes have a bounded timeout", async () => {
  const audit = auditClient([{ hang: true }]);
  setStorageObservabilityTestClient(audit.client);
  const previousTimeout = process.env.AUDIT_WRITE_TIMEOUT_MS;
  process.env.AUDIT_WRITE_TIMEOUT_MS = "5";
  const telemetry = [];
  const originalError = console.error;
  const originalInfo = console.info;
  console.error = (value) => telemetry.push(JSON.parse(String(value)));
  console.info = () => {};
  try {
    const result = await auditEvent({ action: "project_job_completed" });
    assert.equal(result.persisted, false);
    assert.match(result.error, /Tidsgrensen/u);
    assert.equal(telemetry[0].error_code, "AUDIT_WRITE_TIMEOUT");
  } finally {
    console.error = originalError;
    console.info = originalInfo;
    if (previousTimeout === undefined) {
      delete process.env.AUDIT_WRITE_TIMEOUT_MS;
    } else {
      process.env.AUDIT_WRITE_TIMEOUT_MS = previousTimeout;
    }
  }
});
