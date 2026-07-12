import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const frontendRoot = path.resolve(__dirname, "../../..");
const require = createRequire(import.meta.url);
const { createJiti } = require(path.join(frontendRoot, "node_modules", "jiti"));
const testSupportPath = path.join(
  frontendRoot,
  "lib/server/repositories/supabase-store.persistence.test-support.ts",
);
const storeJiti = createJiti(
  path.join(frontendRoot, "supabase-store-persistence-tests.cjs"),
  {
    interopDefault: true,
    alias: {
      "next/cache": testSupportPath,
      "@/lib/server/supabase": testSupportPath,
      "@/lib/server/file-storage": testSupportPath,
      "@/lib/server/document-chunks": testSupportPath,
      "@/lib/server/repositories/lease-fenced-persistence": testSupportPath,
      "@/lib/server/project-workflow-cancellation": testSupportPath,
      "@": frontendRoot,
      "server-only": "/dev/null",
    },
  },
);

process.env.APP_ENCRYPTION_KEY ||= "persistence-test-encryption-key";

const { decryptJson, encryptJson } = storeJiti(
  path.join(frontendRoot, "lib/server/crypto.ts"),
);
const { buildImmutableRequirementRowManifest } = storeJiti(
  path.join(frontendRoot, "lib/server/artifact-validation.ts"),
);

const {
  getProjectMutationCallsForPersistenceTest,
  getRemovedStoredFilesForPersistenceTest,
  getSolutionEvaluationMutationCallsForPersistenceTest,
  setSupabaseStorePersistenceTestClient,
  setSolutionEvaluationMutationFencedForPersistenceTest,
} = storeJiti(testSupportPath);
const {
  deleteDocument,
  getFreshSolutionEvaluation,
  listProjectDocumentsForAnalysis,
  markDocumentAsPrimarySolution,
  saveCustomerAnalysis,
  saveDocumentIngestionResult,
  savePendingDocument,
  saveSolutionEvaluation,
  sanitizeSolutionEvaluationResult,
  updateGeneratedArtifact,
} = storeJiti(
  path.join(frontendRoot, "lib/server/repositories/supabase-store.ts"),
);

const PROJECT_ID = "00000000-0000-4000-8000-000000000101";
const CUSTOMER_DOCUMENT_ID = "00000000-0000-4000-8000-000000000102";
const SOLUTION_DOCUMENT_ID = "00000000-0000-4000-8000-000000000103";
const SUPPORTING_DOCUMENT_ID = "00000000-0000-4000-8000-000000000104";
const NOW = "2026-07-10T12:00:00.000Z";

test("persisted partial evaluations are normalized to a UI-safe shape", () => {
  const normalized = sanitizeSolutionEvaluationResult({
    rewrite_suggestions: null,
    document_findings: null,
    strengths: null,
    likely_score_assessment: null,
    architecture_comparison: {
      winner: undefined,
      architect_solution_score: 140,
      system_solution_score: Number.NaN,
      verdict: undefined,
      strong_critique: null,
      pragmatic_reflections: null,
      strategy_improvement_advice: null,
    },
  });

  assert.deepEqual(normalized.rewrite_suggestions, []);
  assert.deepEqual(normalized.document_findings, []);
  assert.deepEqual(normalized.strengths, []);
  assert.deepEqual(normalized.likely_score_assessment, {
    quality: "",
    delivery_confidence: "",
    risk: "",
    competitiveness: "",
  });
  assert.deepEqual(normalized.architecture_comparison, {
    winner: "Uavgjort",
    architect_solution_score: 100,
    system_solution_score: 0,
    verdict: "",
    strong_critique: [],
    pragmatic_reflections: [],
    strategy_improvement_advice: [],
  });
});

function selectedRow(row, columns) {
  if (!columns || columns === "*") {
    return structuredClone(row);
  }
  return Object.fromEntries(
    columns.split(",").map((column) => {
      const normalized = column.trim();
      return [normalized, structuredClone(row[normalized])];
    }),
  );
}

class FakeQuery {
  constructor(database, table, operation, payload = null, options = null) {
    this.database = database;
    this.table = table;
    this.operation = operation;
    this.payload = payload;
    this.options = options;
    this.filters = [];
    this.selectedColumns = null;
    this.maximum = null;
    this.sort = null;
    this.execution = null;
    this.rawFilterColumns = [];
  }

  eq(column, value) {
    this.filters.push((row) => row[column] === value);
    return this;
  }

  neq(column, value) {
    this.filters.push((row) => row[column] !== value);
    return this;
  }

  or(expression) {
    assert.equal(
      expression,
      "supporting_subtype.neq.tidligere_losning,and(supporting_subtype.is.null,subtype.neq.tidligere_losning),and(supporting_subtype.is.null,subtype.is.null)",
      "unexpected raw PostgREST OR filter",
    );
    this.rawFilterColumns.push("supporting_subtype", "subtype");
    this.filters.push(
      (row) =>
        (row.supporting_subtype ?? row.subtype ?? null) !==
        "tidligere_losning",
    );
    return this;
  }

  order(column, options) {
    this.sort = { column, ascending: options?.ascending !== false };
    return this;
  }

  limit(maximum) {
    this.maximum = maximum;
    return this;
  }

  select(columns) {
    this.selectedColumns = columns;
    return this;
  }

  matchingRows() {
    let rows = this.database.tables[this.table].filter((row) =>
      this.filters.every((filter) => filter(row)),
    );
    if (this.sort) {
      const direction = this.sort.ascending ? 1 : -1;
      rows = [...rows].sort(
        (left, right) =>
          String(left[this.sort.column]).localeCompare(
            String(right[this.sort.column]),
          ) * direction,
      );
    }
    if (this.maximum !== null) {
      rows = rows.slice(0, this.maximum);
    }
    return rows;
  }

  insertedRow(payload) {
    this.database.nextId += 1;
    return {
      id: payload.id ?? `generated-${this.database.nextId}`,
      created_at: NOW,
      updated_at: NOW,
      ...structuredClone(payload),
    };
  }

  perform() {
    const operationRecord = {
      sequence: this.database.operations.length,
      table: this.table,
      operation: this.operation,
      payload: structuredClone(this.payload),
      options: structuredClone(this.options),
    };
    this.database.operations.push(operationRecord);

    const forcedError = this.database.operationErrors.get(
      `${this.table}:${this.operation}`,
    );
    if (forcedError) {
      return { data: null, error: forcedError };
    }

    const missingColumns = this.database.missingColumns[this.table] ?? new Set();
    const referencedColumns =
      this.operation === "select"
        ? this.selectedColumns === "*"
          ? []
          : String(this.selectedColumns ?? "")
              .split(",")
              .map((column) => column.trim())
        : Object.keys(this.payload ?? {});
    const missingColumn = [...referencedColumns, ...this.rawFilterColumns].find((column) =>
      missingColumns.has(column),
    );
    if (missingColumn) {
      return {
        data: null,
        error: {
          message: `Could not find the '${missingColumn}' column of '${this.table}' in the schema cache`,
        },
      };
    }

    if (
      this.operation === "upsert" &&
      this.table === "solution_evaluations" &&
      this.database.solutionUpsertError
    ) {
      return { data: null, error: this.database.solutionUpsertError };
    }

    let affectedRows = [];
    if (this.operation === "select") {
      affectedRows = this.matchingRows();
    } else if (this.operation === "insert") {
      const row = this.insertedRow(this.payload);
      this.database.tables[this.table].push(row);
      affectedRows = [row];
    } else if (this.operation === "upsert") {
      const conflictColumns = String(this.options?.onConflict ?? "id")
        .split(",")
        .map((column) => column.trim());
      const existing = this.database.tables[this.table].find((row) =>
        conflictColumns.every((column) => row[column] === this.payload[column]),
      );
      if (existing) {
        Object.assign(existing, structuredClone(this.payload));
        affectedRows = [existing];
      } else {
        const row = this.insertedRow(this.payload);
        this.database.tables[this.table].push(row);
        affectedRows = [row];
      }
    } else if (this.operation === "update") {
      affectedRows = this.matchingRows();
      for (const row of affectedRows) {
        Object.assign(row, structuredClone(this.payload));
      }
    } else if (this.operation === "delete") {
      affectedRows = this.matchingRows();
      const deleted = new Set(affectedRows);
      this.database.tables[this.table].splice(
        0,
        this.database.tables[this.table].length,
        ...this.database.tables[this.table].filter((row) => !deleted.has(row)),
      );
    }

    const data = this.selectedColumns
      ? affectedRows.map((row) => selectedRow(row, this.selectedColumns))
      : this.operation === "select"
        ? affectedRows.map((row) => selectedRow(row, this.selectedColumns))
        : null;
    return { data, error: null };
  }

  execute() {
    this.execution ??= Promise.resolve(this.perform());
    return this.execution;
  }

  async single() {
    const result = await this.execute();
    if (result.error) {
      return result;
    }
    return {
      data: Array.isArray(result.data) && result.data.length === 1
        ? result.data[0]
        : null,
      error: null,
    };
  }

  then(onFulfilled, onRejected) {
    return this.execute().then(onFulfilled, onRejected);
  }
}

function projectRow(overrides = {}) {
  return {
    id: PROJECT_ID,
    name: "Persistence-test",
    customer_name: "Testkunde",
    description: "Test",
    industry: "Energi",
    context_keywords: [],
    customer_document_uploaded: true,
    customer_analysis_generated: true,
    solution_document_uploaded: true,
    solution_evaluation_generated: true,
    source_revision: 0,
    last_activity_at: NOW,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function documentRow(id, role, supportingSubtype = null, overrides = {}) {
  return {
    id,
    project_id: PROJECT_ID,
    role,
    supporting_subtype: supportingSubtype,
    title: `Dokument ${id.slice(-3)}`,
    file_name: `${id.slice(-3)}.txt`,
    file_format: "txt",
    content_type: "text/plain",
    file_size_bytes: 4,
    page_count: 1,
    file_storage_bucket: "test-documents",
    file_storage_path: `projects/${PROJECT_ID}/${id}.txt`,
    file_base64: "",
    raw_text: "test",
    structure_map: [],
    processing_status: "enhanced_ready",
    processing_message: null,
    processing_error: null,
    parser_used: "test",
    indexed_at: NOW,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function evaluationRow(solutionDocumentId = SOLUTION_DOCUMENT_ID) {
  return {
    id: "evaluation-old",
    project_id: PROJECT_ID,
    source_document_ids: [CUSTOMER_DOCUMENT_ID, solutionDocumentId],
    customer_document_id: CUSTOMER_DOCUMENT_ID,
    solution_document_id: solutionDocumentId,
    analysis_id: null,
    result_json: { preserved: true },
    created_at: NOW,
    updated_at: NOW,
  };
}

function executiveSummaryRow() {
  return {
    id: "summary-old",
    project_id: PROJECT_ID,
    result_json: { preserved: true },
    input_snapshot: {},
    created_at: NOW,
    updated_at: NOW,
  };
}

function customerAnalysisInput() {
  return {
    customer_profile_summary: "Oppdatert kundeprofil",
    customer_goals_summary: "Oppdaterte kundemål",
    high_level_solution_design: "Oppdatert løsningsretning",
    high_level_architecture_mermaid: "flowchart LR\nA --> B",
    customer_profile: [],
    customer_goals: [],
    implicit_requirements: [],
    prioritized_requirements: [],
    ambiguities: [],
    risks: [],
    risks_for_us: [],
    risks_for_customer: [],
    likely_evaluation_criteria: [],
    signal_words: [],
    signal_word_counts: {},
    expected_solution_direction: [],
    recommended_services: [],
    value_opportunities: [],
    positioning_recommendations: [],
    executive_summary: "Oppdatert analyse",
    section_histories: {},
  };
}

function persistenceDatabase(overrides = {}) {
  const database = {
    nextId: 0,
    operations: [],
    operationErrors: new Map(),
    missingColumns: {},
    solutionUpsertError: null,
    primaryPromotionError: null,
    tables: {
      projects: [projectRow()],
      documents: [],
      customer_analyses: [],
      solution_evaluations: [],
      executive_summaries: [],
      generated_artifacts: [],
      ...overrides,
    },
  };
  database.client = {
    from(table) {
      assert.ok(database.tables[table], `unexpected table ${table}`);
      return {
        select(columns) {
          return new FakeQuery(database, table, "select").select(columns);
        },
        insert(payload) {
          return new FakeQuery(database, table, "insert", payload);
        },
        upsert(payload, options) {
          return new FakeQuery(database, table, "upsert", payload, options);
        },
        update(payload) {
          return new FakeQuery(database, table, "update", payload);
        },
        delete() {
          return new FakeQuery(database, table, "delete");
        },
      };
    },
    async rpc(name, args) {
      database.operations.push({
        sequence: database.operations.length,
        table: name,
        operation: "rpc",
        payload: structuredClone(args),
        options: null,
      });

      if (name === "insert_primary_project_document") {
        const forcedError = database.operationErrors.get(
          "insert_primary_project_document:rpc",
        );
        if (forcedError) {
          return { data: null, error: forcedError };
        }

        const staged = structuredClone(database.tables);
        const project = staged.projects.find(
          (row) => row.id === args.p_project_id,
        );
        if (!project) {
          return { data: null, error: { message: "Project does not exist" } };
        }
        const demotedSubtype =
          args.p_primary_role === "primary_solution_document"
            ? "tidligere_losning"
            : "rfp";
        for (const document of staged.documents) {
          if (
            document.project_id === args.p_project_id &&
            document.role === args.p_primary_role
          ) {
            document.role = "supporting_document";
            document.supporting_subtype = demotedSubtype;
            document.subtype = demotedSubtype;
          }
        }
        if (database.primaryPromotionError) {
          return { data: null, error: database.primaryPromotionError };
        }

        const inserted = {
          ...structuredClone(args.p_payload),
          project_id: args.p_project_id,
          role: args.p_primary_role,
          supporting_subtype: null,
          subtype: null,
          created_at: NOW,
          updated_at: NOW,
        };
        staged.documents.push(inserted);
        if (args.p_primary_role === "primary_customer_document") {
          staged.customer_analyses = staged.customer_analyses.filter(
            (row) => row.project_id !== args.p_project_id,
          );
          project.customer_analysis_generated = false;
        }
        staged.solution_evaluations = staged.solution_evaluations.filter(
          (row) => row.project_id !== args.p_project_id,
        );
        staged.executive_summaries = staged.executive_summaries.filter(
          (row) => row.project_id !== args.p_project_id,
        );
        project.customer_document_uploaded = staged.documents.some(
          (document) =>
            document.project_id === args.p_project_id &&
            document.role === "primary_customer_document",
        );
        project.solution_document_uploaded = staged.documents.some(
          (document) =>
            document.project_id === args.p_project_id &&
            document.role === "primary_solution_document",
        );
        project.solution_evaluation_generated = false;
        project.last_activity_at = NOW;

        for (const [table, rows] of Object.entries(staged)) {
          database.tables[table].splice(
            0,
            database.tables[table].length,
            ...rows,
          );
        }
        return { data: structuredClone(inserted), error: null };
      }

      if (name === "set_primary_project_document") {
        const forcedError = database.operationErrors.get(
          "set_primary_project_document:rpc",
        );
        if (forcedError) {
          return { data: null, error: forcedError };
        }

        const staged = structuredClone(database.tables);
        const project = staged.projects.find(
          (row) => row.id === args.p_project_id,
        );
        const target = staged.documents.find(
          (row) =>
            row.project_id === args.p_project_id &&
            row.id === args.p_document_id,
        );
        if (!project || !target) {
          return {
            data: null,
            error: { message: "PRIMARY_DOCUMENT_NOT_FOUND" },
          };
        }
        if (
          target.role !== "supporting_document" &&
          target.role !== args.p_primary_role
        ) {
          return {
            data: null,
            error: { message: "PRIMARY_DOCUMENT_ROLE_CONFLICT" },
          };
        }

        const targetAffectedCustomerAnalysis =
          target.role !== "primary_solution_document" &&
          !(
            target.role === "supporting_document" &&
            (target.supporting_subtype ?? target.subtype) ===
              "tidligere_losning"
          );
        if (target.role === args.p_primary_role) {
          project.customer_document_uploaded = staged.documents.some(
            (document) =>
              document.project_id === args.p_project_id &&
              document.role === "primary_customer_document",
          );
          project.solution_document_uploaded = staged.documents.some(
            (document) =>
              document.project_id === args.p_project_id &&
              document.role === "primary_solution_document",
          );
          project.last_activity_at = NOW;
          for (const [table, rows] of Object.entries(staged)) {
            database.tables[table].splice(
              0,
              database.tables[table].length,
              ...rows,
            );
          }
          return { data: structuredClone(target), error: null };
        }
        const demotedSubtype =
          args.p_primary_role === "primary_solution_document"
            ? "tidligere_losning"
            : "rfp";
        for (const document of staged.documents) {
          if (
            document.project_id === args.p_project_id &&
            document.role === args.p_primary_role &&
            document.id !== args.p_document_id
          ) {
            document.role = "supporting_document";
            document.supporting_subtype = demotedSubtype;
            document.subtype = demotedSubtype;
          }
        }

        if (database.primaryPromotionError) {
          return { data: null, error: database.primaryPromotionError };
        }

        target.role = args.p_primary_role;
        target.supporting_subtype = null;
        target.subtype = null;
        target.updated_at = NOW;
        if (targetAffectedCustomerAnalysis) {
          staged.customer_analyses = staged.customer_analyses.filter(
            (row) => row.project_id !== args.p_project_id,
          );
        }
        staged.solution_evaluations = staged.solution_evaluations.filter(
          (row) => row.project_id !== args.p_project_id,
        );
        staged.executive_summaries = staged.executive_summaries.filter(
          (row) => row.project_id !== args.p_project_id,
        );
        project.customer_document_uploaded = staged.documents.some(
          (document) =>
            document.project_id === args.p_project_id &&
            document.role === "primary_customer_document",
        );
        project.solution_document_uploaded = staged.documents.some(
          (document) =>
            document.project_id === args.p_project_id &&
            document.role === "primary_solution_document",
        );
        if (targetAffectedCustomerAnalysis) {
          project.customer_analysis_generated = false;
        }
        project.solution_evaluation_generated = false;
        project.last_activity_at = NOW;

        for (const [table, rows] of Object.entries(staged)) {
          database.tables[table].splice(
            0,
            database.tables[table].length,
            ...rows,
          );
        }
        return { data: structuredClone(target), error: null };
      }

      if (name === "get_artifact_source_revisions") {
        return {
          data: {
            artifact_source_revision: 4,
            service_library_revision: 7,
            solution_evaluation_dependency: null,
          },
          error: null,
        };
      }

      if (name === "get_current_project_derived_snapshot") {
        const evaluation = database.tables.solution_evaluations.find(
          (row) => row.project_id === args.p_project_id,
        );
        if (!evaluation) {
          return { data: null, error: null };
        }
        return {
          data: {
            evaluation_row: structuredClone(evaluation),
            dependency: {
              id: evaluation.id,
              updated_at: evaluation.updated_at,
              content_hash: "persistence-test-evaluation-hash",
              evaluated_generated_artifact_id:
                evaluation.evaluated_generated_artifact_id ?? null,
              provenance_mode:
                evaluation.evaluation_provenance_mode ?? "legacy_unknown",
            },
            executive_summary_row: null,
          },
          error: null,
        };
      }

      if (name === "create_manual_artifact_version") {
        const parent = database.tables.generated_artifacts.find(
          (row) =>
            row.id === args.p_parent_artifact_id &&
            row.project_id === args.p_project_id,
        );
        if (!parent) {
          return {
            data: null,
            error: { message: "ARTIFACT_PARENT_NOT_FOUND" },
          };
        }
        const created = {
          ...structuredClone(parent),
          id: `${parent.id}-manual`,
          title: args.p_payload.title,
          content_markdown: args.p_payload.content_markdown,
          input_snapshot: structuredClone(args.p_payload.input_snapshot),
          artifact_version: Number(parent.artifact_version ?? 1) + 1,
          generator_revision: args.p_payload.generator_revision,
          origin: "manual_edit",
          parent_artifact_id: parent.id,
          created_at: NOW,
          updated_at: NOW,
        };
        database.tables.generated_artifacts.push(created);
        return { data: structuredClone(created), error: null };
      }

      assert.equal(name, "save_customer_analysis_if_source_revision");
      const forcedError = database.operationErrors.get(
        "customer_analyses:upsert",
      );
      if (forcedError) {
        return { data: null, error: forcedError };
      }

      const staged = structuredClone(database.tables);
      const project = staged.projects.find(
        (row) => row.id === args.p_project_id,
      );
      if (!project) {
        return { data: null, error: { message: "Project does not exist" } };
      }
      if (
        project.source_revision !==
        args.p_payload.expected_source_revision
      ) {
        return {
          data: null,
          error: {
            message:
              "PROJECT_SOURCE_REVISION_CHANGED: project inputs changed while the analysis was running",
          },
        };
      }

      const existing = staged.customer_analyses.find(
        (row) => row.project_id === args.p_project_id,
      );
      const analysis = {
        id: existing?.id ?? `generated-${database.nextId + 1}`,
        project_id: args.p_project_id,
        source_document_ids: structuredClone(
          args.p_payload.source_document_ids,
        ),
        result_json: structuredClone(args.p_payload.result_json),
        created_at: existing?.created_at ?? NOW,
        updated_at: NOW,
      };
      staged.customer_analyses = staged.customer_analyses.filter(
        (row) => row.project_id !== args.p_project_id,
      );
      staged.customer_analyses.push(analysis);
      staged.solution_evaluations = staged.solution_evaluations.filter(
        (row) => row.project_id !== args.p_project_id,
      );
      staged.executive_summaries = staged.executive_summaries.filter(
        (row) => row.project_id !== args.p_project_id,
      );
      project.customer_analysis_generated = true;
      project.solution_evaluation_generated = false;
      project.source_revision += 1;
      project.last_activity_at = args.p_payload.last_activity_at;
      project.context_keywords = structuredClone(
        args.p_payload.context_keywords,
      );

      for (const [table, rows] of Object.entries(staged)) {
        database.tables[table].splice(
          0,
          database.tables[table].length,
          ...rows,
        );
      }
      return { data: analysis, error: null };
    },
  };
  setSupabaseStorePersistenceTestClient(database.client);
  return database;
}

function directProjectContextKeywordUpdates(database) {
  return database.operations.filter(
    (operation) =>
      operation.table === "projects" &&
      operation.operation === "update" &&
      Object.hasOwn(operation.payload ?? {}, "context_keywords"),
  );
}

function fencedProjectContextKeywordMutations() {
  return getProjectMutationCallsForPersistenceTest().filter(
    (call) => call.operation === "project_context_keywords",
  );
}

function solutionInput(overrides = {}) {
  return {
    customerDocumentId: CUSTOMER_DOCUMENT_ID,
    solutionDocumentId: SOLUTION_DOCUMENT_ID,
    expectedSourceRevision: 0,
    result: { executive_summary: "Ny gyldig vurdering" },
    ...overrides,
  };
}

function legacyRequirementCoverageResult() {
  const references = [
    "K-001",
    "K-002",
    "Side 7 krav 3",
    "K-004",
    "K-005",
    "K-006",
  ];
  return {
    requirement_coverage: {
      total_requirements: references.length,
      assessed_requirements: references.length,
      good: references.length,
      weak: 0,
      missing: 0,
      unclear: 0,
      confidence: "Høy",
      coverage_summary: "Alle krav er vurdert.",
      items: references.map((reference, index) => ({
        order_index: [1, 2, 8, 4, 5, 6][index],
        reference,
        requirement: `Krav ${index + 1}`,
        assessment: "Godt",
        rationale: "Kravet er vurdert.",
        evidence: `Svarutdrag for krav ${index + 1}.`,
        recommendation: "Behold svaret.",
      })),
    },
  };
}

function generatedRequirementArtifact() {
  const immutableRowManifest = buildImmutableRequirementRowManifest([
    {
      ref: "K-001",
      requirementText: "Logging skal dokumenteres.",
      sourceLocator: "Bilag 2, side 4, K-001",
      sourceDocumentId: CUSTOMER_DOCUMENT_ID,
    },
    {
      ref: "K-002",
      requirementText: "Backup skal dokumenteres.",
      sourceLocator: "Bilag 2, side 5, K-002",
      sourceDocumentId: CUSTOMER_DOCUMENT_ID,
    },
  ]);
  return {
    id: "artifact-v1",
    project_id: PROJECT_ID,
    artifact_type: "forbedret_kravsvar",
    title: "Kravbesvarelse",
    content_markdown: "Opprinnelig kravbesvarelse",
    input_snapshot: encryptJson({
      generation_metadata: {
        requirement_response: {
          total_requirements: 2,
          requirement_refs: ["K-001", "K-002"],
          deterministic_fallback_answers_after_handoff: 1,
          unresolved_fallback_answers: [
            { nr: 2, ref: "K-002", reason: "Historisk fallback" },
          ],
          coverage_enforced: true,
          source_evidence_enforced: true,
          immutable_row_manifest: immutableRowManifest,
        },
      },
      artifact_quality_report: {
        status: "fail",
        issues: ["Gammel rapport skal erstattes."],
      },
    }),
    artifact_version: 1,
    created_at: NOW,
    updated_at: NOW,
  };
}

function validManualRequirementMarkdown() {
  return [
    "## Validert kravbesvarelse",
    "",
    "Kravene er besvart med konkrete og etterprøvbare kontroller, tydelig ansvar, målepunkter og dokumentert kildegrunnlag for leveransen.",
    "",
    "| Kravref. | Krav | Svar | Svargrunnlag | Kildegrunnlag |",
    "|---|---|---|---|---|",
    "| K-001 | Logging skal dokumenteres. | Atea dokumenterer logging med ansvar, kontroller, målinger og revisjonsspor. | Svaret beskriver ansvar, kontroll og etterprøvbar logging. | Bilag 2, side 4, K-001 |",
    "| K-002 | Backup skal dokumenteres. | Atea dokumenterer backup med gjenopprettingstest, målepunkter og avvikshåndtering. | Svaret beskriver test, måling og håndtering av avvik. | Bilag 2, side 5, K-002 |",
  ].join("\n");
}

test("invalid manual kravsvar edit is rejected before the version RPC", async () => {
  const database = persistenceDatabase({
    generated_artifacts: [generatedRequirementArtifact()],
  });

  await assert.rejects(
    updateGeneratedArtifact({
      projectId: PROJECT_ID,
      artifactId: "artifact-v1",
      title: "Manuelt forbedret kravbesvarelse",
      contentMarkdown: [
        "## Kravbesvarelse",
        "",
        "| Kravref. | Krav | Svar | Svargrunnlag | Kildegrunnlag |",
        "|---|---|---|---|---|",
        "| K-001 | Logging skal dokumenteres. | Logging dokumenteres med kontroller. | Dokumenterte kontroller. | Bilag 2, K-001 |",
      ].join("\n"),
    }),
    /(?:ikke lenger består kvalitetskontrollen|ikke lagres som autoritativ kravbesvarelse)/u,
  );

  assert.equal(
    database.operations.some(
      (operation) =>
        operation.operation === "rpc" &&
        operation.table === "create_manual_artifact_version",
    ),
    false,
  );
  assert.equal(database.tables.generated_artifacts.length, 1);
});

test("valid manual kravsvar edit sends a fresh quality report to the version RPC", async () => {
  const database = persistenceDatabase({
    generated_artifacts: [generatedRequirementArtifact()],
  });

  const saved = await updateGeneratedArtifact({
    projectId: PROJECT_ID,
    artifactId: "artifact-v1",
    title: "Manuelt forbedret kravbesvarelse",
    contentMarkdown: validManualRequirementMarkdown(),
  });

  const createOperation = database.operations.find(
    (operation) =>
      operation.operation === "rpc" &&
      operation.table === "create_manual_artifact_version",
  );
  assert.ok(createOperation);
  assert.equal(createOperation.payload.p_payload.generator_revision, "manual-edit-v2");

  const inputSnapshot = decryptJson(
    createOperation.payload.p_payload.input_snapshot,
    {},
  );
  assert.equal(inputSnapshot.artifact_quality_report.status, "pass");
  assert.deepEqual(inputSnapshot.artifact_quality_report.issues, []);
  assert.equal(
    inputSnapshot.artifact_quality_report.metrics.unresolvedFallbackAnswers,
    0,
  );
  assert.equal(
    inputSnapshot.generation_metadata.requirement_response
      .deterministic_fallback_answers_after_handoff,
    1,
  );
  assert.equal(saved.parent_artifact_id, "artifact-v1");
  assert.equal(saved.origin, "manual_edit");
});

test("unfenced evaluation save fails closed without mutating derived state", async () => {
  const oldEvaluation = evaluationRow();
  const oldSummary = executiveSummaryRow();
  const database = persistenceDatabase({
    solution_evaluations: [oldEvaluation],
    executive_summaries: [oldSummary],
  });

  await assert.rejects(
    saveSolutionEvaluation(PROJECT_ID, solutionInput()),
    /aktiv, lease-fenced prosjektjobb/u,
  );

  assert.deepEqual(database.tables.solution_evaluations, [oldEvaluation]);
  assert.deepEqual(database.tables.executive_summaries, [oldSummary]);
  assert.deepEqual(database.operations, []);
});

test("evaluation save canonicalizes coverage indexes before persistence", async () => {
  persistenceDatabase();
  setSolutionEvaluationMutationFencedForPersistenceTest(true);

  const saved = await saveSolutionEvaluation(
    PROJECT_ID,
    solutionInput({ result: legacyRequirementCoverageResult() }),
  );
  const calls = getSolutionEvaluationMutationCallsForPersistenceTest();
  assert.equal(calls.length, 1);
  const persistedResult = decryptJson(calls[0].payload.result_json, {});

  assert.deepEqual(
    persistedResult.requirement_coverage.items.map(
      (item) => item.order_index,
    ),
    [0, 1, 2, 3, 4, 5],
  );
  assert.deepEqual(
    saved.requirement_coverage.items.map((item) => item.order_index),
    [0, 1, 2, 3, 4, 5],
  );
  assert.equal(
    saved.requirement_coverage.items.some(
      (item) => item.reference === "Side 7 krav 3",
    ),
    true,
  );
});

test("persisted coverage keeps every row and canonicalizes legacy indexes on every read mapping", async () => {
  const storedEvaluation = {
    ...evaluationRow(),
    result_json: legacyRequirementCoverageResult(),
  };
  const database = persistenceDatabase({
    solution_evaluations: [storedEvaluation],
  });

  const firstRead = await getFreshSolutionEvaluation(PROJECT_ID);
  assert.ok(firstRead?.requirement_coverage);
  assert.deepEqual(
    firstRead.requirement_coverage.items.map((item) => item.reference),
    ["K-001", "K-002", "Side 7 krav 3", "K-004", "K-005", "K-006"],
  );
  assert.deepEqual(
    firstRead.requirement_coverage.items.map((item) => item.order_index),
    [0, 1, 2, 3, 4, 5],
  );

  // `saveSolutionEvaluation` returns through the same row mapper. Re-reading
  // that mapped payload must therefore remain stable and cannot reintroduce
  // one-based positions or gaps.
  database.tables.solution_evaluations[0].result_json = firstRead;
  const secondRead = await getFreshSolutionEvaluation(PROJECT_ID);
  assert.deepEqual(
    secondRead?.requirement_coverage?.items.map((item) => item.order_index),
    [0, 1, 2, 3, 4, 5],
  );
  assert.equal(secondRead?.requirement_coverage?.total_requirements, 6);
  assert.equal(secondRead?.requirement_coverage?.assessed_requirements, 6);
});

test("uploading a supporting kravdokument invalidates evaluation, summary, and project flag", async () => {
  const database = persistenceDatabase({
    documents: [
      documentRow(CUSTOMER_DOCUMENT_ID, "primary_customer_document"),
      documentRow(SOLUTION_DOCUMENT_ID, "primary_solution_document"),
    ],
    solution_evaluations: [evaluationRow()],
    executive_summaries: [executiveSummaryRow()],
  });

  await savePendingDocument({
    projectId: PROJECT_ID,
    title: "Nye krav",
    role: "supporting_document",
    supportingSubtype: "kravdokument",
    fileName: "krav.txt",
    fileFormat: "txt",
    contentType: "text/plain",
    fileSizeBytes: 4,
    fileBase64: Buffer.from("krav").toString("base64"),
  });

  assert.equal(database.tables.solution_evaluations.length, 0);
  assert.equal(database.tables.executive_summaries.length, 0);
  assert.equal(database.tables.projects[0].customer_analysis_generated, false);
  assert.equal(database.tables.projects[0].solution_evaluation_generated, false);
});

test("regenerating customer analysis invalidates evaluation, summary, and project flag", async () => {
  const database = persistenceDatabase({
    customer_analyses: [
      {
        id: "analysis-old",
        project_id: PROJECT_ID,
        source_document_ids: [CUSTOMER_DOCUMENT_ID],
        result_json: {},
        created_at: NOW,
        updated_at: NOW,
      },
    ],
    solution_evaluations: [evaluationRow()],
    executive_summaries: [executiveSummaryRow()],
  });

  await saveCustomerAnalysis(
    PROJECT_ID,
    [CUSTOMER_DOCUMENT_ID],
    customerAnalysisInput(),
    {
      expectedSourceRevision: 0,
      previousAnalysis: null,
      updatedSections: [],
    },
  );

  assert.equal(database.tables.customer_analyses.length, 1);
  assert.equal(database.tables.solution_evaluations.length, 0);
  assert.equal(database.tables.executive_summaries.length, 0);
  assert.equal(database.tables.projects[0].customer_analysis_generated, true);
  assert.equal(database.tables.projects[0].solution_evaluation_generated, false);
});

test("a failed customer-analysis upsert preserves the previous analysis and derived results", async () => {
  const oldAnalysis = {
    id: "analysis-old",
    project_id: PROJECT_ID,
    source_document_ids: [CUSTOMER_DOCUMENT_ID],
    result_json: { preserved: true },
    created_at: NOW,
    updated_at: NOW,
  };
  const oldEvaluation = evaluationRow();
  const oldSummary = executiveSummaryRow();
  const database = persistenceDatabase({
    customer_analyses: [oldAnalysis],
    solution_evaluations: [oldEvaluation],
    executive_summaries: [oldSummary],
  });
  database.operationErrors.set("customer_analyses:upsert", {
    message: "forced analysis upsert failure",
  });

  await assert.rejects(
    saveCustomerAnalysis(
      PROJECT_ID,
      [CUSTOMER_DOCUMENT_ID],
      customerAnalysisInput(),
      {
        expectedSourceRevision: 0,
        previousAnalysis: null,
        updatedSections: [],
      },
    ),
    /forced analysis upsert failure/u,
  );

  assert.deepEqual(database.tables.customer_analyses, [oldAnalysis]);
  assert.deepEqual(database.tables.solution_evaluations, [oldEvaluation]);
  assert.deepEqual(database.tables.executive_summaries, [oldSummary]);
  assert.equal(database.tables.projects[0].solution_evaluation_generated, true);
});

test("a document mutation after analysis input capture rejects the stale analysis atomically", async () => {
  const oldAnalysis = {
    id: "analysis-old",
    project_id: PROJECT_ID,
    source_document_ids: [CUSTOMER_DOCUMENT_ID],
    result_json: { preserved: true },
    created_at: NOW,
    updated_at: NOW,
  };
  const oldEvaluation = evaluationRow();
  const oldSummary = executiveSummaryRow();
  const database = persistenceDatabase({
    projects: [projectRow({ source_revision: 1 })],
    customer_analyses: [oldAnalysis],
    solution_evaluations: [oldEvaluation],
    executive_summaries: [oldSummary],
  });

  await assert.rejects(
    saveCustomerAnalysis(
      PROJECT_ID,
      [CUSTOMER_DOCUMENT_ID],
      customerAnalysisInput(),
      {
        expectedSourceRevision: 0,
        previousAnalysis: oldAnalysis.result_json,
        updatedSections: [],
      },
    ),
    /PROJECT_SOURCE_REVISION_CHANGED/u,
  );

  assert.deepEqual(database.tables.customer_analyses, [oldAnalysis]);
  assert.deepEqual(database.tables.solution_evaluations, [oldEvaluation]);
  assert.deepEqual(database.tables.executive_summaries, [oldSummary]);
  assert.equal(database.tables.projects[0].solution_evaluation_generated, true);
});

test("selecting a new primary solution invalidates evaluation and executive summary", async () => {
  const database = persistenceDatabase({
    documents: [
      documentRow(CUSTOMER_DOCUMENT_ID, "primary_customer_document"),
      documentRow(SOLUTION_DOCUMENT_ID, "primary_solution_document"),
      documentRow(SUPPORTING_DOCUMENT_ID, "supporting_document", "utkast"),
    ],
    solution_evaluations: [evaluationRow()],
    executive_summaries: [executiveSummaryRow()],
  });

  await markDocumentAsPrimarySolution(PROJECT_ID, SUPPORTING_DOCUMENT_ID);

  assert.equal(database.tables.solution_evaluations.length, 0);
  assert.equal(database.tables.executive_summaries.length, 0);
  assert.equal(database.tables.projects[0].solution_evaluation_generated, false);
  assert.equal(
    database.tables.documents.find(
      (document) => document.id === SOLUTION_DOCUMENT_ID,
    ).role,
    "supporting_document",
  );
  assert.equal(
    database.tables.documents.find(
      (document) => document.id === SUPPORTING_DOCUMENT_ID,
    ).role,
    "primary_solution_document",
  );
});

test("primary solution upload and ingestion preserve customer analysis and context keywords", async () => {
  const existingAnalysis = {
    id: "analysis-before-solution",
    project_id: PROJECT_ID,
    source_document_ids: [CUSTOMER_DOCUMENT_ID],
    result_json: encryptJson({
      ...customerAnalysisInput(),
      signal_words: ["analysesignal"],
    }),
    provenance_verified: true,
    created_at: NOW,
    updated_at: NOW,
  };
  const database = persistenceDatabase({
    projects: [
      projectRow({
        name: "for",
        customer_name: "med",
        description: "til",
        industry: "det",
        context_keywords: [],
        solution_document_uploaded: false,
      }),
    ],
    documents: [
      documentRow(CUSTOMER_DOCUMENT_ID, "primary_customer_document", null, {
        title: "abc",
        file_name: "a.b",
      }),
    ],
    customer_analyses: [existingAnalysis],
  });

  const uploaded = await savePendingDocument({
    projectId: PROJECT_ID,
    title: "Uniktlosningssignal",
    role: "primary_solution_document",
    fileName: "uniktlosningssignal.txt",
    fileFormat: "txt",
    contentType: "text/plain",
    fileSizeBytes: 4,
    fileBase64: Buffer.from("test").toString("base64"),
  });

  assert.equal(uploaded.role, "primary_solution_document");
  assert.equal(
    database.tables.documents.filter(
      (document) => document.role === "primary_solution_document",
    ).length,
    1,
  );
  assert.deepEqual(database.tables.customer_analyses, [existingAnalysis]);
  assert.equal(database.tables.projects[0].customer_analysis_generated, true);
  assert.equal(database.tables.projects[0].solution_document_uploaded, true);
  assert.deepEqual(database.tables.projects[0].context_keywords, []);
  assert.equal(directProjectContextKeywordUpdates(database).length, 0);
  assert.equal(fencedProjectContextKeywordMutations().length, 0);

  await saveDocumentIngestionResult({
    projectId: PROJECT_ID,
    documentId: uploaded.id,
    role: "primary_solution_document",
    title: uploaded.title,
    fileName: "nyttlosningssignal.txt",
    fileFormat: "txt",
    contentType: "text/plain",
    rawText: "Et løsningsdokument med unikt innhold.",
    structureMap: [],
    parserUsed: "test-parser",
    status: "enhanced_ready",
    message: "Dokumentet er klart.",
    indexChunks: false,
  });

  assert.deepEqual(database.tables.customer_analyses, [existingAnalysis]);
  assert.equal(database.tables.projects[0].customer_analysis_generated, true);
  assert.deepEqual(database.tables.projects[0].context_keywords, []);
  assert.equal(directProjectContextKeywordUpdates(database).length, 0);
  assert.equal(fencedProjectContextKeywordMutations().length, 0);
  const insertOperation = database.operations.find(
    (operation) =>
      operation.table === "documents" && operation.operation === "insert",
  );
  assert.equal(insertOperation, undefined);
  assert.ok(
    database.operations.some(
      (operation) =>
        operation.table === "insert_primary_project_document" &&
        operation.operation === "rpc",
    ),
  );
});

test("replacing, ingesting, and deleting solution history preserve customer analysis", async () => {
  const existingAnalysis = {
    id: "analysis-before-solution-replacement",
    project_id: PROJECT_ID,
    source_document_ids: [CUSTOMER_DOCUMENT_ID],
    result_json: encryptJson(customerAnalysisInput()),
    provenance_verified: true,
    created_at: NOW,
    updated_at: NOW,
  };
  const database = persistenceDatabase({
    projects: [
      projectRow({
        context_keywords: ["kundesignal"],
        customer_analysis_generated: true,
        solution_document_uploaded: true,
        solution_evaluation_generated: true,
      }),
    ],
    documents: [
      documentRow(CUSTOMER_DOCUMENT_ID, "primary_customer_document"),
      documentRow(SOLUTION_DOCUMENT_ID, "primary_solution_document"),
    ],
    customer_analyses: [existingAnalysis],
    solution_evaluations: [evaluationRow()],
    executive_summaries: [executiveSummaryRow()],
  });

  const replacement = await savePendingDocument({
    projectId: PROJECT_ID,
    title: "Ny arkitektløsning",
    role: "primary_solution_document",
    fileName: "ny-arkitektur.txt",
    fileFormat: "txt",
    contentType: "text/plain",
    fileSizeBytes: 4,
    fileBase64: Buffer.from("ny løsning").toString("base64"),
  });

  const previousSolution = database.tables.documents.find(
    (document) => document.id === SOLUTION_DOCUMENT_ID,
  );
  assert.equal(replacement.role, "primary_solution_document");
  assert.equal(previousSolution.role, "supporting_document");
  assert.equal(previousSolution.supporting_subtype, "tidligere_losning");
  assert.equal(previousSolution.subtype, "tidligere_losning");
  assert.deepEqual(database.tables.customer_analyses, [existingAnalysis]);
  assert.equal(database.tables.projects[0].customer_analysis_generated, true);
  assert.equal(database.tables.projects[0].solution_evaluation_generated, false);
  assert.equal(database.tables.solution_evaluations.length, 0);
  assert.equal(database.tables.executive_summaries.length, 0);
  assert.deepEqual(database.tables.projects[0].context_keywords, [
    "kundesignal",
  ]);

  await saveDocumentIngestionResult({
    projectId: PROJECT_ID,
    documentId: replacement.id,
    role: "primary_solution_document",
    title: replacement.title,
    fileName: replacement.file_name,
    fileFormat: "txt",
    contentType: "text/plain",
    rawText: "Ny løsning er ferdig indeksert.",
    structureMap: [],
    parserUsed: "test-parser",
    status: "enhanced_ready",
    message: "Dokumentet er klart.",
    indexChunks: false,
  });
  await saveDocumentIngestionResult({
    projectId: PROJECT_ID,
    documentId: SOLUTION_DOCUMENT_ID,
    role: "supporting_document",
    supportingSubtype: "tidligere_losning",
    title: previousSolution.title,
    fileName: previousSolution.file_name,
    fileFormat: "txt",
    contentType: "text/plain",
    rawText: "Forsinket indeksering av tidligere løsning.",
    structureMap: [],
    parserUsed: "test-parser",
    status: "enhanced_ready",
    message: "Dokumentet er klart.",
    indexChunks: false,
  });

  assert.deepEqual(database.tables.customer_analyses, [existingAnalysis]);
  assert.equal(database.tables.projects[0].customer_analysis_generated, true);
  assert.deepEqual(database.tables.projects[0].context_keywords, [
    "kundesignal",
  ]);
  assert.equal(directProjectContextKeywordUpdates(database).length, 0);
  assert.equal(fencedProjectContextKeywordMutations().length, 0);

  const restored = await markDocumentAsPrimarySolution(
    PROJECT_ID,
    SOLUTION_DOCUMENT_ID,
  );
  assert.equal(restored.role, "primary_solution_document");
  assert.equal(
    database.tables.documents.find(
      (document) => document.id === replacement.id,
    ).supporting_subtype,
    "tidligere_losning",
  );
  assert.deepEqual(database.tables.customer_analyses, [existingAnalysis]);
  assert.equal(database.tables.projects[0].customer_analysis_generated, true);

  await deleteDocument(PROJECT_ID, replacement.id);

  assert.deepEqual(database.tables.customer_analyses, [existingAnalysis]);
  assert.equal(database.tables.projects[0].customer_analysis_generated, true);
});

test("analysis document reads exclude canonical and legacy solution history before hydration", async () => {
  const canonicalHistory = documentRow(
    "00000000-0000-4000-8000-000000000121",
    "supporting_document",
    "tidligere_losning",
    { subtype: "tidligere_losning" },
  );
  const legacyHistory = documentRow(
    "00000000-0000-4000-8000-000000000122",
    "supporting_document",
    null,
    { subtype: "tidligere_losning" },
  );
  for (const history of [canonicalHistory, legacyHistory]) {
    Object.defineProperty(history, "raw_text", {
      enumerable: true,
      get() {
        throw new Error("historical solution payload was hydrated");
      },
    });
  }
  persistenceDatabase({
    documents: [
      documentRow(CUSTOMER_DOCUMENT_ID, "primary_customer_document"),
      documentRow(SUPPORTING_DOCUMENT_ID, "supporting_document", null, {
        subtype: null,
        title: "Active note",
      }),
      documentRow(
        "00000000-0000-4000-8000-000000000123",
        "supporting_document",
        null,
        {
          subtype: "kravdokument",
          title: "Document A",
          file_name: "document-a.txt",
        },
      ),
      documentRow(
        "00000000-0000-4000-8000-000000000124",
        "supporting_document",
        null,
        {
          subtype: "rfp",
          title: "Document B",
          file_name: "document-b.txt",
        },
      ),
      canonicalHistory,
      legacyHistory,
    ],
  });

  const documents = await listProjectDocumentsForAnalysis(PROJECT_ID);

  assert.deepEqual(
    documents
      .map((document) => [document.id, document.supporting_subtype])
      .sort(([left], [right]) => left.localeCompare(right)),
    [
      [CUSTOMER_DOCUMENT_ID, null],
      [SUPPORTING_DOCUMENT_ID, null],
      ["00000000-0000-4000-8000-000000000123", "kravdokument"],
      ["00000000-0000-4000-8000-000000000124", "rfp"],
    ].sort(([left], [right]) => left.localeCompare(right)),
  );
});

test("analysis document reads retain a safe in-memory legacy-schema fallback", async () => {
  const legacyRequirement = documentRow(
    "00000000-0000-4000-8000-000000000125",
    "supporting_document",
    null,
    {
      subtype: "kravdokument",
      title: "Document C",
      file_name: "document-c.txt",
    },
  );
  const legacyHistory = documentRow(
    "00000000-0000-4000-8000-000000000126",
    "supporting_document",
    null,
    {
      subtype: "tidligere_losning",
      title: "Document D",
      file_name: "document-d.txt",
    },
  );
  delete legacyRequirement.supporting_subtype;
  delete legacyHistory.supporting_subtype;
  const database = persistenceDatabase({
    documents: [legacyRequirement, legacyHistory],
  });
  database.missingColumns.documents = new Set(["supporting_subtype"]);

  const documents = await listProjectDocumentsForAnalysis(PROJECT_ID);

  assert.deepEqual(
    documents.map((document) => [document.id, document.supporting_subtype]),
    [[legacyRequirement.id, "kravdokument"]],
  );
});

test("customer and supporting documents remain part of project context keywords", async () => {
  const database = persistenceDatabase({
    projects: [
      projectRow({
        name: "for",
        customer_name: "med",
        description: "til",
        industry: "det",
        context_keywords: [],
      }),
    ],
    documents: [
      documentRow(CUSTOMER_DOCUMENT_ID, "primary_customer_document", null, {
        title: "kundekontekstsignal",
        file_name: "a.b",
      }),
      documentRow(SOLUTION_DOCUMENT_ID, "primary_solution_document", null, {
        title: "losningssignal",
        file_name: "c.d",
      }),
    ],
  });

  await savePendingDocument({
    projectId: PROJECT_ID,
    title: "stottekontekstsignal",
    role: "supporting_document",
    supportingSubtype: "kravdokument",
    fileName: "e.f",
    fileFormat: "txt",
    contentType: "text/plain",
    fileSizeBytes: 4,
    fileBase64: Buffer.from("krav").toString("base64"),
  });

  assert.ok(
    database.tables.projects[0].context_keywords.includes(
      "kundekontekstsignal",
    ),
  );
  assert.ok(
    database.tables.projects[0].context_keywords.includes(
      "stottekontekstsignal",
    ),
  );
  assert.equal(
    database.tables.projects[0].context_keywords.includes("losningssignal"),
    false,
  );
  assert.equal(database.tables.projects[0].customer_analysis_generated, false);
  assert.ok(directProjectContextKeywordUpdates(database).length > 0);
  assert.ok(fencedProjectContextKeywordMutations().length > 0);
});

test("primary customer upload still refreshes project context keywords", async () => {
  const database = persistenceDatabase({
    projects: [
      projectRow({
        name: "for",
        customer_name: "med",
        description: "til",
        industry: "det",
        context_keywords: [],
        customer_document_uploaded: false,
        customer_analysis_generated: false,
      }),
    ],
    documents: [],
    customer_analyses: [],
  });

  await savePendingDocument({
    projectId: PROJECT_ID,
    title: "kundekontekstsignal",
    role: "primary_customer_document",
    fileName: "a.b",
    fileFormat: "txt",
    contentType: "text/plain",
    fileSizeBytes: 4,
    fileBase64: Buffer.from("kunde").toString("base64"),
  });

  assert.ok(
    database.tables.projects[0].context_keywords.includes(
      "kundekontekstsignal",
    ),
  );
  assert.ok(directProjectContextKeywordUpdates(database).length > 0);
  assert.ok(fencedProjectContextKeywordMutations().length > 0);
});

test("failed atomic primary upload leaves no row and removes the stored blob", async () => {
  const database = persistenceDatabase({
    documents: [
      documentRow(CUSTOMER_DOCUMENT_ID, "primary_customer_document"),
      documentRow(SOLUTION_DOCUMENT_ID, "primary_solution_document"),
    ],
  });
  database.operationErrors.set("insert_primary_project_document:rpc", {
    message: "forced atomic promotion failure",
  });

  await assert.rejects(
    savePendingDocument({
      projectId: PROJECT_ID,
      title: "Ny arkitektløsning",
      role: "primary_solution_document",
      fileName: "failed-primary.txt",
      fileFormat: "txt",
      contentType: "text/plain",
      fileSizeBytes: 4,
      fileBase64: Buffer.from("test").toString("base64"),
    }),
    /forced atomic promotion failure/u,
  );

  assert.deepEqual(
    database.tables.documents.map((document) => document.id).sort(),
    [CUSTOMER_DOCUMENT_ID, SOLUTION_DOCUMENT_ID].sort(),
  );
  assert.equal(
    database.tables.documents.find(
      (document) => document.id === SOLUTION_DOCUMENT_ID,
    ).role,
    "primary_solution_document",
  );
  const removedFiles = getRemovedStoredFilesForPersistenceTest();
  assert.equal(removedFiles.length, 1);
  assert.equal(removedFiles[0].bucket, "test-documents");
  assert.match(removedFiles[0].path, /failed-primary\.txt$/u);
});

test("primary-solution RPC rollback preserves the previous role assignment", async () => {
  const database = persistenceDatabase({
    documents: [
      documentRow(CUSTOMER_DOCUMENT_ID, "primary_customer_document"),
      documentRow(SOLUTION_DOCUMENT_ID, "primary_solution_document"),
      documentRow(SUPPORTING_DOCUMENT_ID, "supporting_document", "utkast"),
    ],
    solution_evaluations: [evaluationRow()],
    executive_summaries: [executiveSummaryRow()],
  });
  database.primaryPromotionError = {
    message: "forced failure after demotion",
  };

  await assert.rejects(
    markDocumentAsPrimarySolution(PROJECT_ID, SUPPORTING_DOCUMENT_ID),
    /forced failure after demotion/u,
  );
  assert.equal(
    database.tables.documents.find(
      (document) => document.id === SOLUTION_DOCUMENT_ID,
    ).role,
    "primary_solution_document",
  );
  assert.equal(
    database.tables.documents.find(
      (document) => document.id === SUPPORTING_DOCUMENT_ID,
    ).role,
    "supporting_document",
  );
});

test("a failed kravdokument insert preserves existing derived results", async () => {
  const database = persistenceDatabase({
    documents: [
      documentRow(CUSTOMER_DOCUMENT_ID, "primary_customer_document"),
      documentRow(SOLUTION_DOCUMENT_ID, "primary_solution_document"),
    ],
    solution_evaluations: [evaluationRow()],
    executive_summaries: [executiveSummaryRow()],
  });
  database.operationErrors.set("documents:insert", {
    message: "forced document insert failure",
  });

  await assert.rejects(
    savePendingDocument({
      projectId: PROJECT_ID,
      title: "Nye krav",
      role: "supporting_document",
      supportingSubtype: "kravdokument",
      fileName: "krav.txt",
      fileFormat: "txt",
      contentType: "text/plain",
      fileSizeBytes: 4,
      fileBase64: Buffer.from("krav").toString("base64"),
    }),
    /forced document insert failure/u,
  );

  assert.equal(database.tables.solution_evaluations.length, 1);
  assert.equal(database.tables.executive_summaries.length, 1);
  assert.equal(database.tables.projects[0].solution_evaluation_generated, true);
});

test("kravdokument invalidation errors are surfaced without clearing the flag", async () => {
  const database = persistenceDatabase({
    documents: [
      documentRow(CUSTOMER_DOCUMENT_ID, "primary_customer_document"),
      documentRow(SOLUTION_DOCUMENT_ID, "primary_solution_document"),
    ],
    solution_evaluations: [evaluationRow()],
    executive_summaries: [executiveSummaryRow()],
  });
  database.operationErrors.set("solution_evaluations:delete", {
    message: "forced invalidation failure",
  });

  await assert.rejects(
    savePendingDocument({
      projectId: PROJECT_ID,
      title: "Nye krav",
      role: "supporting_document",
      supportingSubtype: "kravdokument",
      fileName: "krav.txt",
      fileFormat: "txt",
      contentType: "text/plain",
      fileSizeBytes: 4,
      fileBase64: Buffer.from("krav").toString("base64"),
    }),
    /forced invalidation failure/u,
  );

  assert.equal(database.tables.solution_evaluations.length, 1);
  assert.equal(database.tables.executive_summaries.length, 1);
  assert.equal(database.tables.projects[0].solution_evaluation_generated, true);
});

test("deleting a kravdokument or explicitly selected supporting solution invalidates derived results", async () => {
  const cases = [
    {
      name: "kravdokument",
      subtype: "kravdokument",
      selectedSolutionDocumentId: SOLUTION_DOCUMENT_ID,
    },
    {
      name: "explicitly selected support",
      subtype: "utkast",
      selectedSolutionDocumentId: SUPPORTING_DOCUMENT_ID,
    },
  ];

  for (const scenario of cases) {
    const database = persistenceDatabase({
      documents: [
        documentRow(CUSTOMER_DOCUMENT_ID, "primary_customer_document"),
        documentRow(SOLUTION_DOCUMENT_ID, "primary_solution_document"),
        documentRow(
          SUPPORTING_DOCUMENT_ID,
          "supporting_document",
          scenario.subtype,
        ),
      ],
      solution_evaluations: [
        evaluationRow(scenario.selectedSolutionDocumentId),
      ],
      executive_summaries: [executiveSummaryRow()],
    });

    await deleteDocument(PROJECT_ID, SUPPORTING_DOCUMENT_ID);

    assert.equal(
      database.tables.solution_evaluations.length,
      0,
      `${scenario.name} should invalidate the evaluation`,
    );
    assert.equal(
      database.tables.executive_summaries.length,
      0,
      `${scenario.name} should invalidate the summary`,
    );
    assert.equal(database.tables.projects[0].solution_evaluation_generated, false);
  }
});

test("deleting a supporting note invalidates analysis and all derived results", async () => {
  const database = persistenceDatabase({
    documents: [
      documentRow(CUSTOMER_DOCUMENT_ID, "primary_customer_document"),
      documentRow(SOLUTION_DOCUMENT_ID, "primary_solution_document"),
      documentRow(SUPPORTING_DOCUMENT_ID, "supporting_document", "notat"),
    ],
    customer_analyses: [
      {
        id: "analysis-old",
        project_id: PROJECT_ID,
        source_document_ids: [CUSTOMER_DOCUMENT_ID, SUPPORTING_DOCUMENT_ID],
        result_json: { preserved: true },
        created_at: NOW,
        updated_at: NOW,
      },
    ],
    solution_evaluations: [evaluationRow()],
    executive_summaries: [executiveSummaryRow()],
  });

  await deleteDocument(PROJECT_ID, SUPPORTING_DOCUMENT_ID);

  assert.equal(database.tables.customer_analyses.length, 0);
  assert.equal(database.tables.solution_evaluations.length, 0);
  assert.equal(database.tables.executive_summaries.length, 0);
  assert.equal(database.tables.projects[0].customer_analysis_generated, false);
  assert.equal(database.tables.projects[0].solution_evaluation_generated, false);
});

test("legacy deletion metadata invalidates a sole explicitly selected supporting solution", async () => {
  const legacySupportingDocument = {
    ...documentRow(SUPPORTING_DOCUMENT_ID, "supporting_document", null),
    subtype: "utkast",
  };
  delete legacySupportingDocument.supporting_subtype;
  const legacyEvaluation = {
    ...evaluationRow(SUPPORTING_DOCUMENT_ID),
    source_document_ids: [SUPPORTING_DOCUMENT_ID],
  };
  delete legacyEvaluation.solution_document_id;
  const database = persistenceDatabase({
    documents: [
      documentRow(CUSTOMER_DOCUMENT_ID, "primary_customer_document"),
      documentRow(SOLUTION_DOCUMENT_ID, "primary_solution_document"),
      legacySupportingDocument,
    ],
    solution_evaluations: [legacyEvaluation],
    executive_summaries: [executiveSummaryRow()],
  });
  database.missingColumns.documents = new Set(["supporting_subtype"]);
  database.missingColumns.solution_evaluations = new Set([
    "solution_document_id",
  ]);

  await deleteDocument(PROJECT_ID, SUPPORTING_DOCUMENT_ID);

  assert.equal(database.tables.solution_evaluations.length, 0);
  assert.equal(database.tables.executive_summaries.length, 0);
  assert.equal(database.tables.projects[0].solution_evaluation_generated, false);
});

test("a transient selected-solution metadata error blocks deletion before state changes", async () => {
  const database = persistenceDatabase({
    documents: [
      documentRow(CUSTOMER_DOCUMENT_ID, "primary_customer_document"),
      documentRow(SOLUTION_DOCUMENT_ID, "primary_solution_document"),
      documentRow(SUPPORTING_DOCUMENT_ID, "supporting_document", "notat"),
    ],
    solution_evaluations: [evaluationRow(SUPPORTING_DOCUMENT_ID)],
    executive_summaries: [executiveSummaryRow()],
  });
  database.operationErrors.set("solution_evaluations:select", {
    message: "forced metadata read failure",
  });

  await assert.rejects(
    deleteDocument(PROJECT_ID, SUPPORTING_DOCUMENT_ID),
    /forced metadata read failure/u,
  );

  assert.equal(
    database.tables.documents.some(
      (document) => document.id === SUPPORTING_DOCUMENT_ID,
    ),
    true,
  );
  assert.equal(database.tables.solution_evaluations.length, 1);
  assert.equal(database.tables.executive_summaries.length, 1);
});
