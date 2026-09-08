import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const frontend = path.resolve(import.meta.dirname, "../../..");

test("solution evaluation receives opposite late artifact commitments and selects the supplied artifact over the older analysis", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "anbud-system-artifact-"));
  const state = { prompts: [], coverageCalls: 0 };
  globalThis.__systemArtifactContextTest = state;
  try {
    const completion = path.join(directory, "completion.cjs");
    const retrieval = path.join(directory, "retrieval.cjs");
    writeFileSync(completion, `exports.createJsonCompletion = async input => {
      const state = globalThis.__systemArtifactContextTest;
      if (input.promptCacheKey === "requirement-coverage-batch") {
        state.coverageCalls++;
        return { rows: [{ nr: 1, ref: "R-91", assessment: "Godt", rationale: "Leverandøren bekrefter MFA for administratorer.", evidence: "Alle administratorer bruker MFA.", recommendation: "Kontroller løsningen i akseptansetesten." }] };
      }
      if (input.promptCacheKey !== "solution-evaluation-holistic") throw new Error("Unexpected model operation: " + input.promptCacheKey);
      state.prompts.push(input);
      if (state.reply) return structuredClone(state.reply);
      throw new Error("Stop at captured model boundary; no answer generated.");
    };
    exports.getClient = () => null;
    exports.supportsCustomTemperature = () => false;`);
    writeFileSync(retrieval, `exports.retrieveDocumentSnippets = async () => [];
      exports.retrieveDocumentSnippetsWithMetadata = async () => ({ snippets: [], telemetry: { quality: { sufficient: false }, durationMs: 0 } });`);
    const load = createJiti(import.meta.url, { fsCache: false, moduleCache: false, alias: {
      "@/lib/server/ai/completion": completion, "@/lib/server/document-chunks": retrieval,
      "@": frontend, "server-only": "/dev/null",
    } });
    const { evaluateSolutionDocument } = load(path.join(frontend, "lib/server/ai.ts"));
    const { normalizeCustomerAnalysisResult } = load(path.join(frontend, "lib/server/document-intelligence/customer-analysis-postprocess.ts"));
    const customerAnalysis = normalizeCustomerAnalysisResult({ customer_profile_summary: "Lokal kunde", customer_goals_summary: "Sikker drift", executive_summary: "Eldre analyse", high_level_architecture_mermaid: "", high_level_solution_design: "Den eldre analysen foreslår MFA uten unntak for alle administratorer." });
    const document = (id, role, text) => ({ id, project_id: "fictional", title: id, role, raw_text: text, file_format: "txt", file_name: `${id}.txt`, structure_map: [] });
    const requirement = { id: "R-91", text: "Alle administratorer skal bruke MFA.", pages: [1], heading: "Sikkerhet", documentId: "customer", documentTitle: "customer" };
    const input = {
      projectName: "Fiktiv lang systemløsning", customerAnalysis, supportingDocuments: [],
      customerDocument: document("customer", "primary_customer_document", "R-91 Alle administratorer skal bruke MFA."),
      solutionDocument: document("supplier", "primary_solution_document", "R-91 Alle administratorer bruker MFA."),
      sourceRequirementLedger: [requirement],
      solutionRequirementLedger: [{ ...requirement, documentId: "supplier", documentTitle: "supplier", answerExcerpt: "Alle administratorer bruker MFA." }],
    };
    const prefix = `# Systemets løsningsutkast\n${"Generell arkitekturbeskrivelse med driftsrutiner og leveranseansvar. ".repeat(110)}\n# Tilgang og forbehold\n`;
    const commitments = ["Alle administratorer, inkludert eksterne konsulenter, skal bruke MFA.", "Eksterne konsulenter er unntatt MFA og skal bare bruke passord."];
    for (const commitment of commitments) {
      const artifact = { id: "current-artifact", title: "Oppdatert forslag", content_markdown: prefix + commitment };
      await assert.rejects(evaluateSolutionDocument({ ...input, systemSolutionArtifact: artifact }), /Stop at captured model boundary|Helhetsvurderingen feilet/);
      const prompt = state.prompts.at(-1);
      assert.ok(prompt, "The actual owner must reach its holistic model boundary.");
      assert.ok(prompt.user.includes(artifact.content_markdown), "The complete artifact, including late commitments, must reach evaluation without truncation.");
      assert.match(prompt.system, /systemartefakt.*primærgrunnlag/i);
      assert.ok(!prompt.system.includes("Sammenlign alltid mot systemets high_level_solution_design"));
      assert.ok(prompt.user.includes(customerAnalysis.high_level_solution_design), "Earlier analysis remains supporting evidence.");
    }
    assert.notEqual(state.prompts[0].user, state.prompts[1].user, "Opposite commitments must never produce identical scoring inputs.");
    await assert.rejects(evaluateSolutionDocument(input), /Stop at captured model boundary|Helhetsvurderingen feilet/);
    assert.equal(state.prompts.length, 3);
    assert.equal(state.coverageCalls, 3, "Actual requirement coverage still runs on each evaluation.");
    assert.match(state.prompts[2].system, /ingen systemartefakt.*kundeanalysen/i);
    assert.ok(!state.prompts[2].user.includes("Systemløsning som skal scores"));
    state.reply = {
      fit_to_customer_needs: "Den foreliggende planen beskriver administratorenes autentisering, men gjennomføringsbeviset må kvalitetssikres.",
      strengths: ["MFA er eksplisitt inkludert for administratorer."],
      weaknesses: ["Tilgangstesten har ennå ikke en dokumentert gjennomføring."],
      improvement_recommendations: ["Gjennomfør testen med representanter for kundens applikasjonseiere."],
      executive_summary: "Før innlevering bør teamet gjennomføre en uavhengig akseptansekontroll av identitetsplattformen og dokumentere resultatet.",
      likely_score_assessment: { quality: "Relevant leveranse", delivery_confidence: "Krever testbevis", risk: "Operativ usikkerhet", competitiveness: "Avhengig av dokumentasjon" },
      rewrite_suggestions: [{ target: "Akseptanse", suggestion: "Beskriv hvem som godkjenner autentiseringstesten og hvor resultatet lagres." }],
      document_findings: [],
      architecture_comparison: { winner: "Uavgjort", architect_solution_score: 70, system_solution_score: 70, verdict: "Begge løsninger beskriver autentisering, men akseptansen må dokumenteres.", strong_critique: ["Testbeviset mangler i begge alternativer."], pragmatic_reflections: ["Automatisert kontroll må kombineres med funksjonell akseptanse."], strategy_improvement_advice: ["Koble akseptansebevis til kundens godkjenningsprosess."] },
    };
    const exactEvidence = "Kundens applikasjonseiere godkjenner funksjonelle tester. Leverandøren gjennomfører teknisk migrering og dokumenterer resultatet.";
    const withSection = { ...input, solutionDocument: { ...input.solutionDocument, raw_text: input.solutionDocument.raw_text + "\n\n" + exactEvidence } };
    const finding = { reference: "Seksjonsfunn: Overlevering", assessment: "Uklart", finding: "Løsningen beskriver testgodkjenning, men ikke hvem som håndterer hendelser etter overlevering.", recommendation: "Avklar hendelsesansvaret mellom kundens applikasjonseiere og leverandørens driftsorganisasjon." };
    for (const evidence of [`«${exactEvidence}»`, `“${exactEvidence}”`, `"${exactEvidence}"`]) {
      state.reply.document_findings = [{ ...finding, evidence }];
      const completed = await evaluateSolutionDocument(withSection);
      assert.equal(completed.document_findings.length, 1);
      assert.equal(completed.document_findings[0].reference_match, "section", "An exact quoted section must not disappear into the fallback requirement finding.");
      assert.equal(completed.document_findings[0].evidence_grounding, "document_exact");
      assert.equal(completed.document_findings[0].evidence, evidence, "Displayed source quote remains intact.");
    }
    for (const evidence of [`«${exactEvidence.replace("godkjenner", "godkjenner ikke")}»`, "«Leverandøren lover døgnbemannet beredskap og fem minutters responstid.»"]) {
      state.reply.document_findings = [{ ...finding, evidence }];
      const completed = await evaluateSolutionDocument(withSection);
      assert.ok(completed.document_findings.every(item => item.reference_match !== "section"), "Changed assertions and fabricated quotes must not be published as grounded sections.");
      assert.equal(completed.document_findings[0].matched_requirement_reference, "R-91", "Existing grounded coverage fallback remains available.");
    }
  } finally {
    delete globalThis.__systemArtifactContextTest;
    rmSync(directory, { recursive: true, force: true });
  }
});
