import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const frontendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const jiti = createJiti(import.meta.url, { alias: { "@": frontendRoot } });
const { archivedCustomerAnalysis, parseProjectResultHistory } = jiti("./project-result-history.ts");

test("older analysis versions retain their source text and receive empty missing sections", () => {
  const snapshot = {
    customer_profile: ["Opprinnelig kundeprofil.", "Andre avsnitt."],
    customer_goals_summary: "Mål med **utheving** og kilde § 2.1.",
    high_level_architecture_mermaid: "graph TD\nA-->B",
    revision: "archived-revision",
    section_histories: { summary: [{ id: "nested" }] },
  };
  const original = structuredClone(snapshot);
  const analysis = archivedCustomerAnalysis(snapshot);
  assert.equal(analysis.customer_profile_summary, snapshot.customer_profile.join("\n\n"));
  assert.equal(analysis.customer_goals_summary, snapshot.customer_goals_summary);
  assert.equal(analysis.high_level_architecture_mermaid, snapshot.high_level_architecture_mermaid);
  assert.deepEqual(analysis.value_opportunities, []);
  assert.deepEqual(analysis.implicit_requirements, []);
  assert.equal(analysis.revision, undefined);
  assert.equal(analysis.section_histories, undefined);
  assert.deepEqual(snapshot, original);
});

test("archive retains structured risks, requirements, services and value opportunities", () => {
  const snapshot = {
    executive_summary: "Strategi",
    risks_for_us: ["Leveranserisiko"],
    implicit_requirements: [{ title: "Krav", description: "Beskrivelse", category: "Drift", importance: "Viktig", kind: "Implisitt", source_reference: "§ 4", source_excerpt: "Sitat" }],
    prioritized_requirements: [{ requirement: "Krav", priority: "Kritisk", reason: "Sikkerhet" }],
    recommended_services: [{ service_id: "service-1", service_name: "Drift", usefulness_percent: 80, customer_need: "Behov", recommendation_reason: "Begrunnelse", evidence: "§ 4", risk_or_caveat: "Avklaring" }],
    value_opportunities: [{ title: "Verdi", description: "Beskrivelse", value_categories: ["Redusert risiko"], profit_share_percent: 100 }],
  };
  const analysis = archivedCustomerAnalysis(snapshot);
  for (const key of Object.keys(snapshot)) assert.deepEqual(analysis[key], snapshot[key]);
});

test("invalid archive formats give an actionable error rather than crashing an analysis tab", () => {
  for (const snapshot of [{}, { customer_profile: "not a list" }, { executive_summary: "Text", value_opportunities: [null] }, { executive_summary: "Text", risks: [{}] }]) {
    assert.throws(() => archivedCustomerAnalysis(snapshot), /Velg en annen versjon/);
  }
  assert.throws(() => parseProjectResultHistory({}), /hente den på nytt/);
  assert.throws(() => parseProjectResultHistory({ history: [{ id: "invalid" }] }), /hente den på nytt/);
  assert.deepEqual(parseProjectResultHistory({ history: [] }), []);
});

test("history parsing preserves server ordering, identity and result kind", () => {
  const entries = ["newer", "older"].map((id) => ({ id, kind: "customer_analyses", archived_at: "2026-09-09T10:00:00Z", reason: "replaced", result_json: { executive_summary: id } }));
  assert.deepEqual(parseProjectResultHistory({ history: entries }), entries);
});
