import { readFileSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
export function supplementalRetrievalFixtures(root, documentUuid, offset) {
  const labels = JSON.parse(readFileSync(path.join(root, "test-data/rag-retrieval/supplemental-cases.json"), "utf8"));
  const corpus = JSON.parse(readFileSync(path.join(root, "test-data/document-analysis-stress/corpus.json"), "utf8"));
  const frozen = JSON.parse(readFileSync(path.join(root, "test-data/rag-retrieval/halandsvik-parser-snapshot.json"), "utf8"));
  for (const document of frozen.documents) {
    const hash = createHash("sha256").update(readFileSync(path.join(root, document.source_file))).digest("hex");
    if (hash !== document.source_sha256) throw new Error("Tender parser snapshot is stale; regenerate and review it explicitly.");
  }
  const stressDocuments = corpus.documents.map(document => {
    const structure_map = document.pages.flatMap((page, index) => page.blocks.map(block => ({ reference: block.label, text: block.text ?? [block.columns?.join(" | "), ...(block.rows ?? []).map(row => Array.isArray(row) ? row.join(" | ") : Object.values(row).join(" | "))].filter(Boolean).join("\n"), page: index + 1, heading_path: [block.label] })));
    return { key: document.id, role: "primary_customer_document", supporting_subtype: null, title: document.title, file_name: `${document.id}.txt`, file_format: "txt",
      raw_text: document.pages.map((_page, index) => `[[SIDE:${index + 1}]]\n${structure_map.filter(section => section.page === index + 1).map(section => `${section.reference}\n${section.text}`).join("\n\n")}`).join("\n\n"), structure_map };
  });
  const documents = [...stressDocuments, ...frozen.documents].map((document, index) => ({ ...document, id: documentUuid(offset + index), project_id: "00000000-0000-4000-8000-000000000001", chunk_source_revision: 0 }));
  const byKey = new Map(documents.map(document => [document.key, document]));
  const questionCase = (item, kind) => {
    const document = byKey.get(item.document);
    const section = document?.structure_map.find(section => section.page === item.page && section.reference === item.heading);
    if (!section?.text) throw new Error(`Missing labelled source block: ${item.document}/${item.heading}`);
    return { kind, question: item.question, previous_question: item.previous_question, expected_requirement_id: `${item.document}:${item.heading}`, expected_source_ids: [document.id], expected_texts: [section.text.slice(0, 100)], expected_page: item.page, expected_heading: item.heading };
  };
  const fasit = JSON.parse(readFileSync(path.join(root, "test-data/tenders/halandsvik-2026/fasit.json"), "utf8"));
  const tender = byKey.get("halandsvik-02");
  const tenderCases = fasit.requirements.filter(item => !item.superseded).map(item => ({ kind: "tender_ids", question: `Hva krever Hålandsvik i ${item.id}?`, expected_requirement_id: item.id, expected_texts: [item.verbatim_text.slice(0, 90)], expected_source_ids: [tender.id], expected_page: item.page }));
  const customer = byKey.get("halandsvik-01");
  const amendments = [
    { kind: "amendment", question: "Hva er gjeldende tilbudsfrist i Hålandsvik etter rettelsen?", expected_requirement_id: "amended-deadline", expected_texts: ["til 10. november 2026 kl. 12:00"], expected_source_ids: [customer.id], expected_page: 4 },
    { kind: "amendment", question: "Hva er gjeldende RTO og RPO i Hålandsviks krav K-4.1.2 etter rettelsen?", expected_requirement_id: "K-4.1.2", expected_texts: [fasit.requirements.find(item => item.id === "K-4.1.2").current_text], expected_source_ids: [customer.id], expected_page: 4 },
  ];
  const cases = [...labels.stress.map(item => questionCase(item, "stress")), ...labels.follow_ups.map(item => questionCase(item, "follow_up")), ...tenderCases, ...amendments,
    ...labels.missing_ids.map(id => ({ kind: "missing_id", question: `Hva er ordlyden i krav ${id}?`, expected_requirement_id: id, expected_abstention: true, expected_texts: [] }))];
  return { version: labels.version, documents, cases };
}
