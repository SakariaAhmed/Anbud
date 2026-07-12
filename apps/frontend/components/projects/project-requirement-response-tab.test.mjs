import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createJiti } from "jiti";

const frontendRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const jiti = createJiti(path.join(frontendRoot, "requirement-response-ui-tests.cjs"), {
  alias: { "@": frontendRoot },
  interopDefault: true,
});
const { requirementResponseRequirementCount } = await jiti.import(
  path.join(frontendRoot, "lib/requirement-response-count.ts"),
);
const {
  deterministicControlPatternLabel,
  deterministicRepairStageLabel,
  requirementResponseArtifactMetadata,
  requirementResponseManualReviewBadgeLabel,
  shouldShowDeterministicRepairAcknowledgement,
} = await jiti.import(
  path.join(frontendRoot, "lib/requirement-response-metadata.ts"),
);
const { splitMarkdownTableRow } = await jiti.import(
  path.join(frontendRoot, "lib/markdown-table-row.ts"),
);
const {
  canStartRequirementResponseGeneration,
  isRequirementDocument,
  requirementDocumentIdsForGeneration,
} = await jiti.import(
  path.join(frontendRoot, "lib/document-processing.ts"),
);

test("generation stays disabled until selected document ingestion is ready", () => {
  for (const processing_status of ["queued", "processing", "failed"]) {
    assert.equal(
      canStartRequirementResponseGeneration(
        [{ processing_status }],
        { uploadBusy: false, generateBusy: false },
      ),
      false,
    );
  }
  assert.equal(
    canStartRequirementResponseGeneration(
      [{ processing_status: "basic_ready" }],
      { uploadBusy: false, generateBusy: false },
    ),
    true,
  );
  assert.equal(
    canStartRequirementResponseGeneration(
      [{ processing_status: "enhanced_ready" }],
      { uploadBusy: true, generateBusy: false },
    ),
    false,
  );
  assert.equal(
    canStartRequirementResponseGeneration(
      [
        { processing_status: "enhanced_ready" },
        { processing_status: "processing" },
      ],
      { uploadBusy: false, generateBusy: false },
    ),
    false,
  );
});

test("all ready classified requirement documents are sent in source order", () => {
  const base = {
    role: "supporting_document",
    supporting_subtype: "kravdokument",
    title: "Kravdel",
    file_name: "krav.pdf",
    processing_status: "enhanced_ready",
  };
  const documents = [
    { ...base, id: "requirements-a", title: "Kravdel A" },
    { ...base, id: "requirements-b", title: "Kravdel B" },
    {
      ...base,
      id: "pending-requirements",
      processing_status: "processing",
    },
    {
      ...base,
      id: "solution",
      role: "primary_solution_document",
      supporting_subtype: null,
      title: "Arkitektløsning",
      file_name: "solution.pdf",
    },
  ];

  assert.deepEqual(requirementDocumentIdsForGeneration(documents), [
    "requirements-a",
    "requirements-b",
  ]);
});

test("a demoted historical solution is excluded even when its metadata says krav", () => {
  assert.deepEqual(
    requirementDocumentIdsForGeneration([
      {
        id: "historical-solution",
        role: "supporting_document",
        supporting_subtype: "tidligere_losning",
        title: "Bilag 2 - Krav og svar",
        file_name: "kravsvar.md",
        processing_status: "enhanced_ready",
      },
    ]),
    [],
  );
});

test("underscore Bilag 1 is visible as an implicit customer source but is not submitted as a formal selection", () => {
  const customer = {
    id: "customer",
    role: "primary_customer_document",
    supporting_subtype: null,
    title: "054_Bilag_1_NaboOmsorg_Koordinering_SA",
    file_name: "054_Bilag_1_NaboOmsorg_Koordinering_SA.pdf",
    processing_status: "enhanced_ready",
  };
  const formal = {
    id: "formal",
    role: "supporting_document",
    supporting_subtype: "kravdokument",
    title: "054_Bilag_2_Krav_NaboOmsorg_Koordinering_SA",
    file_name: "054_Bilag_2_Krav_NaboOmsorg_Koordinering_SA.pdf",
    processing_status: "enhanced_ready",
  };

  assert.equal(isRequirementDocument(customer), true);
  assert.deepEqual(requirementDocumentIdsForGeneration([customer, formal]), [
    formal.id,
  ]);
});

test("escaped pipes stay inside all five requirement response columns", () => {
  const row = String.raw`| K\|1 | Krav med A\|B og C:\\temp | Svar med X\|Y | Bevis \| detalj | Kilde \| kapittel |`;

  assert.deepEqual(splitMarkdownTableRow(row), [
    "K|1",
    String.raw`Krav med A|B og C:\\temp`,
    "Svar med X|Y",
    "Bevis | detalj",
    "Kilde | kapittel",
  ]);
});

test("only pipes preceded by an odd backslash count are escaped", () => {
  assert.deepEqual(
    splitMarkdownTableRow(String.raw`venstre\\|høyre\|fortsatt høyre`),
    [String.raw`venstre\\`, "høyre|fortsatt høyre"],
  );
  assert.deepEqual(
    splitMarkdownTableRow(String.raw`| tre\\\|backslashes |`),
    [String.raw`tre\\|backslashes`],
  );
});

test("saved response count reflects rendered requirement rows", () => {
  const markdown = [
    "## Kravbesvarelse",
    "",
    "| Kravref. | Krav | Svar | Svargrunnlag | Kildegrunnlag |",
    "|---|---|---|---|---|",
    "| K-1 | Første krav | Svar | Bevis | Kilde |",
    "| K-2 | Andre krav | Svar | Bevis | Kilde |",
    "| K-3 | Tredje krav | Svar | Bevis | Kilde |",
    "| K-4 | Fjerde krav | Svar | Bevis | Kilde |",
    "| K-5 | Femte krav | Svar | Bevis | Kilde |",
  ].join("\n");

  assert.equal(requirementResponseRequirementCount(markdown, 1), 5);
});

test("saved response count is stable when table cells contain escaped pipes", () => {
  const markdown = [
    "| Kravref. | Krav | Svar | Svargrunnlag | Kildegrunnlag |",
    "|---|---|---|---|---|",
    String.raw`| K-1 | Integrasjon A\|B | Støttes via X\|Y | Arkitektur \| API | Vedlegg \| 2 |`,
    String.raw`| K-2 | Bevar C:\\temp | Oppfylt | Test \| 4 | Bilag \| 3 |`,
  ].join("\n");

  assert.equal(requirementResponseRequirementCount(markdown, 99), 2);
});

test("saved response count falls back to ledger metadata without a rendered table", () => {
  assert.equal(requirementResponseRequirementCount("Kort fritekstsvar", 3), 3);
  assert.equal(requirementResponseRequirementCount("Kort fritekstsvar"), undefined);
});

test("manual-review metadata exposes template repair count, refs, and note", () => {
  const metadata = requirementResponseArtifactMetadata({
    generation_metadata: {
      requirement_response: {
        deterministic_template_repair_answers: 2,
        deterministic_template_repair_refs: ["K-002", " K-009 "],
        manual_review_required: true,
        manual_review_note:
          "Standardformuleringene krever manuell gjennomgang før innlevering.",
      },
    },
  });

  assert.equal(metadata.manualReviewRequired, true);
  assert.equal(metadata.templateRepairCount, 2);
  assert.deepEqual(metadata.templateRepairRefs, ["K-002", "K-009"]);
  assert.match(metadata.manualReviewNote, /manuell gjennomgang/u);
});

test("template repair refs fail visible even if the boolean flag is inconsistent", () => {
  const metadata = requirementResponseArtifactMetadata({
    generation_metadata: {
      requirement_response: {
        deterministic_template_repair_answers: 0,
        deterministic_template_repair_refs: ["K-004"],
        manual_review_required: false,
      },
    },
  });

  assert.equal(metadata.manualReviewRequired, true);
  assert.equal(metadata.templateRepairCount, 1);
  assert.deepEqual(metadata.templateRepairRefs, ["K-004"]);
});

test("deterministic control repairs require review and expose their exact refs", () => {
  const metadata = requirementResponseArtifactMetadata({
    generation_metadata: {
      requirement_response: {
        deterministic_control_repair_answers: 1,
        deterministic_control_repair_refs: [" R-035 "],
        deterministic_control_repair_rows: [
          {
            ref: "R-035",
            pattern: "dimensioning_supplier_baseline",
            repair_stage: "pre_handoff",
            order_index: 34,
            source_document_id: "requirements-main",
            source_locator: "Side 8, R-035",
          },
        ],
        manual_review_required: false,
      },
    },
  });

  assert.equal(metadata.manualReviewRequired, true);
  assert.equal(metadata.controlRepairCount, 1);
  assert.deepEqual(metadata.controlRepairRefs, ["R-035"]);
  assert.deepEqual(metadata.controlRepairRows, [
    {
      ref: "R-035",
      pattern: "dimensioning_supplier_baseline",
      repairStage: "pre_handoff",
      orderIndex: 34,
      sourceDocumentId: "requirements-main",
      sourceLocator: "Side 8, R-035",
    },
  ]);
  assert.equal(
    deterministicControlPatternLabel(metadata.controlRepairRows[0].pattern),
    "Dimensjonering og ytelse",
  );
  assert.equal(
    deterministicRepairStageLabel(metadata.controlRepairRows[0].repairStage),
    "Reparert før AI-handoff",
  );
  assert.equal(
    shouldShowDeterministicRepairAcknowledgement(metadata, false),
    false,
  );
  assert.equal(
    shouldShowDeterministicRepairAcknowledgement(metadata, true),
    true,
  );
});

test("mixed deterministic repairs and proposal input stay explicit in the review badge", () => {
  const metadata = requirementResponseArtifactMetadata({
    generation_metadata: {
      requirement_response: {
        deterministic_control_repair_answers: 10,
        deterministic_control_repair_refs: Array.from(
          { length: 10 },
          (_, index) => `K-${index + 1}`,
        ),
        proposal_input_required_count: 2,
        proposal_input_required_refs: ["K-CV", "K-PRICE"],
      },
    },
  });

  assert.equal(
    requirementResponseManualReviewBadgeLabel(metadata),
    "10 deterministisk reparerte krav · 2 med tilbudsinput",
  );
});

test("proposal input requirements remain visible even without template repair", () => {
  const metadata = requirementResponseArtifactMetadata({
    generation_metadata: {
      requirement_response: {
        deterministic_template_repair_answers: 0,
        deterministic_template_repair_refs: [],
        proposal_input_required_count: 2,
        proposal_input_required_refs: ["K-CV", " K-PRICE "],
        proposal_input_required_rows: [
          {
            ref: "K-CV",
            reasons: ["candidate_cvs", "candidate_cvs"],
            order_index: 6,
            source_document_id: "requirements-main",
            source_locator: "Side 3, K-CV",
          },
          {
            ref: "K-PRICE",
            reasons: ["commercial_terms"],
            order_index: 9,
            source_document_id: "requirements-commercial",
            source_locator: "Side 2, K-PRICE",
          },
        ],
        manual_review_required: true,
        manual_review_note:
          "Kravene trenger dokumentert leverandørbevis før innlevering.",
      },
    },
  });

  assert.equal(metadata.manualReviewRequired, true);
  assert.equal(metadata.templateRepairCount, 0);
  assert.equal(metadata.proposalInputRequiredCount, 2);
  assert.deepEqual(metadata.proposalInputRequiredRefs, ["K-CV", "K-PRICE"]);
  assert.deepEqual(metadata.proposalInputRequiredRows, [
    {
      ref: "K-CV",
      reasons: ["candidate_cvs"],
      orderIndex: 6,
      sourceDocumentId: "requirements-main",
      sourceLocator: "Side 3, K-CV",
    },
    {
      ref: "K-PRICE",
      reasons: ["commercial_terms"],
      orderIndex: 9,
      sourceDocumentId: "requirements-commercial",
      sourceLocator: "Side 2, K-PRICE",
    },
  ]);
  assert.match(metadata.manualReviewNote, /leverandørbevis/u);
});
