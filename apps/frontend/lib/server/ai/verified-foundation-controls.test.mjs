import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";

const frontend = path.resolve(import.meta.dirname, "../../..");
const jiti = createRequire(import.meta.url)("jiti").createJiti(import.meta.url, { alias: { "@": frontend, "server-only": "/dev/null" } });
const { buildVerifiedFoundationControls } = jiti(path.join(frontend, "lib/server/ai/verified-foundation-controls.ts"));

test("foundation controls retain the qualification at the end of a bounded source fact", () => {
  const text = "Ordretjenesten har RTO 2 timer. " + "Gjenoppretting skal dokumenteres og kontrolleres. ".repeat(5) + "Unntaket er arkivtjenesten, som har RTO 8 timer.";
  const controls = buildVerifiedFoundationControls([{ text }]);
  assert.ok(controls.some((control) => control.endsWith("Unntaket er arkivtjenesten, som har RTO 8 timer.")));
  assert.ok(controls.some((control) => control.includes("Ordretjenesten har RTO 2 timer.")));
});
