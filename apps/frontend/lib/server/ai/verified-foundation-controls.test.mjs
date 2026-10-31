import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";

const frontend = path.resolve(import.meta.dirname, "../../..");
const jiti = createRequire(import.meta.url)("jiti").createJiti(import.meta.url, { alias: { "@": frontend, "server-only": "/dev/null" } });
const { documentedMigrationControl } = jiti(path.join(frontend, "lib/server/ai/verified-foundation-controls.ts"));

test("an application inventory alone does not become a migration control", () => {
  const control = documentedMigrationControl([
    { text: "Kunden har 240 ansatte, 12 lokasjoner og 18 applikasjoner. Kunden ønsker en trinnvis overgang fra VMware til Azure." },
    { text: "Shared services, analytics and archive are existing application groups." },
  ]);
  assert.equal(control, "");
});

test("migration controls retain documented waves and qualifications without repeating contained facts", () => {
  const wave = "Migreringen skjer i tre bølger med høyst to lokasjoner i første bølge.";
  const qualified = `${wave} Produksjonssetting krever kundens signerte aksept; prøvekjøring er ikke en slik aksept.`;
  const migration = documentedMigrationControl([{ text: qualified }, { text: wave }, { text: qualified }]);
  assert.equal(migration, `Migreringsplanen må styres mot dokumentert kildegrunnlag: ${qualified}`);
  assert.match(documentedMigrationControl([{ text: "Wave 2 migrates 14 applications after customer approval." }]), /^Migreringsplanen/u);
});
