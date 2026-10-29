import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const frontend = path.resolve(import.meta.dirname, "../../..");
const { createJiti } = createRequire(import.meta.url)("jiti");

test("section regeneration normalizes its own fields and preserves other manual content", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "anbud-section-isolation-"));
  const state = { patch: {} };
  globalThis.__sectionIsolationTest = state;
  try {
    const contexts = path.join(directory, "contexts.cjs");
    const completion = path.join(directory, "completion.cjs");
    writeFileSync(contexts, `exports.resolveCustomerAnalysisContexts = async ({documents}) => ({contexts: new Map(documents.map(d => [d.id, {analysisContext:d.raw_text}]))});`);
    writeFileSync(completion, `exports.runStructuredJsonResponse = async () => structuredClone(globalThis.__sectionIsolationTest.patch);`);
    const jiti = createJiti(import.meta.url, { fsCache: false, moduleCache: false, alias: {
      "@/lib/server/document-intelligence/customer-analysis-contexts": contexts,
      "@/lib/server/ai/json-completion": completion,
      "@": frontend, "server-only": "/dev/null",
    } });
    const { regenerateCustomerAnalysisSection } = jiti(path.join(frontend, "lib/server/ai.ts"));
    const { getCustomerAnalysisSectionSnapshot } = jiti(path.join(frontend, "lib/customer-analysis-history.ts"));
    const diagram = "flowchart LR\n" + Array.from({length: 10}, (_, i) => ` A${i}[Manuell ${i}] --> A${i + 1}[Manuell ${i + 1}]`).join("\n");
    const analysis = { customer_profile_summary: "Manuell kundeprofil", customer_goals_summary: "Manuelle mål", high_level_solution_design: "Manuelt design", high_level_architecture_mermaid: diagram, customer_profile: [], customer_goals: [], implicit_requirements: [], prioritized_requirements: [], ambiguities: [], risks: [], risks_for_us: [], risks_for_customer: [], likely_evaluation_criteria: [], signal_words: ["VMware"], signal_word_counts: { VMware: 7 }, expected_solution_direction: [], recommended_services: [], value_opportunities: [], positioning_recommendations: [], executive_summary: "Manuell strategi", section_histories: {} };
    const document = { id: "section-customer", project_id: "section-project", title: "Kundekrav", role: "primary_customer_document", file_name: "krav.md", file_format: "md", raw_text: "Kunden bruker Azure Backup. Azure Backup skal dekke produksjonsdata.", structure_map: [], updated_at: "2026-01-01T00:00:00Z" };
    const input = { projectName: "Syntetisk seksjonskontroll", customerDocument: document, supportingDocuments: [], serviceCandidates: [], customerAnalysis: analysis };
    const original = structuredClone(input);
    for (const section of ["summary", "keywords", "design"]) {
      state.patch = section === "summary" ? { customer_profile_summary: "Oppdatert kundeprofil", customer_goals_summary: "Oppdaterte mål", high_level_architecture_mermaid: "flowchart LR\n X --> Y" }
        : section === "keywords" ? { signal_words: ["Azure Backup"] }
        : { high_level_solution_design: "Oppdatert design", high_level_architecture_mermaid: diagram };
      const result = await regenerateCustomerAnalysisSection({ ...input, section });
      const owned = new Set([...Object.keys(getCustomerAnalysisSectionSnapshot(analysis, section)), "section_histories"]);
      for (const key of new Set([...Object.keys(analysis), ...Object.keys(result)])) {
        if (!owned.has(key)) assert.deepEqual(result[key], analysis[key], `${section} changed ${key}`);
      }
      if (section === "summary") assert.equal(result.customer_profile_summary, "Oppdatert kundeprofil");
      if (section === "keywords") assert.deepEqual(result.signal_word_counts, { "Azure Backup": 2 });
      if (section === "design") assert.notEqual(result.high_level_architecture_mermaid, diagram, "design still normalizes its own generated diagram");
      assert.deepEqual(input, original, "generation must not mutate caller input");
    }
    for (const marker of ["【assistant to=system", "<|start|>assistant analysis code"]) {
      state.patch = { executive_summary: "Kildestøttet strategi.", positioning_recommendations: [`Bevar 20 arbeidsdager.${marker} ugyldig modelltekst`] };
      await assert.rejects(regenerateCustomerAnalysisSection({ ...input, section: "strategy" }), /ugyldige kontrollmarkører/);
      assert.deepEqual(input, original);
    }
    state.patch = { executive_summary: "Kilden omtaler uttrykket assistant to=system som et eksempel.", positioning_recommendations: [] };
    await regenerateCustomerAnalysisSection({ ...input, section: "strategy" });
    const oldCorruptStrategy = { ...analysis, positioning_recommendations: ["Gammel tekst.【assistant to=system gammel støy"] };
    state.patch = { customer_profile_summary: "Ny ren kundeprofil", customer_goals_summary: "Nye mål" };
    const unrelated = await regenerateCustomerAnalysisSection({ ...input, customerAnalysis: oldCorruptStrategy, section: "summary" });
    assert.equal(unrelated.customer_profile_summary, "Ny ren kundeprofil");
    assert.deepEqual(unrelated.positioning_recommendations, oldCorruptStrategy.positioning_recommendations);
  } finally {
    delete globalThis.__sectionIsolationTest;
    rmSync(directory, { recursive: true, force: true });
  }
});
