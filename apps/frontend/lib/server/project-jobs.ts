import "server-only";

import { randomUUID } from "node:crypto";

import { CUSTOMER_ANALYSIS_SECTIONS } from "@/lib/customer-analysis-history";
import {
  analyzeCustomerDocuments,
  evaluateSolutionDocument,
  generateHighLevelDesign,
  generateProjectArtifact,
  synthesizeAndEvaluateSolution,
} from "@/lib/server/ai";
import {
  getCustomerAnalysis,
  getDocumentDetail,
  getProjectDetail,
  getProjectSnapshot,
  listGeneratedArtifacts,
  listProjectDocuments,
  listServiceDocumentDetailsForProject,
  saveCustomerAnalysis,
  saveGeneratedArtifact,
  saveSolutionEvaluation,
} from "@/lib/server/projects-db";
import { splitServiceDescriptionDetails } from "@/lib/service-description";
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
  sourceDocumentIds?: string[];
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
      documents,
      generatedArtifacts,
      serviceDescriptionDocuments,
    ] = await Promise.all([
      getProjectDetail(input.projectId),
      getCustomerAnalysis(input.projectId),
      listProjectDocuments(input.projectId),
      listGeneratedArtifacts(input.projectId),
      listServiceDocumentDetailsForProject(input.projectId),
    ]);
    const { projectDocuments, serviceDescriptionDocument } =
      splitServiceDescriptionDetails(documents);
    const selectedDocumentIds = new Set(input.sourceDocumentIds ?? []);
    const scopedProjectDocuments = selectedDocumentIds.size
      ? projectDocuments.filter((document) => selectedDocumentIds.has(document.id))
      : projectDocuments;
    const customerDocument = scopedProjectDocuments[0] ?? null;
    const solutionDocument = scopedProjectDocuments[1] ?? null;
    const supportingDocuments = scopedProjectDocuments.filter(
      (document) =>
        document.id !== customerDocument?.id &&
        document.id !== solutionDocument?.id,
    );

    setProgress("Genererer nytt utkast med AI ...");
    const generated = await generateProjectArtifact({
      artifactType: input.artifactType,
      projectName: project.name,
      customerAnalysis,
      solutionEvaluation: project.solution_evaluation,
      customerDocument,
      solutionDocument,
      serviceDescriptionDocument,
      serviceDescriptionDocuments,
      supportingDocuments,
      requirementDocuments:
        input.artifactType === "forbedret_kravsvar" && selectedDocumentIds.size
          ? scopedProjectDocuments
          : undefined,
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
        source_document_ids: input.sourceDocumentIds ?? [],
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

export function queueCustomerAnalysisJob(input: { projectId: string }) {
  const jobId = randomUUID();
  const now = new Date().toISOString();
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

  getStore().set(jobId, record);

  startRunner(jobId, async ({ setProgress }) => {
    setProgress("Laster dokumentgrunnlag ...");
    const projectDocuments = await listProjectDocuments(input.projectId);
    const { projectDocuments: analysisDocuments } =
      splitServiceDescriptionDetails(projectDocuments);
    const [customerDocument, ...supportingDocuments] = analysisDocuments;

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
    });

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

    const projectSnapshot = await getProjectSnapshot(input.projectId);
    return {
      analysis,
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
    setProgress("Laster vurdering, dokumenter og siste løsningsbeskrivelse ...");
    const [
      project,
      customerAnalysis,
      documents,
      generatedArtifacts,
      serviceDescriptionDocuments,
    ] = await Promise.all([
      getProjectDetail(input.projectId),
      getCustomerAnalysis(input.projectId),
      listProjectDocuments(input.projectId),
      listGeneratedArtifacts(input.projectId),
      listServiceDocumentDetailsForProject(input.projectId),
    ]);
    const { projectDocuments, serviceDescriptionDocument } =
      splitServiceDescriptionDetails(documents);
    const customerDocument = projectDocuments[0] ?? null;
    const solutionDocument = projectDocuments[1] ?? null;
    const supportingDocuments = projectDocuments.filter(
      (document) =>
        document.id !== customerDocument?.id &&
        document.id !== solutionDocument?.id,
    );

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
      serviceDescriptionDocument,
      serviceDescriptionDocuments,
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
  solutionDocumentId?: string;
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
    const customerDocument =
      evaluationDocuments.find((document) => document.id !== input.solutionDocumentId) ??
      evaluationDocuments[0] ??
      null;
    const solutionDocument =
      selectedSolutionDocument ?? null;
    const supportingDocuments = evaluationDocuments.filter(
      (document) =>
        document.id !== customerDocument?.id && document.id !== solutionDocument?.id,
    );

    if (!customerDocument) {
      throw new Error("Last opp minst ett dokument først.");
    }

    if (!customerAnalysis) {
      throw new Error("Generer kundeanalyse før løsningsvurdering.");
    }

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
    const [documents, customerAnalysis] =
      await Promise.all([
        listProjectDocuments(input.projectId),
        getCustomerAnalysis(input.projectId),
      ]);
    const { projectDocuments } = splitServiceDescriptionDetails(documents);
    const customerDocument = projectDocuments[0] ?? null;
    const supportingDocuments = projectDocuments.slice(1);

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
