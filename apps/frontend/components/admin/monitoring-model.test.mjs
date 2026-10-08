import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const { rowsInPeriod } = createJiti(import.meta.url)("./monitoring-model.ts");
const end = "2026-10-06T12:00:00Z";
const rows = [
  { id: "current", timestamp: end },
  { id: "boundary", timestamp: "2026-10-05T12:00:00Z" },
  { id: "older", timestamp: "2026-10-03T12:00:00Z" },
  { id: "month", timestamp: "2026-09-10T12:00:00Z" },
  { id: "outside", timestamp: "2026-08-01T12:00:00Z" },
  { id: "future", timestamp: "2026-10-07T12:00:00Z" },
  { id: "invalid", timestamp: "invalid" },
];
test("period filtering includes boundaries and excludes future or invalid observations", () => {
  assert.deepEqual(rowsInPeriod(rows, "24h", end).map(row => row.id), ["current", "boundary"]);
  assert.deepEqual(rowsInPeriod(rows, "7d", end).map(row => row.id), ["current", "boundary", "older"]);
  assert.deepEqual(rowsInPeriod(rows, "30d", end).map(row => row.id), ["current", "boundary", "older", "month"]);
});
test("missing observations and invalid snapshots do not become measurements", () => {
  assert.deepEqual(rowsInPeriod([], "24h", end), []);
  assert.deepEqual(rowsInPeriod(rows, "24h", "invalid"), []);
});
