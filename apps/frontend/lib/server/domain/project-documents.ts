import type {
  GeneratedArtifactType,
  ProjectDocumentDetail,
  ServiceDocument,
} from "@/lib/types";
import {
  isFormalRequirementDocument,
  isHistoricalSolutionDocument,
} from "@/lib/document-processing";

export function isArtifactType(value: string): value is GeneratedArtifactType {
  return (
    value === "losningsutkast" ||
    value === "bilag1_rekonstruksjon" ||
    value === "forbedret_kravsvar" ||
    value === "gjennomforing_og_risiko"
  );
}

function serviceDocumentLimitForArtifact(
  artifactType: GeneratedArtifactType,
) {
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

export function selectRelevantServiceDocumentIds(input: {
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

export function selectProjectDocuments(documents: ProjectDocumentDetail[]) {
  const primarySolutionDocument =
    documents.find((document) => document.role === "primary_solution_document") ??
    null;
  const customerDocument =
    documents.find((document) => document.role === "primary_customer_document") ??
    documents.find(
      (document) =>
        document.id !== primarySolutionDocument?.id &&
        document.role !== "primary_solution_document" &&
        !isHistoricalSolutionDocument(document),
    ) ??
    null;
  const solutionDocument =
    primarySolutionDocument ??
    documents.find(
      (document) =>
        document.id !== customerDocument?.id &&
        !isHistoricalSolutionDocument(document) &&
        !isFormalRequirementDocument(document) &&
        /løsn|losn|solution|arkitektur|architecture/i.test(
          `${document.title} ${document.file_name}`,
        ),
    ) ??
    null;
  const supportingDocuments = documents.filter(
    (document) =>
      document.id !== customerDocument?.id &&
      document.id !== solutionDocument?.id &&
      !isHistoricalSolutionDocument(document),
  );

  return { customerDocument, solutionDocument, supportingDocuments };
}
