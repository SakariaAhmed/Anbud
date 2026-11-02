import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const frontend = path.resolve(import.meta.dirname, "../../..");
const load = createJiti(import.meta.url, { alias: { "@": frontend, "server-only": "/dev/null" } });
const { extractRequirementLedgerForDocument } = load("./source-ledger.ts");
const { annotateRequirementTextProvenance } = load("./ingestion-register.ts");
const fixtures = path.join(import.meta.dirname, "fixtures/observed-ocr");
const document = (raw_text, extra = {}) => ({ id: "document", project_id: "project", role: "supporting_document", supporting_subtype: "kravdokument", title: "Bilag 1", file_name: "krav.pdf", file_format: "pdf", file_base64: "", structure_map: [], raw_text, ...extra });
const rows = async (raw_text, extra) => (await extractRequirementLedgerForDocument(document(raw_text, extra))).map(row => [row.id, row.text]);

for (const file of readdirSync(fixtures).filter(name => name.endsWith(".observed.json"))) {
  test(`observed synthetic OCR output ${file} keeps its labelled rows, spans and locators`, async () => {
    const fixture = JSON.parse(readFileSync(path.join(fixtures, file), "utf8"));
    assert.match(fixture.notice, /Synthetic fixture only/u);
    const source = readFileSync(path.resolve(frontend, "../..", fixture.source_pdf.path));
    assert.equal(createHash("sha256").update(source).digest("hex"), fixture.source_pdf.sha256, "The fixture must stay bound to the frozen PDF.");
    const { raw_text, structure_map, file_format, file_name } = fixture.document;
    const ledger = annotateRequirementTextProvenance(await extractRequirementLedgerForDocument(document(raw_text, { structure_map, file_format, file_name })), raw_text);
    assert.deepEqual(ledger.map(row => row.id), fixture.expected_rows.map(row => row.id));
    for (const [index, expected] of fixture.expected_rows.entries()) {
      const row = ledger[index];
      assert.equal(row.text, expected.text);
      assert.equal(row.idOrigin, "source");
      assert.equal(row.textOrigin, "observed");
      assert.deepEqual(row.textEvidence, { originalText: expected.original_span.text, start: expected.original_span.start, end: expected.original_span.end });
      assert.equal(raw_text.slice(row.textEvidence.start, row.textEvidence.end), expected.original_span.text);
      assert.deepEqual(row.pages, [expected.locator.page]);
      const paragraph = structure_map.find(entry => entry.docling_ref === expected.locator.docling_ref);
      assert.equal(paragraph.page, expected.locator.page);
      assert.ok(paragraph.text.includes(expected.original_span.text), "The span must lie in the stated source paragraph.");
    }
  });
}

test("a labelled line neither keeps its separator nor absorbs the next requirement or unrelated lines", async () => {
  const raw = "Krav K-42: Sikkerhetslogger lagres i 14 måneder.\nKrav K-43: Leverandøren holder fire kurs.\nKontrollkode: VERIFIKASJON-84\nDette dokumentet inneholder kun testdata.";
  const expected = [["K-42", "Sikkerhetslogger lagres i 14 måneder."], ["K-43", "Leverandøren holder fire kurs."]];
  assert.deepEqual(await rows(raw), expected, "PDF text without page markers");
  assert.deepEqual(await rows(raw, { file_name: "krav.txt", file_format: "txt" }), expected);
  assert.deepEqual(await rows(`[[SIDE:3]]\n${raw}`), expected, "page-marked PDF text");
  assert.deepEqual((await extractRequirementLedgerForDocument(document(`[[SIDE:3]]\n${raw}`))).map(row => row.pages), [[3], [3]]);
});

test("a labelled requirement keeps sentences, wrapped lines and lists that continue it", async () => {
  assert.deepEqual(await rows("Krav K-1: Leverandøren skal levere drift. Løsningen må også støtte beredskap. Pris 100 NOK."),
    [["K-1", "Leverandøren skal levere drift. Løsningen må også støtte beredskap."]]);
  assert.deepEqual(await rows("Krav K-1: Løsningen skal, jf. kapittel 3, integreres med\nMicrosoft Azure og sikre logging.\n\nKrav K-2: Leverandøren holder fire kurs."),
    [["K-1", "Løsningen skal, jf. kapittel 3, integreres med Microsoft Azure og sikre logging."], ["K-2", "Leverandøren holder fire kurs."]]);
  const listed = await extractRequirementLedgerForDocument(document("Krav K-1: Leverandøren skal sikre følgende:\n- daglig sikkerhetskopi av data\n- varsling ved feil\nKontrollkode: X-1"));
  assert.equal(listed.length, 1);
  assert.match(listed[0].text, /daglig sikkerhetskopi.*varsling ved feil/u);
  assert.doesNotMatch(listed[0].text, /Kontrollkode/u);
});

test("citations, answers, headings and short labels stay out of the register", async () => {
  for (const raw of [
    "Leverandøren skal følge føringene i henhold til Krav K-42: logging av hendelser hele døgnet.",
    "Se Krav K-42: Sikkerhetslogger lagres i 14 måneder.",
    "Jf. Krav K-42: Sikkerhetslogger lagres i 14 måneder.",
    "Svar på Krav K-42: Vi lagrer sikkerhetslogger i 14 måneder.",
    "Krav K-42: Logging",
  ]) assert.deepEqual(await rows(raw), [], raw);
});

test("a solution document's answers do not become labelled requirements", async () => {
  const raw = "Oversikt Krav K-42: Vi lagrer sikkerhetslogger i 14 måneder.";
  const paragraph = [{ kind: "docling_text", parser: "docling", reference: "Docling text 1", text: raw, page: 1 }];
  assert.deepEqual(await rows(raw, { role: "primary_solution_document", structure_map: paragraph }), []);
  assert.deepEqual(await rows(raw, { structure_map: paragraph }), [["K-42", "Vi lagrer sikkerhetslogger i 14 måneder."]], "Control: the same paragraph in a requirement document.");
});

test("a correction chapter does not create a requirement row from its label", async () => {
  const raw = "Krav K-42: Sikkerhetslogger lagres i 14 måneder.\nKrav K-43: Leverandøren holder fire kurs.\n\n## Rettelser og presiseringer\n\nKrav K-77: Dette nummeret finnes ikke i kravspesifikasjonen fra før.";
  assert.deepEqual((await rows(raw)).map(([id]) => id).filter(id => id === "K-77"), []);
});

test("explicit tables and hierarchical rows keep their parsers, unlabelled by this path", async () => {
  const hierarchical = await rows("K-1.1 Leverandøren skal dokumentere driften.\nK-1.2 Leverandøren skal dokumentere endringer.", { file_name: "krav.txt", file_format: "txt" });
  assert.deepEqual(hierarchical.map(([id]) => id), ["K-1.1", "K-1.2"]);
  const table = await rows("| Krav-ID | Krav |\n| --- | --- |\n| K-10 | Leverandøren skal levere drift hele døgnet. |\n| K-11 | Leverandøren skal levere rapporter hver uke. |", { file_name: "krav.md", file_format: "md" });
  assert.deepEqual(table.map(([id]) => id), ["K-10", "K-11"]);
});
