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

test("an application inventory alone does not become a migration control", () => {
  const controls = buildVerifiedFoundationControls([
    { text: "Kunden har 240 ansatte, 12 lokasjoner og 18 applikasjoner. Kunden ønsker en trinnvis overgang fra VMware til Azure." },
    { text: "Shared services, analytics and archive are existing application groups." },
  ]);
  assert.deepEqual(controls, []);
});

test("migration controls retain documented waves and qualifications without repeating contained facts", () => {
  const wave = "Migreringen skjer i tre bølger med høyst to lokasjoner i første bølge.";
  const qualified = `${wave} Produksjonssetting krever kundens signerte aksept; prøvekjøring er ikke en slik aksept.`;
  const controls = buildVerifiedFoundationControls([{ text: qualified }, { text: wave }, { text: qualified }]);
  const migration = controls.find((text) => text.startsWith("Migreringsplanen"));
  assert.equal(migration, `Migreringsplanen må styres mot dokumentert kildegrunnlag: ${qualified}`);
  assert.ok(buildVerifiedFoundationControls([{ text: "Wave 2 migrates 14 applications after customer approval." }]).some((text) => text.startsWith("Migreringsplanen")));
});
