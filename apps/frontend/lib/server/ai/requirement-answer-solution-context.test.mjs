import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const frontend = path.resolve(import.meta.dirname, "../../..");

test("requirement answers see the whole solution document, including late reservations", async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "anbud-kravsvar-solution-"));
  const state = { batches: [], retrievals: [] };
  globalThis.__kravsvarSolutionContextTest = state;
  t.after(() => {
    delete globalThis.__kravsvarSolutionContextTest;
    rmSync(directory, { recursive: true, force: true });
  });
  const completion = path.join(directory, "completion.cjs");
  const retrieval = path.join(directory, "retrieval.cjs");
  writeFileSync(completion, `exports.createJsonCompletion = async (input) => {
    const state = globalThis.__kravsvarSolutionContextTest;
    if (input.promptCacheKey !== "requirement-response-batch") throw new Error("Stop after the answer batch: " + input.promptCacheKey);
    state.batches.push(input.user);
    throw new Error("Stop at captured model boundary.");
  };
  exports.getClient = () => null;
  exports.supportsCustomTemperature = () => false;`);
  writeFileSync(retrieval, `exports.retrieveDocumentSnippets = async (input) => {
    globalThis.__kravsvarSolutionContextTest.retrievals.push((input.documents ?? []).map((document) => document.id));
    return [];
  };
  exports.retrieveDocumentSnippetsWithMetadata = async (input) => {
    globalThis.__kravsvarSolutionContextTest.retrievals.push((input.documents ?? []).map((document) => document.id));
    return { snippets: [], telemetry: { quality: { sufficient: false }, durationMs: 0 } };
  };`);
  const load = createJiti(import.meta.url, {
    fsCache: false,
    moduleCache: false,
    alias: {
      "@/lib/server/ai/completion": completion,
      "@/lib/server/document-chunks": retrieval,
      "@": frontend,
      "server-only": "/dev/null",
    },
  });
  const { generateProjectArtifact } = load(path.join(frontend, "lib/server/ai.ts"));
  const document = (id, role, text, extra = {}) => ({
    id,
    project_id: "fictional",
    title: id,
    role,
    supporting_subtype: null,
    raw_text: text,
    file_format: "txt",
    file_name: `${id}.txt`,
    structure_map: [],
    processing_status: "enhanced_ready",
    ...extra,
  });
  const customer = document(
    "customer",
    "primary_customer_document",
    Array.from({ length: 8 }, (_, index) =>
      `K-${index + 1} Leverandøren skal dokumentere kontroll nummer ${index + 1} for driften av plattformen.`).join("\n"),
  );
  const reservation = "Kundestyrte nøkler inngår ikke i fastprisen og prises som tilleggsopsjon.";
  const run = async (solutionText) => {
    state.batches = [];
    state.retrievals = [];
    await assert.rejects(
      generateProjectArtifact({
        artifactType: "forbedret_kravsvar",
        projectName: "Fiktivt anbud",
        customerAnalysis: null,
        solutionEvaluation: null,
        customerDocument: customer,
        solutionDocument: document("solution", "primary_solution_document", solutionText),
        supportingDocuments: [],
        requirementDocuments: [customer],
        knowledgeArtifacts: [],
      }),
    );
    return state;
  };

  // Past the 1 200-character summary the answers used to receive.
  const filler = "Plattformen driftes med dokumenterte rutiner og fast ansvar for endringer. ".repeat(30);
  const fitting = await run(`${filler}\n${reservation}`);
  assert.ok(fitting.batches.length > 0, "The answer batch must reach its model boundary.");
  assert.ok(fitting.batches.every((prompt) => prompt.includes(reservation)));
  assert.ok(fitting.retrievals.length > 0);
  assert.ok(fitting.retrievals.every((ids) => !ids.includes("solution")), "A whole document is not retrieved again.");

  // A document too long for the prompt is searched for each batch instead.
  const long = await run(`${filler.repeat(25)}\n${reservation}`);
  assert.ok(long.batches.length > 0);
  assert.ok(long.batches.every((prompt) => !prompt.includes(reservation)));
  // Only searched passages are added; the requirement rows are already in the prompt.
  assert.ok(long.batches.every((prompt) => !prompt.includes("Eksakte kravradutdrag")));
  // Each of the eight requirements gets its own search of the solution document.
  assert.ok(long.retrievals.filter((ids) => ids.length === 1 && ids[0] === "solution").length >= 8);
});

test("answer evidence keeps a word-for-word quote from the solution document", () => {
  const load = createJiti(import.meta.url, { alias: { "@": frontend, "server-only": "/dev/null" } });
  const { requirementAnswerEvidence } = load(path.join(frontend, "lib/server/requirements/source-ledger.ts"));
  const entry = { id: "K-5.3", text: "Kommunen bør kunne forvalte egne krypteringsnøkler.", pages: [2], heading: "5 Sikkerhet" };
  const solution = "Data krypteres med plattformstyrte nøkler. Kundestyrte nøkler (Azure Key Vault Managed HSM) inngår ikke i fastprisen og prises som tilleggsopsjon.";
  const quote = "Kundestyrte nøkler (Azure Key Vault Managed HSM) inngår ikke i fastprisen og prises som tilleggsopsjon.";
  assert.equal(requirementAnswerEvidence(entry, quote, solution), quote);
  const labelled = `Løsningsnotat Atea, «Kryptering»: «${quote.slice(0, -1)}». Kravet ber om kundestyrte nøkler.`;
  assert.equal(requirementAnswerEvidence(entry, labelled, solution), labelled);
  // A real section title cannot carry an invented claim.
  const titled = "Løsningsnotat Atea, «Data krypteres med plattformstyrte nøkler»: «Kommunen forvalter egne nøkler uten tilleggspris.»";
  assert.notEqual(requirementAnswerEvidence(entry, titled, solution), titled);

  // A quoted section title is a label, not evidence for the claim after it.
  for (const labelledClaim of [
    "Løsningsnotat, «Data krypteres med plattformstyrte nøkler»: Atea leverer kundestyrte nøkler inkludert i fastprisen.",
    "Løsningsnotat, «Data krypteres med plattformstyrte nøkler»: «Inngår i fastpris»",
  ]) {
    assert.notEqual(requirementAnswerEvidence(entry, labelledClaim, solution), labelledClaim);
  }

  // Every quotation counts, also a short one beside a real passage.
  const padded = `«${quote}» «inkludert i fastprisen»`;
  assert.notEqual(requirementAnswerEvidence(entry, padded, solution), padded);
  const shortReal = `«${quote}» «plattformstyrte nøkler»`;
  assert.equal(requirementAnswerEvidence(entry, shortReal, solution), shortReal);

  // A long verified passage is cut after a complete quotation, so the shown
  // evidence still checks out when it is rendered.
  const longSolution = `${"Plattformen driftes med dokumenterte rutiner. ".repeat(6)}${solution}`;
  const longEvidence = `Løsningsnotat: «${"Plattformen driftes med dokumenterte rutiner. ".repeat(4).trim()}» og «${quote}»`;
  const bounded = requirementAnswerEvidence(entry, longEvidence, longSolution);
  assert.ok(bounded.length <= 262 && bounded.endsWith("» …"), bounded);
  assert.equal(requirementAnswerEvidence(entry, bounded, longSolution), bounded);

  // A paraphrase of the requirement is not the supplier's reservation.
  const attendance = { id: "K-4.2.2", text: "Leverandøren skal kunne stille med tekniker fysisk på Hålandsvik rådhus innen 4 timer ved kritiske hendelser, hele døgnet.", pages: [2], heading: "4.2" };
  const reservation = "Forbehold: Atea har ikke lokal tilstedeværelse i Hålandsvik. Fysisk oppmøte på rådhuset kan tilbys innen 4 timer på hverdager kl. 07:00–17:00.";
  for (const paraphrase of [
    "Løsningsnotat, «Hendelseshåndtering»: «Atea stiller med tekniker fysisk på Hålandsvik rådhus innen 4 timer ved kritiske hendelser, hele døgnet.»",
    "Løsningsnotat, «Hendelseshåndtering»: «Atea stiller med tekniker fysisk på Hålandsvik rådhus innen 2 timer ved kritiske hendelser, hele døgnet.»",
  ]) {
    assert.notEqual(requirementAnswerEvidence(attendance, paraphrase, reservation), paraphrase);
  }
  const storage = { id: "K-3.1.1", text: "Alle kundedata, inkludert sikkerhetskopier og logger, skal lagres og behandles i datasentre innenfor EØS.", pages: [1], heading: "3" };
  const altered = "Bilag 1, K-3.1.1: «Alle kundedata, inkludert sikkerhetskopier og logger, skal lagres og behandles i datasentre utenfor EØS.»";
  assert.notEqual(requirementAnswerEvidence(storage, altered, reservation), altered);
  // A word-for-word quote of the requirement row remains valid evidence.
  const quoted = "Bilag 1, K-3.1.1: «Alle kundedata, inkludert sikkerhetskopier og logger, skal lagres og behandles i datasentre innenfor EØS.»";
  assert.equal(requirementAnswerEvidence(storage, quoted, reservation), quoted);
  // An invented passage is replaced by the requirement source.
  assert.notEqual(requirementAnswerEvidence(entry, "Atea leverer kundestyrte nøkler uten tillegg i prisen.", solution), "Atea leverer kundestyrte nøkler uten tillegg i prisen.");
  assert.notEqual(requirementAnswerEvidence(entry, quote), quote);
});

test("answers keep binding downtime and price conditions without a 'not quantified' disclaimer", () => {
  const load = createJiti(import.meta.url, { alias: { "@": frontend, "server-only": "/dev/null" } });
  const { normalizeRequirementAnswerResult } = load(path.join(frontend, "lib/server/requirements/answer-quality.ts"));
  const migration = { id: "K-6.2", text: "Leverandøren bør gjennomføre migreringen uten nedetid for kritiske fagsystemer i kommunens åpningstid (08:00–15:30).", pages: [3], heading: "6 Overgang" };
  const storage = { id: "K-3.1.3", text: "Leverandøren bør tilby lagring i datasentre i Norge for særlige kategorier av personopplysninger, uten tillegg i pris.", pages: [1], heading: "3 Plattform" };
  const migrationAnswer = normalizeRequirementAnswerResult("Atea gjennomfører migreringen i helgevinduer, slik at kritiske fagsystemer ikke har nedetid i åpningstiden 08:00–15:30.", migration);
  const storageAnswer = normalizeRequirementAnswerResult("Atea lagrer alle kundedata i Norway East og Norway West, og lagring i Norge inngår i fastprisen.", storage);
  assert.doesNotMatch(migrationAnswer.answer, /ikke tallfestet/u);
  assert.doesNotMatch(storageAnswer.answer, /budsjett-, betalings- eller fristverdier/u);
});

test("the full-document fallback keeps a quote from the solution document as evidence", () => {
  const load = createJiti(import.meta.url, { alias: { "@": frontend, "server-only": "/dev/null" } });
  const { alignRequirementRowsWithLedger } = load(path.join(frontend, "lib/server/ai.ts"));
  const entry = { id: "K-5.3", text: "Kommunen bør kunne forvalte egne krypteringsnøkler.", pages: [2], heading: "5 Sikkerhet", documentTitle: "Bilag 1" };
  const solution = "Kundestyrte nøkler (Azure Key Vault Managed HSM) inngår ikke i fastprisen og prises som tilleggsopsjon.";
  const evidence = `Løsningsnotat: «${solution}»`;
  const table = [
    "| Kravref. | Krav | Svar | Svargrunnlag | Kildegrunnlag |",
    "| --- | --- | --- | --- | --- |",
    `| K-5.3 | ${entry.text} | Kundestyrte nøkler prises som tilleggsopsjon. | ${evidence} | Bilag 1 |`,
  ].join("\n");
  assert.match(alignRequirementRowsWithLedger(table, [entry], solution), /Managed HSM\) inngår ikke i fastprisen/u);
  assert.doesNotMatch(alignRequirementRowsWithLedger(table, [entry]), /Managed HSM\) inngår ikke i fastprisen/u);
});

test("repairs of answers to a long solution document see its searched passages", async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "anbud-kravsvar-repair-"));
  const state = { handoffs: [] };
  globalThis.__kravsvarRepairContextTest = state;
  t.after(() => {
    delete globalThis.__kravsvarRepairContextTest;
    rmSync(directory, { recursive: true, force: true });
  });
  const passage = "Kundestyrte nøkler (Azure Key Vault Managed HSM) inngår ikke i fastprisen og prises som tilleggsopsjon.";
  const completion = path.join(directory, "completion.cjs");
  const retrieval = path.join(directory, "retrieval.cjs");
  writeFileSync(completion, `exports.createJsonCompletion = async (input) => {
    if (input.promptCacheKey === "requirement-response-batch") return { rows: [] };
    if (input.promptCacheKey === "requirement-response-handoff") {
      globalThis.__kravsvarRepairContextTest.handoffs.push(input.user);
      throw new Error("Stop at captured repair boundary.");
    }
    throw new Error("Unexpected model operation: " + input.promptCacheKey);
  };
  exports.getClient = () => null;
  exports.supportsCustomTemperature = () => false;`);
  writeFileSync(retrieval, `const hit = (document) => ({ id: "hit", text: ${JSON.stringify(passage)}, documentId: document.id, documentTitle: document.title, pageStart: 1, pageEnd: 1, headingPath: [], score: 1 });
  exports.retrieveDocumentSnippets = async (input) => (input.documents ?? []).filter((document) => document.id === "solution").map(hit);
  exports.retrieveDocumentSnippetsWithMetadata = async () => ({ snippets: [], telemetry: { quality: { sufficient: false }, durationMs: 0 } });`);
  const load = createJiti(import.meta.url, {
    fsCache: false,
    moduleCache: false,
    alias: { "@/lib/server/ai/completion": completion, "@/lib/server/document-chunks": retrieval, "@": frontend, "server-only": "/dev/null" },
  });
  const { generateProjectArtifact } = load(path.join(frontend, "lib/server/ai.ts"));
  const document = (id, role, text) => ({ id, project_id: "fictional", title: id, role, supporting_subtype: null, raw_text: text, file_format: "txt", file_name: `${id}.txt`, structure_map: [], processing_status: "enhanced_ready" });
  const customer = document(
    "customer",
    "primary_customer_document",
    Array.from({ length: 8 }, (_, index) => `K-${index + 1} Leverandøren skal dokumentere kontroll nummer ${index + 1} for driften av plattformen.`).join("\n"),
  );
  const longSolution = `${"Plattformen driftes med dokumenterte rutiner og fast ansvar for endringer. ".repeat(750)}\n${passage}`;
  await generateProjectArtifact({
    artifactType: "forbedret_kravsvar",
    projectName: "Fiktivt anbud",
    customerAnalysis: null,
    solutionEvaluation: null,
    customerDocument: customer,
    solutionDocument: document("solution", "primary_solution_document", longSolution),
    supportingDocuments: [],
    requirementDocuments: [customer],
    knowledgeArtifacts: [],
  }).catch(() => undefined);
  assert.ok(state.handoffs.length > 0, "Missing answers must reach the repair handoff.");
  assert.ok(state.handoffs.every((prompt) => prompt.includes(passage)));
});
