import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
const root = path.resolve(import.meta.dirname, "../../..");
const load = createJiti(import.meta.url, { alias: { "@": root, "server-only": "/dev/null" } });
const { parsePersistedRequirementRegister } = load("./repository.ts");
const { parseProjectRequirementRegister } = load(path.join(root, "lib/project-requirement-register.ts"));
const snapshot = { projectId: "project-one", documentId: "document-one", sourceRevision: 2 };
const artifact = (extra = {}) => ({ ...snapshot, requirementRegister: { version: 1, rows: [
  { id: "K-4.1", text: "Kundedata skal behandles i Norge.", heading: "4 Sikkerhet", pages: [3], documentId: snapshot.documentId, idOrigin: "source" },
  { id: "K-4.1", text: "Logger skal kunne eksporteres.", heading: "5 Drift", pages: [5], documentId: snapshot.documentId, idOrigin: "inferred", originalId: "Tekstkrav-01" },
] }, ...extra });
test("a persisted register preserves repeated rows, inferred identity and explicit source pages", () => {
  const rows = parsePersistedRequirementRegister(artifact(), snapshot);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(row => row.pages), [[3], [5]]);
  assert.equal(rows[1].originalId, "Tekstkrav-01");
  assert.equal(rows[1].idOrigin, "inferred");
  assert.equal(parsePersistedRequirementRegister({ ...snapshot }, snapshot), null, "legacy artifacts explicitly lack a register");
});
test("stale, foreign or corrupted persisted registers cannot act as an empty register", () => {
  for (const value of [null, artifact({ sourceRevision: 1 }), artifact({ projectId: "other" }), artifact({ documentId: "other" }),
    artifact({ requirementRegister: { version: 3, rows: [] } }), artifact({ requirementRegister: { version: 1, rows: [{ id: "K-1" }] } }),
    artifact({ requirementRegister: { version: 1, rows: [{ ...artifact().requirementRegister.rows[0], documentId: "other" }] } }),
    artifact({ requirementRegister: { version: 1, rows: [{ ...artifact().requirementRegister.rows[0], pages: [0] }] } })]) {
    assert.throws(() => parsePersistedRequirementRegister(value, snapshot), /kravregister|dokumentversjonen/iu);
  }
});
test("the browser payload parser rejects malformed evidence instead of casting unknown JSON", () => {
  const valid = { source_revision: 3, documents: [{ id: "doc", title: "Bilag 1", source_revision: 2, document_ready: false, register_available: true,
    rows: [{ id: "K-1", text: "Kravtekst", heading: "Drift", pages: [2], id_origin: "source" }] }] };
  assert.deepEqual(parseProjectRequirementRegister(valid), valid);
  const broken = structuredClone(valid); broken.documents[0].rows[0].pages = ["2"];
  assert.throws(() => parseProjectRequirementRegister(broken), /kravrad/iu);
  assert.throws(() => parseProjectRequirementRegister({ documents: [] }), /format/iu);
});

test("wording provenance survives storage and legacy ID provenance never implies observed wording", () => {
  const { annotateRequirementTextProvenance } = load("../requirements/ingestion-register.ts");
  const original = "K-1\nData skal\nlagres i Norge.\nK-2\nLogger skal eksporteres.";
  const rows = annotateRequirementTextProvenance([
    { id: "K-1", text: "Data skal lagres i Norge.", heading: "Data", pages: [], idOrigin: "source" },
    { id: "K-2", text: "Logger skal eksporteres hver dag.", heading: "Data", pages: [], idOrigin: "source" },
  ], original);
  const parsed = parsePersistedRequirementRegister({ ...snapshot, requirementRegister: { version: 2, rows } }, snapshot);
  assert.equal(parsed[0].textOrigin, "observed");
  assert.equal(parsed[0].textEvidence.originalText, "Data skal\nlagres i Norge.");
  assert.equal(original.slice(parsed[0].textEvidence.start, parsed[0].textEvidence.end), parsed[0].textEvidence.originalText);
  assert.equal(parsed[1].textOrigin, "reconstructed");
  assert.equal(parsed[1].textEvidence, undefined);
  assert.equal(parsePersistedRequirementRegister(artifact(), snapshot)[0].textOrigin, "unknown");
  rows[0].textEvidence.end++;
  assert.throws(() => parsePersistedRequirementRegister({ ...snapshot, requirementRegister: { version: 2, rows } }, snapshot), /opprinnelse/u);
});

test("an observed row shows the source's own characters and keeps its span, without changing what matches", () => {
  const { annotateRequirementTextProvenance } = load("../requirements/ingestion-register.ts");
  const original = "K-4.1.1 Tjenesten skal bemannes\nmellom 06:00–22:00 alle dager.\nK-6.2 Rapporter leveres ukentlig.";
  const normalized = "Tjenesten skal bemannes mellom 06:00-22:00 alle dager.";
  const rows = annotateRequirementTextProvenance([
    { id: "K-4.1.1", text: normalized, heading: "Drift", pages: [1], idOrigin: "source" },
    { id: "K-6.2", text: "Rapporter leveres ukentlig.", heading: "Drift", pages: [1], idOrigin: "source" },
  ], original);
  assert.equal(rows[0].text, "Tjenesten skal bemannes mellom 06:00–22:00 alle dager.");
  assert.equal(rows[0].textOrigin, "observed");
  assert.equal(rows[0].textEvidence.originalText, "Tjenesten skal bemannes\nmellom 06:00–22:00 alle dager.");
  assert.equal(original.slice(rows[0].textEvidence.start, rows[0].textEvidence.end), rows[0].textEvidence.originalText);
  assert.equal(rows[1].text, "Rapporter leveres ukentlig.");
  const parsed = parsePersistedRequirementRegister({ ...snapshot, requirementRegister: { version: 2, rows } }, snapshot);
  assert.deepEqual(parsed.map(row => [row.text, row.textOrigin, row.textEvidence?.start]), rows.map(row => [row.text, row.textOrigin, row.textEvidence?.start]));
});

test("a register stored with normalized text reads with its recorded original; unrelated or unknown wording is untouched", () => {
  const evidence = { originalText: "Vakt mellom 06:00–22:00 alle dager.", start: 8, end: 43 };
  const stored = text => ({ ...snapshot, requirementRegister: { version: 2, rows: [{ id: "K-6.2", text, heading: "Drift", pages: [1], documentId: snapshot.documentId, idOrigin: "source", textOrigin: "observed", textEvidence: evidence }] } });
  assert.equal(parsePersistedRequirementRegister(stored("Vakt mellom 06:00-22:00 alle dager."), snapshot)[0].text, evidence.originalText);
  assert.equal(parsePersistedRequirementRegister(stored("Helt annen ordlyd."), snapshot)[0].text, "Helt annen ordlyd.", "A span cannot rewrite wording it does not match.");
  const legacy = parsePersistedRequirementRegister(artifact(), snapshot)[0];
  assert.equal(legacy.textOrigin, "unknown");
  assert.equal(legacy.text, "Kundedata skal behandles i Norge.");
});

test("wording that occurs with different characters is not presented as one original", () => {
  const { annotateRequirementTextProvenance } = load("../requirements/ingestion-register.ts");
  const wording = text => [{ id: "K-1", text, heading: "Drift", pages: [], idOrigin: "source" }];
  const [ambiguous] = annotateRequirementTextProvenance(wording("Vakt mellom 06:00-22:00 alle dager."), "K-1 Vakt mellom 06:00–22:00 alle dager.\nK-9 Vakt mellom 06:00-22:00 alle dager.");
  assert.equal(ambiguous.textOrigin, "reconstructed");
  assert.equal(ambiguous.textEvidence, undefined);
  assert.equal(ambiguous.text, "Vakt mellom 06:00-22:00 alle dager.");
  const [repeated] = annotateRequirementTextProvenance(wording("Vakt mellom 06:00-22:00 alle dager."), "K-1 Vakt mellom 06:00–22:00 alle dager.\nK-1 Vakt mellom 06:00–22:00 alle dager.");
  assert.equal(repeated.textOrigin, "observed", "An identical repeat has one wording.");
  assert.equal(repeated.text, "Vakt mellom 06:00–22:00 alle dager.");
});
