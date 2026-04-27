import "server-only";

import { randomUUID } from "node:crypto";

import {
  evaluateSolutionDocument,
  generateHighLevelDesign,
  generateProjectArtifact,
  synthesizeAndEvaluateSolution,
} from "@/lib/server/ai";
import {
  getCustomerAnalysis,
  getPrimaryDocument,
  getProjectDetail,
  getProjectSnapshot,
  listGeneratedArtifacts,
  listSupportingDocuments,
  saveCustomerAnalysis,
  saveGeneratedArtifact,
  saveSolutionEvaluation,
} from "@/lib/server/projects-db";
import type {
  GeneratedArtifact,
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

function getLatestSolutionDraft(
  artifacts: GeneratedArtifact[],
): GeneratedArtifact | null {
  return (
    artifacts.find((artifact) => artifact.artifact_type === "losningsutkast") ??
    null
  );
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
    const [
      project,
      customerAnalysis,
      customerDocument,
      solutionDocument,
      supportingDocuments,
      generatedArtifacts,
    ] = await Promise.all([
      getProjectDetail(input.projectId),
      getCustomerAnalysis(input.projectId),
      getPrimaryDocument(input.projectId, "primary_customer_document"),
      getPrimaryDocument(input.projectId, "primary_solution_document"),
      listSupportingDocuments(input.projectId),
      listGeneratedArtifacts(input.projectId),
    ]);

    setProgress("Genererer nytt utkast med AI ...");
    const generated = await generateProjectArtifact({
      artifactType: input.artifactType,
      projectName: project.name,
      customerAnalysis,
      solutionEvaluation: project.solution_evaluation,
      customerDocument,
      solutionDocument,
      supportingDocuments,
      knowledgeArtifacts: generatedArtifacts,
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

export function queuePerfectSystemSolutionJob(input: { projectId: string }) {
  const jobId = randomUUID();
  const now = new Date().toISOString();
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

  getStore().set(jobId, record);

  startRunner(jobId, async ({ setProgress }) => {
    setProgress("Laster vurdering, dokumenter og siste løsningsutkast ...");
    const [
      project,
      customerAnalysis,
      customerDocument,
      solutionDocument,
      supportingDocuments,
      generatedArtifacts,
    ] = await Promise.all([
      getProjectDetail(input.projectId),
      getCustomerAnalysis(input.projectId),
      getPrimaryDocument(input.projectId, "primary_customer_document"),
      getPrimaryDocument(input.projectId, "primary_solution_document"),
      listSupportingDocuments(input.projectId),
      listGeneratedArtifacts(input.projectId),
    ]);

    if (!project.solution_evaluation) {
      throw new Error("Generer vurdering før du forbedrer systemløsningen.");
    }

    const systemScore =
      project.solution_evaluation.architecture_comparison
        ?.system_solution_score ?? 0;

    if (systemScore >= 100) {
      throw new Error("Systemløsningen har allerede 100/100 i vurderingen.");
    }

    setProgress("Skriver forbedret systemløsning mot 100/100 ...");
    const generated = await generateProjectArtifact({
      artifactType: "losningsutkast",
      projectName: project.name,
      customerAnalysis,
      solutionEvaluation: project.solution_evaluation,
      customerDocument,
      solutionDocument,
      supportingDocuments,
      knowledgeArtifacts: generatedArtifacts,
      instructions: [
        `Systemløsningen scoret ${Math.round(systemScore)}/100 i siste vurdering.`,
        "Lag en ny, forbedret systemløsning som eksplisitt lukker alle gap som hindrer 100/100.",
        "Bruk improvement_recommendations, weaknesses, missing_elements, risks_to_customer, rewrite_suggestions og architecture_comparison.strategy_improvement_advice som endringsliste.",
        "Ikke bare kommenter hva som bør gjøres. Skriv inn endringene direkte i løsningsutkastet.",
        "Målet er et løsningsutkast som kan vurderes til 100/100 fordi det er kundespesifikt, komplett, gjennomførbart, risikoreduserende og tydelig differensiert.",
        "Hvis vurderingen peker på manglende overgangsmodell, beslutningspunkter, ansvar, risiko, bevis eller kundeverdi, skal dette konkret innarbeides i riktig seksjon.",
      ].join("\n"),
    });

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

    if (!customerDocument || !customerAnalysis || !solutionDocument) {
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
    });

    await saveSolutionEvaluation(input.projectId, {
      customerDocumentId: customerDocument.id,
      solutionDocumentId: solutionDocument.id,
      result: improvedEvaluation,
    });

    const projectSnapshot = await getProjectSnapshot(input.projectId);
    return {
      artifact,
      project: projectSnapshot,
      evaluation: improvedEvaluation,
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
    const [
      customerDocument,
      solutionDocument,
      supportingDocuments,
      customerAnalysis,
      generatedArtifacts,
    ] = await Promise.all([
      getPrimaryDocument(input.projectId, "primary_customer_document"),
      getPrimaryDocument(input.projectId, "primary_solution_document"),
      listSupportingDocuments(input.projectId),
      getCustomerAnalysis(input.projectId),
      listGeneratedArtifacts(input.projectId),
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

    setProgress("Sammenligner systemløsning og importert arkitektløsning ...");
    const result = await evaluateSolutionDocument({
      projectName: customerDocument.title,
      customerDocument,
      solutionDocument,
      supportingDocuments,
      customerAnalysis,
      systemSolutionArtifact: getLatestSolutionDraft(generatedArtifacts),
    });

    setProgress("Lagrer sammenligning og vurdering ...");
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

export function queueHighLevelDesignJob(input: { projectId: string }) {
  const jobId = randomUUID();
  const now = new Date().toISOString();
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

  getStore().set(jobId, record);

  startRunner(jobId, async ({ setProgress }) => {
    setProgress("Laster kundedokument, analyse og støttedokumenter ...");
    const [customerDocument, supportingDocuments, customerAnalysis] =
      await Promise.all([
        getPrimaryDocument(input.projectId, "primary_customer_document"),
        listSupportingDocuments(input.projectId),
        getCustomerAnalysis(input.projectId),
      ]);

    if (!customerDocument) {
      throw new Error("Last opp et primært kundedokument først.");
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
    });

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

    const projectSnapshot = await getProjectSnapshot(input.projectId);
    return {
      analysis,
      project: projectSnapshot,
    };
  });

  return record;
}
