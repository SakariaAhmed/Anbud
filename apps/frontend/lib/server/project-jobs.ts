import "server-only";

import { randomUUID } from "node:crypto";

import { generateProjectArtifact, evaluateSolutionDocument, synthesizeAndEvaluateSolution } from "@/lib/server/ai";
import {
  getCustomerAnalysis,
  getPrimaryDocument,
  getProjectDetail,
  getProjectSnapshot,
  listSupportingDocuments,
  saveGeneratedArtifact,
  saveSolutionEvaluation,
} from "@/lib/server/projects-db";
import type {
  GeneratedArtifactType,
  ProjectJobRecord,
  ProjectJobResult,
} from "@/lib/types";

type JobRunner = (helpers: { setProgress: (message: string) => void }) => Promise<ProjectJobResult>;

type JobStore = Map<string, ProjectJobRecord>;

declare global {
  // eslint-disable-next-line no-var
  var __anbudProjectJobs: JobStore | undefined;
}

function getStore() {
  if (!globalThis.__anbudProjectJobs) {
    globalThis.__anbudProjectJobs = new Map<string, ProjectJobRecord>();
  }

  return globalThis.__anbudProjectJobs;
}

function updateJob(jobId: string, patch: Partial<ProjectJobRecord>) {
  const store = getStore();
  const current = store.get(jobId);
  if (!current) {
    return;
  }

  store.set(jobId, {
    ...current,
    ...patch,
    updated_at: new Date().toISOString(),
  });
}

export function getProjectJob(projectId: string, jobId: string) {
  const record = getStore().get(jobId) ?? null;
  if (!record || record.project_id !== projectId) {
    return null;
  }

  return record;
}

function startRunner(jobId: string, runner: JobRunner) {
  setTimeout(async () => {
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
  }, 0);
}

export function queueArtifactGenerationJob(input: {
  projectId: string;
  artifactType: GeneratedArtifactType;
  instructions?: string;
}) {
  const jobId = randomUUID();
  const now = new Date().toISOString();
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

  getStore().set(jobId, record);

  startRunner(jobId, async ({ setProgress }) => {
    setProgress("Laster prosjektkontekst og relevante dokumenter ...");
    const [project, customerAnalysis, customerDocument, solutionDocument] = await Promise.all([
      getProjectDetail(input.projectId),
      getCustomerAnalysis(input.projectId),
      getPrimaryDocument(input.projectId, "primary_customer_document"),
      getPrimaryDocument(input.projectId, "primary_solution_document"),
    ]);

    setProgress("Genererer nytt utkast med AI ...");
    const generated = await generateProjectArtifact({
      artifactType: input.artifactType,
      projectName: project.name,
      customerAnalysis,
      solutionEvaluation: project.solution_evaluation,
      customerDocument,
      solutionDocument,
      instructions: input.instructions?.trim(),
    });

    setProgress("Lagrer generatorresultatet i prosjektet ...");
    const artifact = await saveGeneratedArtifact(
      input.projectId,
      input.artifactType,
      generated.title,
      generated.content_markdown,
      {
        instructions: input.instructions?.trim() || "",
        customer_analysis_present: Boolean(customerAnalysis),
        solution_evaluation_present: Boolean(project.solution_evaluation),
      },
    );

    const projectSnapshot = await getProjectSnapshot(input.projectId);
    return {
      artifact,
      project: projectSnapshot,
    };
  });

  return record;
}

export function queueSolutionEvaluationJob(input: {
  projectId: string;
  allowGeneratedSolution: boolean;
}) {
  const jobId = randomUUID();
  const now = new Date().toISOString();
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

  getStore().set(jobId, record);

  startRunner(jobId, async ({ setProgress }) => {
    setProgress("Laster kundedokument, analyse og støttedokumenter ...");
    const [customerDocument, solutionDocument, supportingDocuments, customerAnalysis] = await Promise.all([
      getPrimaryDocument(input.projectId, "primary_customer_document"),
      getPrimaryDocument(input.projectId, "primary_solution_document"),
      listSupportingDocuments(input.projectId),
      getCustomerAnalysis(input.projectId),
    ]);

    if (!customerDocument) {
      throw new Error("Last opp et primært kundedokument først.");
    }

    if (!customerAnalysis) {
      throw new Error("Generer kundeanalyse før løsningsvurdering.");
    }

    if (!solutionDocument) {
      if (!input.allowGeneratedSolution) {
        throw new Error("Last opp et primært løsningsdokument først, eller godkjenn at systemet genererer et internt utkast.");
      }

      setProgress("Genererer et kort internt løsningsutkast ...");
      const generated = await synthesizeAndEvaluateSolution({
        projectName: customerDocument.title,
        customerAnalysis,
        customerDocument,
        supportingDocuments,
      });

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

      const projectSnapshot = await getProjectSnapshot(input.projectId);
      return {
        evaluation,
        project: projectSnapshot,
        artifact,
        used_generated_solution: true,
      };
    }

    setProgress("Vurderer løsningsdokumentet mot kundebehovene ...");
    const result = await evaluateSolutionDocument({
      projectName: customerDocument.title,
      customerDocument,
      solutionDocument,
      supportingDocuments,
      customerAnalysis,
    });

    setProgress("Lagrer løsningsvurderingen ...");
    const evaluation = await saveSolutionEvaluation(input.projectId, {
      customerDocumentId: customerDocument.id,
      solutionDocumentId: solutionDocument.id,
      result,
    });

    const projectSnapshot = await getProjectSnapshot(input.projectId);
    return {
      evaluation,
      project: projectSnapshot,
      artifact: null,
      used_generated_solution: false,
    };
  });

  return record;
}
