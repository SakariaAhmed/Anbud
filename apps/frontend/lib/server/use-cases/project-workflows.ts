import "server-only";

import { CUSTOMER_ANALYSIS_SECTIONS } from "@/lib/customer-analysis-history";
import {
  buildDocumentLedger,
  buildDocumentLedgerContext,
} from "@/lib/server/document-ledger";
import {
  selectProjectDocuments,
  selectRelevantServiceDocumentIds,
} from "@/lib/server/domain/project-documents";
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
  getSolutionEvaluation,
  saveCustomerAnalysis,
  saveExecutiveSummary,
  saveSolutionEvaluation,
} from "@/lib/server/repositories/analyses";
import {
  listGeneratedArtifacts,
  saveGeneratedArtifact,
} from "@/lib/server/repositories/artifacts";
import {
  getDocumentDetail,
  listProjectDocuments,
} from "@/lib/server/repositories/documents";
import {
  getProjectDetail,
  getProjectSnapshot,
} from "@/lib/server/repositories/projects";
import {
  listServiceDocumentDetailsForProject,
  listServiceDocumentSummariesForProject,
} from "@/lib/server/repositories/services";
import { splitServiceDescriptionDetails } from "@/lib/service-description";
import type {
  GeneratedArtifact,
  GeneratedArtifactType,
  ProjectDocumentDetail,
  ProjectJobKind,
  ProjectJobResult,
} from "@/lib/types";
import {
  type ArtifactGenerationTiming,
  generateAndSaveProjectArtifact,
} from "@/lib/server/use-cases/generate-artifact";

export type ProjectWorkflowInput =
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

export type ProjectWorkflowPhaseHandler = (phase: string) => void;

export interface ProjectWorkflowHandlers {
  setProgress: (message: string) => void;
  onPhase?: ProjectWorkflowPhaseHandler;
  timings?: () => ArtifactGenerationTiming[];
  totalDurationMs?: () => number;
}

function getLatestSolutionDraft(
  artifacts: GeneratedArtifact[],
): GeneratedArtifact | null {
  return (
    artifacts.find((artifact) => artifact.artifact_type === "losningsutkast") ??
    null
  );
}

function readableDocument(
  document: ProjectDocumentDetail | null,
): document is ProjectDocumentDetail {
  return Boolean(document?.raw_text.trim());
}

function assertWorkflowKind(
  value: unknown,
): asserts value is ProjectWorkflowInput {
  if (!value || typeof value !== "object" || !("kind" in value)) {
    throw new Error("Prosjektjobben mangler gyldig kjøredata.");
  }
}

export function workflowKind(input: ProjectWorkflowInput): ProjectJobKind {
  return input.kind;
}

export function parseProjectWorkflowInput(value: unknown): ProjectWorkflowInput {
  assertWorkflowKind(value);
  return value;
}

export async function runCustomerAnalysisWorkflow(
  input: Extract<ProjectWorkflowInput, { kind: "customer_analysis" }>,
  handlers: ProjectWorkflowHandlers,
) {
  handlers.setProgress("Laster dokumentgrunnlag ...");
  const projectDocuments = await listProjectDocuments(input.projectId);
  const { projectDocuments: analysisDocuments } =
    splitServiceDescriptionDetails(projectDocuments);
  const { customerDocument, supportingDocuments } =
    selectProjectDocuments(analysisDocuments);
  handlers.onPhase?.("dokumenthenting");

  if (!customerDocument) {
    throw new Error("Last opp minst ett dokument først.");
  }

  if (!customerDocument.raw_text.trim()) {
    throw new Error(
      "Dokumentgrunnlaget har ingen lesbar tekst. Last opp dokumentet på nytt som tekstbasert PDF/DOCX/Excel-fil, eller bruk OCR først.",
    );
  }

  handlers.setProgress("Analyserer kundedokumentet med AI ...");
  const result = await analyzeCustomerDocuments({
    projectName: customerDocument.title,
    customerDocument,
    supportingDocuments,
    model: input.model,
  });
  handlers.onPhase?.("ai_analyse");

  handlers.setProgress("Lagrer kundeanalysen ...");
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
  handlers.onPhase?.("lagring");

  return {
    analysis,
    project: await getProjectSnapshot(input.projectId),
  };
}

export async function runArtifactGenerationWorkflow(
  input: Extract<ProjectWorkflowInput, { kind: "artifact_generation" }>,
  handlers: ProjectWorkflowHandlers,
) {
  return generateAndSaveProjectArtifact({
    projectId: input.projectId,
    artifactType: input.artifactType,
    instructions: input.instructions,
    sourceDocumentIds: input.sourceDocumentIds,
    model: input.model,
    ensureSemanticChunks: true,
    onProgress: handlers.setProgress,
    onPhase: handlers.onPhase,
    timings: handlers.timings,
    totalDurationMs: handlers.totalDurationMs,
  });
}

export async function runSolutionEvaluationWorkflow(
  input: Extract<ProjectWorkflowInput, { kind: "solution_evaluation" }>,
  handlers: ProjectWorkflowHandlers,
) {
  handlers.setProgress("Laster kundedokument, analyse og støttedokumenter ...");
  const [
    projectDocuments,
    selectedSolutionDocument,
    customerAnalysis,
    generatedArtifacts,
  ] = await Promise.all([
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
  handlers.onPhase?.("dokumenthenting");

  if (!customerDocument) {
    throw new Error("Last opp minst ett dokument først.");
  }

  if (!customerAnalysis) {
    throw new Error("Generer kundeanalyse før løsningsvurdering.");
  }

  handlers.setProgress(
    "Bygger evalueringsledger fra krav, kriterier og dokumentstruktur ...",
  );
  const evaluationLedgers = [
    customerDocument,
    solutionDocument,
    ...supportingDocuments,
  ]
    .filter(readableDocument)
    .slice(0, 8)
    .map(buildDocumentLedger);
  const evaluationLedgerContext = buildDocumentLedgerContext({
    artifactType: "gjennomforing_og_risiko",
    ledgers: evaluationLedgers,
  });
  handlers.onPhase?.("ledgerbygging");

  if (!solutionDocument) {
    if (!input.allowGeneratedSolution) {
      throw new Error("Velg dokumentet som skal vurderes som arkitektløsning.");
    }

    handlers.setProgress("Genererer en kort intern løsningsbeskrivelse ...");
    const generated = await synthesizeAndEvaluateSolution({
      projectName: customerDocument.title,
      customerAnalysis,
      customerDocument,
      supportingDocuments,
      model: input.model,
      documentLedgerContext: evaluationLedgerContext,
    });
    handlers.onPhase?.("ai_syntese_og_vurdering");

    handlers.setProgress("Lagrer systemgenerert utkast ...");
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

    handlers.setProgress("Lagrer løsningsvurderingen ...");
    const evaluation = await saveSolutionEvaluation(input.projectId, {
      customerDocumentId: customerDocument.id,
      solutionDocumentId: null,
      result: generated.evaluation,
    });
    handlers.onPhase?.("lagring");

    return {
      evaluation,
      project: await getProjectSnapshot(input.projectId),
      artifact,
      used_generated_solution: true,
    };
  }

  handlers.setProgress(
    "Sammenligner systemløsning og importert arkitektløsning ...",
  );
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
  handlers.onPhase?.("ai_vurdering");

  handlers.setProgress("Lagrer sammenligning og vurdering ...");
  const evaluation = await saveSolutionEvaluation(input.projectId, {
    customerDocumentId: customerDocument.id,
    solutionDocumentId: solutionDocument.id,
    result,
  });
  handlers.onPhase?.("lagring");

  return {
    evaluation,
    project: await getProjectSnapshot(input.projectId),
    artifact: null,
    used_generated_solution: false,
  };
}

export async function runHighLevelDesignWorkflow(
  input: Extract<ProjectWorkflowInput, { kind: "high_level_design" }>,
  handlers: ProjectWorkflowHandlers,
) {
  handlers.setProgress("Laster kundedokument, analyse og støttedokumenter ...");
  const [documents, customerAnalysis] = await Promise.all([
    listProjectDocuments(input.projectId),
    getCustomerAnalysis(input.projectId),
  ]);
  const { projectDocuments } = splitServiceDescriptionDetails(documents);
  const { customerDocument, supportingDocuments } =
    selectProjectDocuments(projectDocuments);
  handlers.onPhase?.("dokumenthenting");

  if (!customerDocument) {
    throw new Error("Last opp minst ett dokument først.");
  }

  if (!customerAnalysis) {
    throw new Error(
      "Generer kundeanalyse først. High-level design bygger på eksisterende kundeanalyse.",
    );
  }

  handlers.setProgress(
    "Genererer oppdatert high-level design og arkitekturdiagram ...",
  );
  const highLevelDesign = await generateHighLevelDesign({
    projectName: customerDocument.title,
    customerDocument,
    supportingDocuments,
    customerAnalysis,
    model: input.model,
  });
  handlers.onPhase?.("ai_design");

  handlers.setProgress("Lagrer oppdatert high-level design i kundeanalysen ...");
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
  handlers.onPhase?.("lagring");

  return {
    analysis,
    project: await getProjectSnapshot(input.projectId),
  };
}

export async function runExecutiveSummaryWorkflow(
  input: Extract<ProjectWorkflowInput, { kind: "executive_summary" }>,
  handlers: ProjectWorkflowHandlers,
) {
  handlers.setProgress("Laster prosjekt, kundeanalyse og vurdering ...");
  const [project, customerAnalysis, solutionEvaluation] = await Promise.all([
    getProjectDetail(input.projectId),
    getCustomerAnalysis(input.projectId),
    getSolutionEvaluation(input.projectId),
  ]);
  handlers.onPhase?.("dokumenthenting");

  if (!solutionEvaluation) {
    throw new Error("Generer vurdering før lederoppsummering.");
  }

  handlers.setProgress("Genererer lederoppsummering ...");
  const generated = await generateExecutiveSummary({
    projectName: project.name,
    customerAnalysis,
    solutionEvaluation,
    model: input.model,
  });
  handlers.onPhase?.("ai_oppsummering");

  handlers.setProgress("Lagrer lederoppsummeringen ...");
  const executiveSummary = await saveExecutiveSummary(input.projectId, generated, {
    source: "solution_evaluation",
    solution_evaluation_present: true,
    solution_evaluation_snapshot: {
      fit_to_customer_needs: solutionEvaluation.fit_to_customer_needs,
      likely_score_assessment: solutionEvaluation.likely_score_assessment,
      architecture_comparison: solutionEvaluation.architecture_comparison,
    },
  });
  handlers.onPhase?.("lagring");

  return {
    executive_summary: executiveSummary,
    project: await getProjectSnapshot(input.projectId),
  };
}

export async function runPerfectSystemSolutionWorkflow(
  input: Extract<ProjectWorkflowInput, { kind: "perfect_system_solution" }>,
  handlers: ProjectWorkflowHandlers,
) {
  handlers.setProgress("Laster vurdering, dokumenter og siste løsningsbeskrivelse ...");
  const project = await getProjectDetail(input.projectId);
  handlers.onPhase?.("prosjekthenting");

  if (!project.solution_evaluation) {
    throw new Error("Generer vurdering før du forbedrer systemløsningen.");
  }

  const systemScore =
    project.solution_evaluation.architecture_comparison?.system_solution_score ??
    0;

  if (systemScore >= 100) {
    throw new Error("Systemløsningen har allerede 100/100 i vurderingen.");
  }

  const instructions = [
    `Systemløsningen scoret ${Math.round(systemScore)}/100 i siste vurdering.`,
    "Lag en ny, forbedret systemløsning som eksplisitt lukker alle gap som hindrer 100/100.",
    "Bruk improvement_recommendations, weaknesses, missing_elements, risks_to_customer, rewrite_suggestions og architecture_comparison.strategy_improvement_advice som endringsliste.",
    "Ikke bare kommenter hva som bør gjøres. Skriv inn endringene direkte i løsningsbeskrivelsen.",
    "Målet er en løsningsbeskrivelse som kan vurderes til 100/100 fordi den er kundespesifikk, komplett, gjennomførbar, risikoreduserende og tydelig differensiert.",
    "Hvis vurderingen peker på manglende overgangsmodell, beslutningspunkter, ansvar, risiko, bevis eller kundeverdi, skal dette konkret innarbeides i riktig seksjon.",
  ].join("\n");

  handlers.setProgress("Skriver forbedret systemløsning mot 100/100 ...");
  const { artifact } = await generateAndSaveProjectArtifact({
    projectId: input.projectId,
    artifactType: "losningsutkast",
    instructions,
    model: input.model,
    inputSnapshotExtra: {
      generated_for: "perfect_system_solution",
      previous_system_solution_score: systemScore,
      source: "solution_evaluation_improvement",
    },
    ensureSemanticChunks: true,
    onProgress: handlers.setProgress,
    onPhase: handlers.onPhase,
    timings: handlers.timings,
    totalDurationMs: handlers.totalDurationMs,
  });

  handlers.setProgress("Laster dokumentgrunnlag for ny vurdering ...");
  const [customerAnalysis, documents] = await Promise.all([
    getCustomerAnalysis(input.projectId),
    listProjectDocuments(input.projectId),
  ]);
  const { projectDocuments } = splitServiceDescriptionDetails(documents);
  const { customerDocument, solutionDocument, supportingDocuments } =
    selectProjectDocuments(projectDocuments);
  handlers.onPhase?.("revalueringsgrunnlag");

  if (!customerDocument || !customerAnalysis || !solutionDocument) {
    return {
      artifact,
      project: await getProjectSnapshot(input.projectId),
    };
  }

  handlers.setProgress("Kjører ny vurdering av forbedret systemløsning ...");
  const improvedEvaluation = await evaluateSolutionDocument({
    projectName: project.name,
    customerDocument,
    solutionDocument,
    supportingDocuments,
    customerAnalysis,
    systemSolutionArtifact: artifact,
    model: input.model,
  });
  handlers.onPhase?.("ai_revaluering");

  await saveSolutionEvaluation(input.projectId, {
    customerDocumentId: customerDocument.id,
    solutionDocumentId: solutionDocument.id,
    result: improvedEvaluation,
  });
  handlers.onPhase?.("vurderingslagring");

  return {
    artifact,
    project: await getProjectSnapshot(input.projectId),
    evaluation: improvedEvaluation,
  };
}

export async function runProjectWorkflow(
  input: ProjectWorkflowInput,
  handlers: ProjectWorkflowHandlers,
): Promise<ProjectJobResult> {
  switch (input.kind) {
    case "customer_analysis":
      return runCustomerAnalysisWorkflow(input, handlers);
    case "solution_evaluation":
      return runSolutionEvaluationWorkflow(input, handlers);
    case "artifact_generation":
      return runArtifactGenerationWorkflow(input, handlers);
    case "high_level_design":
      return runHighLevelDesignWorkflow(input, handlers);
    case "perfect_system_solution":
      return runPerfectSystemSolutionWorkflow(input, handlers);
    case "executive_summary":
      return runExecutiveSummaryWorkflow(input, handlers);
  }
}
