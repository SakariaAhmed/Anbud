import assert from "node:assert/strict";
import path from "node:path";
import { createJiti } from "jiti";
import test from "node:test";

const frontend = path.resolve(import.meta.dirname, "../../..");
const { collectArtifactFoundationFacts } = createJiti(import.meta.url, {
  alias: { "@": frontend, "server-only": "/dev/null" },
})(path.join(frontend, "lib/server/ai.ts"));
const factsFor = raw_text => collectArtifactFoundationFacts({ documents: [{ title: "Fiktivt kravgrunnlag", raw_text }], serviceDocuments: [] }).map(fact => fact.text);

test("short numbered headings remain separate from the preceding source fact", () => {
  for (const heading of ["2 Generelle krav", "2.1 Generelle krav", "2.1.3 Krav til sikkerhet"]) {
    const facts = factsFor(`Krav til sikkerhet og tilgang\n${heading}`);
    assert.ok(facts.includes("Krav til sikkerhet og tilgang"));
    assert.ok(facts.every(fact => !fact.includes(`tilgang ${heading}`)));
  }
});

test("wrapped ISO identifiers, dates, and amounts remain complete source facts", () => {
  for (const [text, expected] of [
    ["Leverandøren skal dokumentere sikkerhet i henhold til ISO/IEC\n27001:2022.", "ISO/IEC 27001:2022."],
    ["Tilbudsfrist er\n10. november 2026.", "Tilbudsfrist er 10. november 2026."],
    ["Avtalens maksimale verdi er NOK\n18 400 000 eksklusive merverdiavgift.", "NOK 18 400 000"],
  ]) {
    assert.ok(factsFor(text).some(fact => fact.includes(expected)), text);
  }
});
