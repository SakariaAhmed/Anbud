import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { fileURLToPath } from "node:url";

const jiti = createJiti(import.meta.url, { alias: { "@": fileURLToPath(new URL("../../../", import.meta.url)), "server-only": "/dev/null" } });
const { narrativeAnswerEvidence } = jiti("./narrative-answer-evidence.ts");
const rows = ["K-1", "K-2"].map((id) => ({ id, text: "Kravets opprinnelige tekst", pages: [1], heading: "Krav", documentId: "customer" }));
const document = (raw_text) => ({ id: "solution", title: "Leverandørens løsning", file_format: "md", raw_text });

test("explicit answer lines and answer headings keep their complete source sections", () => {
  for (const text of [
    "K-1: Kundedata lagres i Sverige, og flytting til Norge er ikke priset.\nK-2: Kundens administratorer bruker flerfaktorautentisering ved alle pålogginger.",
    "## S01 – svar på K-1\nKundedata lagres i Sverige.\n\nFlytting til Norge er ikke priset.\n\n## S02 – svar på K-2\nKundens administratorer bruker flerfaktorautentisering ved alle pålogginger.",
  ]) {
    const result = narrativeAnswerEvidence(document(text), rows);
    assert.deepEqual(result.map((r) => r.id), ["K-1", "K-2"]);
    assert.match(result[0].answerExcerpt, /ikke priset/);
    assert.doesNotMatch(result[0].answerExcerpt, /flerfaktor/);
    assert.match(result[1].answerExcerpt, /flerfaktor/);
    for (const row of result) {
      assert.ok(text.includes(row.answerExcerpt));
      assert.equal(row.documentId, "solution");
      assert.equal(row.text, "Kravets opprinnelige tekst");
    }
  }
});

test("a qualification following a prose reference stays with that answer", () => {
  const text = "Vi tilbyr døgnkontinuerlig vakt (K-1), men helgeberedskap er ikke priset. Tilgang sikres med multifaktor for alle administratorer (K-2).";
  const result = narrativeAnswerEvidence(document(text), rows);
  assert.equal(result.length, 2);
  assert.match(result[0].answerExcerpt, /helgeberedskap er ikke priset/);
  assert.doesNotMatch(result[1].answerExcerpt, /helgeberedskap/);
  assert.ok(text.includes(result[0].answerExcerpt));
});

test("nested qualification headings remain part of their answer section", () => {
  const text = "## S01 – svar på K-1\nVi tilbyr døgnkontinuerlig vakt med dokumenterte rutiner og tydelig eskalering.\n\n### Prisforutsetning\nHelgeberedskap er ikke priset og krever en separat avtale.\n\n## S02 – svar på K-2\nTilgang sikres med multifaktor for alle administratorer og logges i revisjonssporet.\n\n## Generell firmapresentasjon\nVi har mange ansatte og flere kontorer.";
  const result = narrativeAnswerEvidence(document(text), rows);
  assert.equal(result.length, 2);
  assert.match(result[0].answerExcerpt, /Helgeberedskap er ikke priset/);
  assert.doesNotMatch(result[0].answerExcerpt, /Tilgang sikres/);
  assert.doesNotMatch(result[1].answerExcerpt, /firmapresentasjon|Helgeberedskap/);
  assert.ok(text.includes(result[0].answerExcerpt));
});

test("an inline answer does not absorb a separate unlabelled project paragraph", () => {
  const text = "K-1: Data eksporteres i dokumenterte åpne formater innen 20 arbeidsdager.\n\nKunden godkjenner tester. Pris og oppstartsdato må avtales.";
  const [result] = narrativeAnswerEvidence(document(text), rows);
  assert.match(result.answerExcerpt, /20 arbeidsdager/);
  assert.doesNotMatch(result.answerExcerpt, /Pris og oppstartsdato/);
});

test("unknown, repeated and ambiguous references cannot become a unique answer", () => {
  const text = "## S00 – svar på K-99\nEn ukjent tjeneste har en hemmelig prisforutsetning.\n## S01 – svar på K-1\nTilgangen er dokumentert med en kontrollert akseptansetest.\n## S02 – svar på K-2 og K-99\nBegge tjenester krever en separat avtale før leveranse.";
  const result = narrativeAnswerEvidence(document(text), rows);
  assert.deepEqual(result.map((r) => r.id), ["K-1"]);
  assert.doesNotMatch(result[0].answerExcerpt, /hemmelig|separat avtale/);
  assert.equal(narrativeAnswerEvidence(document(text), [...rows, { ...rows[0], documentId: "another-customer" }]).length, 0);
  assert.equal(narrativeAnswerEvidence(document("K-1: Tilgangen er dokumentert med en kontrollert akseptansetest.\nK-1: Tilgangen trenger likevel en separat avtale med kunden."), rows).length, 0);
  assert.equal(narrativeAnswerEvidence(document("K-1: Tilgangen er dokumentert med en kontrollert akseptansetest.\nK-1: Nei."), rows).length, 0);
  assert.equal(narrativeAnswerEvidence(document("Tilgang og drift leveres med separate avtaler (K-1 og K-2)."), rows).length, 0);
});

test("a unique hyphen variant links to the original ID without collapsing ambiguous source rows", () => {
  const source = [{ ...rows[0], id: "L01" }];
  const text = "## S01 – svar på L-01\nKundedata lagres i Sverige, og flytting til Norge er ikke priset.";
  const [answer] = narrativeAnswerEvidence(document(text), source);
  assert.equal(answer.id, "L01");
  assert.equal(answer.answerExcerpt, text);
  assert.match(answer.answerReference, /L-01/);
  assert.equal(narrativeAnswerEvidence(document(text), [...source, { ...source[0], id: "L-01" }]).length, 0);
  assert.equal(narrativeAnswerEvidence(document(text), [{ ...source[0], id: "L1" }]).length, 0);
});

test("an explicit answer target distinguishes compact requirement IDs from section numbering", () => {
  const source = [{ ...rows[0], id: "L01" }, { ...rows[1], id: "L02" }];
  const text = "## S01 – svar på L01\nKundedata lagres i Sverige, og flytting til Norge er ikke priset.\n## S02 – svar på L02\nAdministratorer bruker flerfaktorautentisering ved alle pålogginger.";
  assert.deepEqual(narrativeAnswerEvidence(document(text), source).map((row) => row.id), ["L01", "L02"]);
  assert.equal(narrativeAnswerEvidence(document(text.replace('svar på L01', 'svar på L01 og L99')), source).length, 1);
});
