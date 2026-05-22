import "server-only";

import { randomUUID } from "node:crypto";

import { CUSTOMER_ANALYSIS_SECTIONS } from "@/lib/customer-analysis-history";
import {
  repairGeneratedArtifactContent,
  validateGeneratedArtifact,
} from "@/lib/server/artifact-validation";
import {
  ensureProjectDocumentChunks,
  ensureServiceDocumentChunks,
} from "@/lib/server/document-chunks";
import {
  buildDocumentLedger,
  buildDocumentLedgerContext,
  summarizeDocumentLedgers,
} from "@/lib/server/document-ledger";
import { createServiceClient } from "@/lib/server/supabase";
import {
  analyzeCustomerDocuments,
  evaluateSolutionDocument,
  generateExecutiveSummary,
  generateHighLevelDesign,
  generateProjectArtifact,
  synthesizeAndEvaluateSolution,
} from "@/lib/server/ai";
import {
  getCustomerAnalysis,
  getDocumentDetail,
  getSolutionEvaluation,
  getProjectDetail,
  getProjectSnapshot,
  listGeneratedArtifacts,
  listProjectDocuments,
  listServiceDocumentDetailsForProject,
  listServiceDocumentSummariesForProject,
  saveCustomerAnalysis,
  saveExecutiveSummary,
  saveGeneratedArtifact,
  saveSolutionEvaluation,
} from "@/lib/server/projects-db";
import { splitServiceDescriptionDetails } from "@/lib/service-description";
import type {
  GeneratedArtifact,
  GeneratedArtifactType,
  ProjectDocumentDetail,
  ProjectJobRecord,
  ProjectJobResult,
  ServiceDocument,
} from "@/lib/types";

type JobRunner = (helpers: { setProgress: (message: string) => void }) => Promise<ProjectJobResult>;

type JobStore = Map<string, ProjectJobRecord>;

type QueueJobOptions = {
  jobId?: string;
  skipEnqueue?: boolean;
  runNow?: boolean;
};

type QueuedProjectJobInput =
  | { kind: "customer_analysis"; projectId: string; model?: string }
  | {
      kind: "solution_evaluation";
      projectId: string;
      allowGeneratedSolution: boolean;
      solutionDocumentId?: string;
      model?: string;
    }
  | {
      kind: "artifact_generation";
      projectId: string;
      artifactType: GeneratedArtifactType;
      instructions?: string;
      sourceDocumentIds?: string[];
      model?: string;
    }
  | { kind: "high_level_design"; projectId: string; model?: string }
  | { kind: "perfect_system_solution"; projectId: string; model?: string }
  | { kind: "executive_summary"; projectId: string; model?: string };

type StoredQueuedJobPayload = {
  __job_input: QueuedProjectJobInput;
};

type JobRow = {
  id: string;
  project_id: string;
  kind: ProjectJobRecord["kind"];
  status: ProjectJobRecord["status"];
  message: string;
  error: string | null;
  result_json: ProjectJobResult | StoredQueuedJobPayload | null;
  created_at: string;
  updated_at: string;
};

declare global {
  // eslint-disable-next-line no-var
  var __anbudProjectJobs: JobStore | undefined;
  // eslint-disable-next-line no-var
  var __anbudProjectJobProgressWrites:
    | Map<string, { message: string; writtenAt: number }>
    | undefined;
}

function getStore() {
  if (!globalThis.__anbudProjectJobs) {
    globalThis.__anbudProjectJobs = new Map<string, ProjectJobRecord>();
  }

  return globalThis.__anbudProjectJobs;
}

function getProgressWriteStore() {
  if (!globalThis.__anbudProjectJobProgressWrites) {
    globalThis.__anbudProjectJobProgressWrites = new Map<
      string,
      { message: string; writtenAt: number }
    >();
  }

  return globalThis.__anbudProjectJobProgressWrites;
}

function isStoredQueuedJobPayload(
  value: unknown,
): value is StoredQueuedJobPayload {
  return Boolean(
    value &&
      typeof value === "object" &&
      "__job_input" in value &&
      (value as StoredQueuedJobPayload).__job_input,
  );
}

function mapJobRow(row: JobRow): ProjectJobRecord {
  return {
    id: row.id,
    project_id: row.project_id,
    kind: row.kind,
    status: row.status,
    message: row.message,
    created_at: row.created_at,
    updated_at: row.updated_at,
    error: row.error,
    result:
      row.status === "completed" && !isStoredQueuedJobPayload(row.result_json)
        ? (row.result_json as ProjectJobResult | null)
        : null,
  };
}

async function persistJob(
  record: ProjectJobRecord,
  input: QueuedProjectJobInput,
) {
  try {
    const supabase = createServiceClient();
    await supabase.from("project_jobs").insert({
      id: record.id,
      project_id: record.project_id,
      kind: record.kind,
      status: record.status,
      message: record.message,
      error: record.error,
      result_json: { __job_input: input },
      created_at: record.created_at,
      updated_at: record.updated_at,
    });
  } catch {
    // Older databases may not have project_jobs yet. Keep in-memory jobs working.
  }
}

async function patchPersistedJob(jobId: string, patch: Partial<ProjectJobRecord>) {
  try {
    const supabase = createServiceClient();
    const payload: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    };
    if (patch.status !== undefined) payload.status = patch.status;
    if (patch.message !== undefined) payload.message = patch.message;
    if (patch.error !== undefined) payload.error = patch.error;
    if (patch.result !== undefined) payload.result_json = patch.result;

    await supabase
      .from("project_jobs")
      .update(payload)
      .eq("id", jobId);
  } catch {
    // See persistJob fallback note.
  }
}

function updateJob(jobId: string, patch: Partial<ProjectJobRecord>) {
  const store = getStore();
  const current = store.get(jobId);
  const updatedAt = new Date().toISOString();

  if (current) {
    store.set(jobId, {
      ...current,
      ...patch,
      updated_at: updatedAt,
    });
  }

  if (
    patch.status === "running" &&
    patch.message &&
    patch.result === undefined &&
    patch.error === undefined
  ) {
    const writes = getProgressWriteStore();
    const previous = writes.get(jobId);
    const now = Date.now();
    if (
      previous &&
      previous.message === patch.message &&
      now - previous.writtenAt < 1500
    ) {
      return;
    }

    writes.set(jobId, { message: patch.message, writtenAt: now });
  }

  void patchPersistedJob(jobId, patch);
}

export async function getProjectJob(projectId: string, jobId: string) {
  const record = getStore().get(jobId) ?? null;
  if (!record || record.project_id !== projectId) {
    try {
      const supabase = createServiceClient();
      const { data } = await supabase
        .from("project_jobs")
        .select("*")
        .eq("id", jobId)
        .eq("project_id", projectId)
        .maybeSingle<JobRow>();

      return data ? mapJobRow(data) : null;
    } catch {
      return null;
    }
  }

  return record;
}

async function runRunner(jobId: string, runner: JobRunner) {
  updateJob(jobId, { status: "running" });

  try {
    const result = await runner({
      setProgress(message) {
        updateJob(jobId, { message, status: "running" });
      },
    });

    updateJob(jobId, {
      status: "completed",
      message: "Ferdig.",
      result,
      error: null,
    });
  } catch (error) {
    updateJob(jobId, {
      status: "failed",
      message: "Jobben feilet.",
      error: error instanceof Error ? error.message : "Ukjent feil.",
      result: null,
    });
  }
}

async function startRunner(jobId: string, runner: JobRunner) {
  setTimeout(async () => {
    await runRunner(jobId, runner);
  }, 0);
}

function getLatestSolutionDraft(
  artifacts: GeneratedArtifact[],
): GeneratedArtifact | null {
  return (
    artifacts.find((artifact) => artifact.artifact_type === "losningsutkast") ??
    null
  );
}

function serviceDocumentLimitForArtifact(artifactType: GeneratedArtifactType) {
  if (artifactType === "bilag1_rekonstruksjon") {
    return 0;
  }

  if (artifactType === "forbedret_kravsvar") {
    return 5;
  }

  return 3;
}

function tokenizeForRelevance(value: string) {
  return Array.from(
    new Set(
      value
        .toLowerCase()
        .replace(/[^a-z0-9æøå]+/gi, " ")
        .split(/\s+/)
        .filter((word) => word.length >= 4)
        .slice(0, 80),
    ),
  );
}

function selectRelevantServiceDocumentIds(input: {
  artifactType: GeneratedArtifactType;
  projectName: string;
  customerAnalysis: unknown;
  instructions?: string;
  serviceDocumentSummaries: ServiceDocument[];
}) {
  const limit = serviceDocumentLimitForArtifact(input.artifactType);
  if (!limit) {
    return [];
  }

  const queryTokens = tokenizeForRelevance(
    [
      input.artifactType,
      input.projectName,
      input.instructions ?? "",
      JSON.stringify(input.customerAnalysis ?? {}),
    ].join(" "),
  );

  return [...input.serviceDocumentSummaries]
    .map((document, index) => {
      const haystack = `${document.title} ${document.file_name} ${
        document.ai_summary ?? ""
      }`.toLowerCase();
      const score = queryTokens.reduce(
        (sum, token) => sum + (haystack.includes(token) ? 1 : 0),
        0,
      );
      return { document, index, score };
    })
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, limit)
    .map(({ document }) => document.id);
}

function selectProjectDocuments(documents: ProjectDocumentDetail[]) {
  const customerDocument =
    documents.find((document) => document.role === "primary_customer_document") ??
    documents[0] ??
    null;
  const solutionDocument =
    documents.find((document) => document.role === "primary_solution_document") ??
    documents.find(
      (document) =>
        document.id !== customerDocument?.id &&
        /løsn|losn|solution|arkitektur|architecture/i.test(
          `${document.title} ${document.file_name}`,
        ),
    ) ??
    null;
  const supportingDocuments = documents.filter(
    (document) =>
      document.id !== customerDocument?.id &&
      document.id !== solutionDocument?.id,
  );

  return { customerDocument, solutionDocument, supportingDocuments };
}

function logJobPhase(input: {
  jobId: string;
  kind: ProjectJobRecord["kind"];
  phase: string;
  durationMs: number;
}) {
  console.info(
    JSON.stringify({
      event: "project_job_phase_timing",
      job_id: input.jobId,
      kind: input.kind,
      phase: input.phase,
      duration_ms: input.durationMs,
    }),
  );
}

function createJobPhaseTimer(jobId: string, kind: ProjectJobRecord["kind"]) {
  const totalStartedAt = Date.now();
  let phaseStartedAt = totalStartedAt;
  const timings: Array<{ phase: string; duration_ms: number }> = [];

  return {
    mark(phase: string) {
      const now = Date.now();
      const durationMs = now - phaseStartedAt;
      timings.push({ phase, duration_ms: durationMs });
      logJobPhase({ jobId, kind, phase, durationMs });
      phaseStartedAt = now;
    },
    total() {
      return Date.now() - totalStartedAt;
    },
    timings() {
      return timings;
    },
  };
}

async function enqueueJob(
  record: ProjectJobRecord,
  input: QueuedProjectJobInput,
) {
  getStore().set(record.id, record);
  await persistJob(record, input);
}

async function getQueuedJobInput(jobId: string) {
  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("project_jobs")
    .select("id, result_json, status")
    .eq("id", jobId)
    .maybeSingle<{
      id: string;
      result_json: StoredQueuedJobPayload | ProjectJobResult | null;
      status: ProjectJobRecord["status"];
    }>();

  if (error || !data) {
    throw new Error("Fant ikke køet prosjektjobb.");
  }

  if (data.status !== "queued") {
    return null;
  }

  if (!isStoredQueuedJobPayload(data.result_json)) {
    throw new Error("Prosjektjobben mangler kjøredata.");
  }

  return data.result_json.__job_input;
}

export async function queueArtifactGenerationJob(input: {
  projectId: string;
  artifactType: GeneratedArtifactType;
  instructions?: string;
  sourceDocumentIds?: string[];
  model?: string;
}, options: QueueJobOptions = {}) {
  const jobId = options.jobId ?? randomUUID();
  const now = new Date().toISOString();
  const jobInput: QueuedProjectJobInput = {
    kind: "artifact_generation",
    projectId: input.projectId,
    artifactType: input.artifactType,
    instructions: input.instructions,
    sourceDocumentIds: input.sourceDocumentIds,
    model: input.model,
  };
  const record: ProjectJobRecord = {
    id: jobId,
    project_id: input.projectId,
    kind: "artifact_generation",
    status: "queued",
    message: "Køer generatorjobben ...",
    created_at: now,
    updated_at: now,
    error: null,
    result: null,
  };

  if (!options.skipEnqueue) {
    await enqueueJob(record, jobInput);
  }

  const runner: JobRunner = async ({ setProgress }) => {
    const phaseTimer = createJobPhaseTimer(jobId, "artifact_generation");
    function markPhase(phase: string) {
      phaseTimer.mark(phase);
    }

    setProgress("[12%] Laster prosjektkontekst og relevante dokumenter ...");
    const [
      project,
      customerAnalysis,
      documents,
      generatedArtifacts,
      serviceDocumentSummaries,
    ] = await Promise.all([
      getProjectDetail(input.projectId),
      getCustomerAnalysis(input.projectId),
      listProjectDocuments(input.projectId),
      listGeneratedArtifacts(input.projectId),
      listServiceDocumentSummariesForProject(input.projectId),
    ]);
    markPhase("dokumenthenting");
    const { projectDocuments, serviceDescriptionDocument } =
      splitServiceDescriptionDetails(documents);
    const selectedDocumentIds = new Set(input.sourceDocumentIds ?? []);
    const selectedRequirementDocuments = selectedDocumentIds.size
      ? projectDocuments.filter((document) => selectedDocumentIds.has(document.id))
      : [];
    const { customerDocument, solutionDocument, supportingDocuments } =
      selectProjectDocuments(projectDocuments);
    const serviceDescriptionDocumentsPromise =
      input.artifactType === "bilag1_rekonstruksjon"
        ? Promise.resolve([])
        : serviceDocumentSummaries.length
          ? listServiceDocumentDetailsForProject(input.projectId, {
              documentIds: selectRelevantServiceDocumentIds({
                artifactType: input.artifactType,
                projectName: project.name,
                customerAnalysis,
                instructions: input.instructions,
                serviceDocumentSummaries,
              }),
            })
          : listServiceDocumentDetailsForProject(input.projectId);

    if (
      input.artifactType === "bilag1_rekonstruksjon" &&
      !projectDocuments.some((document) => document.raw_text.trim())
    ) {
      throw new Error(
        "Bilag 1 kan ikke genereres fordi dokumentgrunnlaget mangler lesbar tekst.",
      );
    }
    setProgress("[16%] Bygger dokumentledger for struktur, krav og kildegrunnlag ...");
    const ledgerDocuments =
      input.artifactType === "forbedret_kravsvar" && selectedDocumentIds.size
        ? selectedRequirementDocuments
        : [
            customerDocument,
            solutionDocument,
            ...supportingDocuments,
          ].filter(
            (document): document is ProjectDocumentDetail =>
              document !== null && Boolean(document.raw_text.trim()),
          );
    const documentLedgers = ledgerDocuments.slice(0, 8).map(buildDocumentLedger);
    const documentLedgerContext = buildDocumentLedgerContext({
      artifactType: input.artifactType,
      ledgers: documentLedgers,
    });
    markPhase("ledgerbygging");

    setProgress(
      input.artifactType === "forbedret_kravsvar"
        ? "[18%] Kartlegger kravdokumenter og forbereder kravbesvarelse ..."
        : "[38%] Genererer nytt utkast med AI ...",
    );
    const serviceDescriptionDocuments = await serviceDescriptionDocumentsPromise;
    markPhase("tjenestedokumenthenting");

    setProgress(
      input.artifactType === "forbedret_kravsvar"
        ? "[22%] Klargjør semantiske dokumentutdrag ..."
        : "[40%] Klargjør semantiske dokumentutdrag ...",
    );
    await Promise.all([
      ...projectDocuments
        .filter((document) => document.raw_text.trim())
        .map((document) =>
          ensureProjectDocumentChunks({ document }).catch(() => undefined),
        ),
      ...serviceDescriptionDocuments
        .filter((document) => document.raw_text.trim())
        .map((document) =>
          ensureServiceDocumentChunks({ document }).catch(() => undefined),
        ),
    ]);
    markPhase("dokumentindeksering");

    const generated = await generateProjectArtifact({
      artifactType: input.artifactType,
      projectName: project.name,
      customerAnalysis,
      solutionEvaluation: project.solution_evaluation,
      customerDocument,
      solutionDocument,
      serviceDescriptionDocument,
      serviceDescriptionDocuments,
      serviceDocumentSummaries,
      supportingDocuments,
      requirementDocuments:
        input.artifactType === "forbedret_kravsvar" && selectedDocumentIds.size
          ? selectedRequirementDocuments
          : undefined,
      knowledgeArtifacts: generatedArtifacts,
      instructions: input.instructions?.trim(),
      model: input.model,
      onProgress:
        input.artifactType === "forbedret_kravsvar" ? setProgress : undefined,
      documentLedgerContext,
    });
    markPhase("ai_batcher");

    setProgress("[86%] Validerer og reparerer generatorresultatet ...");
    const repaired = repairGeneratedArtifactContent({
      artifactType: input.artifactType,
      contentMarkdown: generated.content_markdown,
    });
    if (repaired.repairedRows > 10) {
      throw new Error(
        `Generatorresultatet inneholdt ${repaired.repairedRows} rader fra innholdsfortegnelse. Jobben stoppes i stedet for å lagre feiloutput.`,
      );
    }
    const qualityReport = validateGeneratedArtifact({
      artifactType: input.artifactType,
      title: generated.title,
      contentMarkdown: repaired.contentMarkdown,
    });
    if (qualityReport.status === "fail") {
      throw new Error(
        `Generatorresultatet stoppet i kvalitetskontroll: ${qualityReport.issues.join(" ")}`,
      );
    }
    markPhase("validering");

    setProgress("[90%] Lagrer validert generatorresultat i prosjektet ...");
    const artifact = await saveGeneratedArtifact(
      input.projectId,
      input.artifactType,
      generated.title,
      repaired.contentMarkdown,
      {
        instructions: input.instructions?.trim() || "",
        customer_analysis_present: Boolean(customerAnalysis),
        solution_evaluation_present: Boolean(project.solution_evaluation),
        source_document_ids: selectedDocumentIds.size
          ? selectedRequirementDocuments.map((document) => document.id)
          : projectDocuments.map((document) => document.id),
        source_document_roles: (selectedDocumentIds.size
          ? selectedRequirementDocuments
          : projectDocuments
        ).map((document) => ({
          id: document.id,
          title: document.title,
          role: document.role,
          subtype: document.supporting_subtype,
        })),
        document_ledgers: summarizeDocumentLedgers(documentLedgers),
        artifact_quality_report: qualityReport,
        artifact_repair: {
          repaired_rows: repaired.repairedRows,
        },
        generation_timings: [
          ...phaseTimer.timings(),
          { phase: "total", duration_ms: phaseTimer.total() },
        ],
      },
    );
    markPhase("lagring");
    logJobPhase({
      jobId,
      kind: "artifact_generation",
      phase: "total",
      durationMs: phaseTimer.total(),
    });

    const projectSnapshot = await getProjectSnapshot(input.projectId);
    return {
      artifact,
      project: projectSnapshot,
    };
  };

  if (options.runNow) {
    await runRunner(jobId, runner);
  } else {
    await startRunner(jobId, runner);
  }

  return record;
}

export async function queueCustomerAnalysisJob(input: {
  projectId: string;
  model?: string;
}, options: QueueJobOptions = {}) {
  const jobId = options.jobId ?? randomUUID();
  const now = new Date().toISOString();
  const jobInput: QueuedProjectJobInput = {
    kind: "customer_analysis",
    projectId: input.projectId,
    model: input.model,
  };
  const record: ProjectJobRecord = {
    id: jobId,
    project_id: input.projectId,
    kind: "customer_analysis",
    status: "queued",
    message: "Køer kundeanalysen ...",
    created_at: now,
    updated_at: now,
    error: null,
    result: null,
  };

  if (!options.skipEnqueue) {
    await enqueueJob(record, jobInput);
  }

  const runner: JobRunner = async ({ setProgress }) => {
    const phaseTimer = createJobPhaseTimer(jobId, "customer_analysis");
    setProgress("Laster dokumentgrunnlag ...");
    const projectDocuments = await listProjectDocuments(input.projectId);
    const { projectDocuments: analysisDocuments } =
      splitServiceDescriptionDetails(projectDocuments);
    const { customerDocument, supportingDocuments } =
      selectProjectDocuments(analysisDocuments);
    phaseTimer.mark("dokumenthenting");

    if (!customerDocument) {
      throw new Error("Last opp minst ett dokument først.");
    }

    if (!customerDocument.raw_text.trim()) {
      throw new Error(
        "Dokumentgrunnlaget har ingen lesbar tekst. Last opp dokumentet på nytt som tekstbasert PDF/DOCX/Excel-fil, eller bruk OCR først.",
      );
    }

    setProgress("Analyserer kundedokumentet med AI ...");
    const result = await analyzeCustomerDocuments({
      projectName: customerDocument.title,
      customerDocument,
      supportingDocuments,
      model: input.model,
    });
    phaseTimer.mark("ai_analyse");

    setProgress("Lagrer kundeanalysen ...");
    const analysis = await saveCustomerAnalysis(
      input.projectId,
      [
        customerDocument.id,
        ...supportingDocuments.map((document) => document.id),
      ],
      result,
      {
        previousAnalysis: null,
        updatedSections: [...CUSTOMER_ANALYSIS_SECTIONS],
        historySource: "full_regeneration",
      },
    );
    phaseTimer.mark("lagring");
    logJobPhase({
      jobId,
      kind: "customer_analysis",
      phase: "total",
      durationMs: phaseTimer.total(),
    });

    const projectSnapshot = await getProjectSnapshot(input.projectId);
    return {
      analysis,
      project: projectSnapshot,
    };
  };

  if (options.runNow) {
    await runRunner(jobId, runner);
  } else {
    await startRunner(jobId, runner);
  }

  return record;
}

export async function queuePerfectSystemSolutionJob(input: {
  projectId: string;
  model?: string;
}, options: QueueJobOptions = {}) {
  const jobId = options.jobId ?? randomUUID();
  const now = new Date().toISOString();
  const jobInput: QueuedProjectJobInput = {
    kind: "perfect_system_solution",
    projectId: input.projectId,
    model: input.model,
  };
  const record: ProjectJobRecord = {
    id: jobId,
    project_id: input.projectId,
    kind: "perfect_system_solution",
    status: "queued",
    message: "Køer forbedring av systemløsningen ...",
    created_at: now,
    updated_at: now,
    error: null,
    result: null,
  };

  if (!options.skipEnqueue) {
    await enqueueJob(record, jobInput);
  }

  const runner: JobRunner = async ({ setProgress }) => {
    const phaseTimer = createJobPhaseTimer(jobId, "perfect_system_solution");
    setProgress("Laster vurdering, dokumenter og siste løsningsbeskrivelse ...");
    const [
      project,
      customerAnalysis,
      documents,
      generatedArtifacts,
      serviceDocumentSummaries,
    ] = await Promise.all([
      getProjectDetail(input.projectId),
      getCustomerAnalysis(input.projectId),
      listProjectDocuments(input.projectId),
      listGeneratedArtifacts(input.projectId),
      listServiceDocumentSummariesForProject(input.projectId),
    ]);
    const { projectDocuments, serviceDescriptionDocument } =
      splitServiceDescriptionDetails(documents);
    const { customerDocument, solutionDocument, supportingDocuments } =
      selectProjectDocuments(projectDocuments);
    phaseTimer.mark("dokumenthenting");

    if (!project.solution_evaluation) {
      throw new Error("Generer vurdering før du forbedrer systemløsningen.");
    }

    const systemScore =
      project.solution_evaluation.architecture_comparison
        ?.system_solution_score ?? 0;

    if (systemScore >= 100) {
      throw new Error("Systemløsningen har allerede 100/100 i vurderingen.");
    }
    const serviceDescriptionDocumentsPromise = serviceDocumentSummaries.length
      ? listServiceDocumentDetailsForProject(input.projectId, {
          documentIds: selectRelevantServiceDocumentIds({
            artifactType: "losningsutkast",
            projectName: project.name,
            customerAnalysis,
            instructions: "Forbedret systemløsning mot 100/100",
            serviceDocumentSummaries,
          }),
        })
      : listServiceDocumentDetailsForProject(input.projectId);

    setProgress("Skriver forbedret systemløsning mot 100/100 ...");
    const serviceDescriptionDocuments = await serviceDescriptionDocumentsPromise;
    phaseTimer.mark("tjenestedokumenthenting");

    const generated = await generateProjectArtifact({
      artifactType: "losningsutkast",
      projectName: project.name,
      customerAnalysis,
      solutionEvaluation: project.solution_evaluation,
      customerDocument,
      solutionDocument,
      serviceDescriptionDocument,
      serviceDescriptionDocuments,
      serviceDocumentSummaries,
      supportingDocuments,
      knowledgeArtifacts: generatedArtifacts,
      instructions: [
        `Systemløsningen scoret ${Math.round(systemScore)}/100 i siste vurdering.`,
        "Lag en ny, forbedret systemløsning som eksplisitt lukker alle gap som hindrer 100/100.",
        "Bruk improvement_recommendations, weaknesses, missing_elements, risks_to_customer, rewrite_suggestions og architecture_comparison.strategy_improvement_advice som endringsliste.",
        "Ikke bare kommenter hva som bør gjøres. Skriv inn endringene direkte i løsningsbeskrivelsen.",
        "Målet er en løsningsbeskrivelse som kan vurderes til 100/100 fordi den er kundespesifikk, komplett, gjennomførbar, risikoreduserende og tydelig differensiert.",
        "Hvis vurderingen peker på manglende overgangsmodell, beslutningspunkter, ansvar, risiko, bevis eller kundeverdi, skal dette konkret innarbeides i riktig seksjon.",
      ].join("\n"),
      model: input.model,
    });
    phaseTimer.mark("ai_generering");

    setProgress("Lagrer forbedret 100%-utkast ...");
    const artifact = await saveGeneratedArtifact(
      input.projectId,
      "losningsutkast",
      generated.title || "Forbedret systemløsning mot 100/100",
      generated.content_markdown,
      {
        generated_for: "perfect_system_solution",
        previous_system_solution_score: systemScore,
        source: "solution_evaluation_improvement",
      },
    );
    phaseTimer.mark("lagring");

    if (!customerDocument || !customerAnalysis || !solutionDocument) {
      logJobPhase({
        jobId,
        kind: "perfect_system_solution",
        phase: "total",
        durationMs: phaseTimer.total(),
      });
      const projectSnapshot = await getProjectSnapshot(input.projectId);
      return {
        artifact,
        project: projectSnapshot,
      };
    }

    setProgress("Kjører ny vurdering av forbedret systemløsning ...");
    const improvedEvaluation = await evaluateSolutionDocument({
      projectName: project.name,
      customerDocument,
      solutionDocument,
      supportingDocuments,
      customerAnalysis,
      systemSolutionArtifact: artifact,
      model: input.model,
    });
    phaseTimer.mark("ai_revaluering");

    await saveSolutionEvaluation(input.projectId, {
      customerDocumentId: customerDocument.id,
      solutionDocumentId: solutionDocument.id,
      result: improvedEvaluation,
    });
    phaseTimer.mark("vurderingslagring");
    logJobPhase({
      jobId,
      kind: "perfect_system_solution",
      phase: "total",
      durationMs: phaseTimer.total(),
    });

    const projectSnapshot = await getProjectSnapshot(input.projectId);
    return {
      artifact,
      project: projectSnapshot,
      evaluation: improvedEvaluation,
    };
  };

  if (options.runNow) {
    await runRunner(jobId, runner);
  } else {
    await startRunner(jobId, runner);
  }

  return record;
}

export async function queueSolutionEvaluationJob(input: {
  projectId: string;
  allowGeneratedSolution: boolean;
  solutionDocumentId?: string;
  model?: string;
}, options: QueueJobOptions = {}) {
  const jobId = options.jobId ?? randomUUID();
  const now = new Date().toISOString();
  const jobInput: QueuedProjectJobInput = {
    kind: "solution_evaluation",
    projectId: input.projectId,
    allowGeneratedSolution: input.allowGeneratedSolution,
    solutionDocumentId: input.solutionDocumentId,
    model: input.model,
  };
  const record: ProjectJobRecord = {
    id: jobId,
    project_id: input.projectId,
    kind: "solution_evaluation",
    status: "queued",
    message: "Køer løsningsvurderingen ...",
    created_at: now,
    updated_at: now,
    error: null,
    result: null,
  };

  if (!options.skipEnqueue) {
    await enqueueJob(record, jobInput);
  }

  const runner: JobRunner = async ({ setProgress }) => {
    const phaseTimer = createJobPhaseTimer(jobId, "solution_evaluation");
    setProgress("Laster kundedokument, analyse og støttedokumenter ...");
    const [projectDocuments, selectedSolutionDocument, customerAnalysis, generatedArtifacts] =
      await Promise.all([
        listProjectDocuments(input.projectId),
        input.solutionDocumentId
          ? getDocumentDetail(input.projectId, input.solutionDocumentId)
          : Promise.resolve(null),
        getCustomerAnalysis(input.projectId),
        listGeneratedArtifacts(input.projectId),
      ]);
    const { projectDocuments: evaluationDocuments } =
      splitServiceDescriptionDetails(projectDocuments);
    const selectedDocuments = selectProjectDocuments(evaluationDocuments);
    const customerDocument =
      selectedDocuments.customerDocument?.id === input.solutionDocumentId
        ? evaluationDocuments.find(
            (document) => document.id !== input.solutionDocumentId,
          ) ?? null
        : selectedDocuments.customerDocument;
    const solutionDocument =
      selectedSolutionDocument ?? selectedDocuments.solutionDocument ?? null;
    const supportingDocuments = evaluationDocuments.filter(
      (document) =>
        document.id !== customerDocument?.id && document.id !== solutionDocument?.id,
    );
    phaseTimer.mark("dokumenthenting");

    if (!customerDocument) {
      throw new Error("Last opp minst ett dokument først.");
    }

    if (!customerAnalysis) {
      throw new Error("Generer kundeanalyse før løsningsvurdering.");
    }

    setProgress("Bygger evalueringsledger fra krav, kriterier og dokumentstruktur ...");
    const evaluationLedgers = [
      customerDocument,
      solutionDocument,
      ...supportingDocuments,
    ]
      .filter(
        (document): document is ProjectDocumentDetail =>
          document !== null && Boolean(document.raw_text.trim()),
      )
      .slice(0, 8)
      .map(buildDocumentLedger);
    const evaluationLedgerContext = buildDocumentLedgerContext({
      artifactType: "gjennomforing_og_risiko",
      ledgers: evaluationLedgers,
    });
    phaseTimer.mark("ledgerbygging");

    if (!solutionDocument) {
      if (!input.allowGeneratedSolution) {
        throw new Error("Velg dokumentet som skal vurderes som arkitektløsning.");
      }

      setProgress("Genererer en kort intern løsningsbeskrivelse ...");
      const generated = await synthesizeAndEvaluateSolution({
        projectName: customerDocument.title,
        customerAnalysis,
        customerDocument,
        supportingDocuments,
        model: input.model,
        documentLedgerContext: evaluationLedgerContext,
      });
      phaseTimer.mark("ai_syntese_og_vurdering");

      setProgress("Lagrer systemgenerert utkast ...");
      const artifact = await saveGeneratedArtifact(
        input.projectId,
        "losningsutkast",
        generated.synthetic_solution.title,
        generated.synthetic_solution.content_markdown,
        {
          generated_for: "solution_evaluation_fallback",
          source: "system_generated_when_solution_document_missing",
        },
      );

      setProgress("Lagrer løsningsvurderingen ...");
      const evaluation = await saveSolutionEvaluation(input.projectId, {
        customerDocumentId: customerDocument.id,
        solutionDocumentId: null,
        result: generated.evaluation,
      });
      phaseTimer.mark("lagring");
      logJobPhase({
        jobId,
        kind: "solution_evaluation",
        phase: "total",
        durationMs: phaseTimer.total(),
      });

      const projectSnapshot = await getProjectSnapshot(input.projectId);
      return {
        evaluation,
        project: projectSnapshot,
        artifact,
        used_generated_solution: true,
      };
    }

    setProgress("Sammenligner systemløsning og importert arkitektløsning ...");
    const result = await evaluateSolutionDocument({
      projectName: customerDocument.title,
      customerDocument,
      solutionDocument,
      supportingDocuments,
      customerAnalysis,
      systemSolutionArtifact: getLatestSolutionDraft(generatedArtifacts),
      model: input.model,
      documentLedgerContext: evaluationLedgerContext,
    });
    phaseTimer.mark("ai_vurdering");

    setProgress("Lagrer sammenligning og vurdering ...");
    const evaluation = await saveSolutionEvaluation(input.projectId, {
      customerDocumentId: customerDocument.id,
      solutionDocumentId: solutionDocument.id,
      result,
    });
    phaseTimer.mark("lagring");
    logJobPhase({
      jobId,
      kind: "solution_evaluation",
      phase: "total",
      durationMs: phaseTimer.total(),
    });

    const projectSnapshot = await getProjectSnapshot(input.projectId);
    return {
      evaluation,
      project: projectSnapshot,
      artifact: null,
      used_generated_solution: false,
    };
  };

  if (options.runNow) {
    await runRunner(jobId, runner);
  } else {
    await startRunner(jobId, runner);
  }

  return record;
}

export async function queueHighLevelDesignJob(input: {
  projectId: string;
  model?: string;
}, options: QueueJobOptions = {}) {
  const jobId = options.jobId ?? randomUUID();
  const now = new Date().toISOString();
  const jobInput: QueuedProjectJobInput = {
    kind: "high_level_design",
    projectId: input.projectId,
    model: input.model,
  };
  const record: ProjectJobRecord = {
    id: jobId,
    project_id: input.projectId,
    kind: "high_level_design",
    status: "queued",
    message: "Køer high-level design ...",
    created_at: now,
    updated_at: now,
    error: null,
    result: null,
  };

  if (!options.skipEnqueue) {
    await enqueueJob(record, jobInput);
  }

  const runner: JobRunner = async ({ setProgress }) => {
    const phaseTimer = createJobPhaseTimer(jobId, "high_level_design");
    setProgress("Laster kundedokument, analyse og støttedokumenter ...");
    const [documents, customerAnalysis] =
      await Promise.all([
        listProjectDocuments(input.projectId),
        getCustomerAnalysis(input.projectId),
      ]);
    const { projectDocuments } = splitServiceDescriptionDetails(documents);
    const { customerDocument, supportingDocuments } =
      selectProjectDocuments(projectDocuments);
    phaseTimer.mark("dokumenthenting");

    if (!customerDocument) {
      throw new Error("Last opp minst ett dokument først.");
    }

    if (!customerAnalysis) {
      throw new Error(
        "Generer kundeanalyse først. High-level design bygger på eksisterende kundeanalyse.",
      );
    }

    setProgress("Genererer oppdatert high-level design og arkitekturdiagram ...");
    const highLevelDesign = await generateHighLevelDesign({
      projectName: customerDocument.title,
      customerDocument,
      supportingDocuments,
      customerAnalysis,
      model: input.model,
    });
    phaseTimer.mark("ai_design");

    setProgress("Lagrer oppdatert high-level design i kundeanalysen ...");
    const analysis = await saveCustomerAnalysis(
      input.projectId,
      [customerDocument.id, ...supportingDocuments.map((document) => document.id)],
      {
        ...customerAnalysis,
        high_level_solution_design: highLevelDesign.high_level_solution_design,
        high_level_architecture_mermaid:
          highLevelDesign.high_level_architecture_mermaid,
      },
      {
        previousAnalysis: customerAnalysis,
        updatedSections: ["design"],
        historySource: "high_level_design_update",
      },
    );
    phaseTimer.mark("lagring");
    logJobPhase({
      jobId,
      kind: "high_level_design",
      phase: "total",
      durationMs: phaseTimer.total(),
    });

    const projectSnapshot = await getProjectSnapshot(input.projectId);
    return {
      analysis,
      project: projectSnapshot,
    };
  };

  if (options.runNow) {
    await runRunner(jobId, runner);
  } else {
    await startRunner(jobId, runner);
  }

  return record;
}

export async function queueExecutiveSummaryJob(input: {
  projectId: string;
  model?: string;
}, options: QueueJobOptions = {}) {
  const jobId = options.jobId ?? randomUUID();
  const now = new Date().toISOString();
  const jobInput: QueuedProjectJobInput = {
    kind: "executive_summary",
    projectId: input.projectId,
    model: input.model,
  };
  const record: ProjectJobRecord = {
    id: jobId,
    project_id: input.projectId,
    kind: "executive_summary",
    status: "queued",
    message: "Køer lederoppsummering ...",
    created_at: now,
    updated_at: now,
    error: null,
    result: null,
  };

  if (!options.skipEnqueue) {
    await enqueueJob(record, jobInput);
  }

  const runner: JobRunner = async ({ setProgress }) => {
    const phaseTimer = createJobPhaseTimer(jobId, "executive_summary");
    setProgress("Laster prosjekt, kundeanalyse og vurdering ...");
    const [project, customerAnalysis, solutionEvaluation] = await Promise.all([
      getProjectDetail(input.projectId),
      getCustomerAnalysis(input.projectId),
      getSolutionEvaluation(input.projectId),
    ]);
    phaseTimer.mark("dokumenthenting");

    if (!solutionEvaluation) {
      throw new Error("Generer vurdering før lederoppsummering.");
    }

    setProgress("Genererer lederoppsummering ...");
    const generated = await generateExecutiveSummary({
      projectName: project.name,
      customerAnalysis,
      solutionEvaluation,
      model: input.model,
    });
    phaseTimer.mark("ai_oppsummering");

    setProgress("Lagrer lederoppsummeringen ...");
    const executiveSummary = await saveExecutiveSummary(input.projectId, generated, {
      source: "solution_evaluation",
      solution_evaluation_present: true,
      solution_evaluation_snapshot: {
        fit_to_customer_needs: solutionEvaluation.fit_to_customer_needs,
        likely_score_assessment: solutionEvaluation.likely_score_assessment,
        architecture_comparison: solutionEvaluation.architecture_comparison,
      },
    });
    phaseTimer.mark("lagring");
    logJobPhase({
      jobId,
      kind: "executive_summary",
      phase: "total",
      durationMs: phaseTimer.total(),
    });

    const projectSnapshot = await getProjectSnapshot(input.projectId);
    return {
      executive_summary: executiveSummary,
      project: projectSnapshot,
    };
  };

  if (options.runNow) {
    await runRunner(jobId, runner);
  } else {
    await startRunner(jobId, runner);
  }

  return record;
}

export async function runQueuedProjectJob(jobId: string) {
  const input = await getQueuedJobInput(jobId);
  if (!input) {
    return;
  }

  const options: QueueJobOptions = {
    jobId,
    skipEnqueue: true,
    runNow: true,
  };

  switch (input.kind) {
    case "customer_analysis":
      await queueCustomerAnalysisJob(
        { projectId: input.projectId, model: input.model },
        options,
      );
      return;
    case "solution_evaluation":
      await queueSolutionEvaluationJob(
        {
          projectId: input.projectId,
          allowGeneratedSolution: input.allowGeneratedSolution,
          solutionDocumentId: input.solutionDocumentId,
          model: input.model,
        },
        options,
      );
      return;
    case "artifact_generation":
      await queueArtifactGenerationJob(
        {
          projectId: input.projectId,
          artifactType: input.artifactType,
          instructions: input.instructions,
          sourceDocumentIds: input.sourceDocumentIds,
          model: input.model,
        },
        options,
      );
      return;
    case "high_level_design":
      await queueHighLevelDesignJob(
        { projectId: input.projectId, model: input.model },
        options,
      );
      return;
    case "perfect_system_solution":
      await queuePerfectSystemSolutionJob(
        { projectId: input.projectId, model: input.model },
        options,
      );
      return;
    case "executive_summary":
      await queueExecutiveSummaryJob(
        { projectId: input.projectId, model: input.model },
        options,
      );
      return;
  }
}
