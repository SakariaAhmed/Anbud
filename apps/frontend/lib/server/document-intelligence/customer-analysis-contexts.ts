import "server-only";

import { compileDocumentIntelligenceArtifact } from "@/lib/server/document-intelligence/evidence-compiler";
import { isCurrentDocumentIntelligenceContext } from "@/lib/server/document-intelligence/customer-analysis-context";
import { isHighImpactDocument } from "@/lib/server/document-intelligence/document-policy";
import {
  listDocumentIntelligenceContexts,
  storeDocumentIntelligenceArtifact,
  type DocumentIntelligenceContext,
} from "@/lib/server/document-intelligence/repository";
import type { DocumentIntelligenceArtifact } from "@/lib/server/document-intelligence/types";
import type { ProjectDocumentDetail } from "@/lib/types";

type CustomerAnalysisContextDependencies = {
  listContexts: typeof listDocumentIntelligenceContexts;
  compileArtifact: typeof compileDocumentIntelligenceArtifact;
  storeArtifact: typeof storeDocumentIntelligenceArtifact;
  now: () => string;
  warn: (fields: Record<string, unknown>) => void;
};

const defaultDependencies: CustomerAnalysisContextDependencies = {
  listContexts: listDocumentIntelligenceContexts,
  compileArtifact: compileDocumentIntelligenceArtifact,
  storeArtifact: storeDocumentIntelligenceArtifact,
  now: () => new Date().toISOString(),
  warn: (fields) => console.warn(JSON.stringify(fields)),
};

export type ResolvedCustomerAnalysisContexts = {
  contexts: Map<string, DocumentIntelligenceContext>;
  compiledOnDemandCount: number;
  persistenceFailureCount: number;
};

export async function resolveCustomerAnalysisContexts(input: {
  projectId: string;
  documents: ProjectDocumentDetail[];
  dependencies?: Partial<CustomerAnalysisContextDependencies>;
}): Promise<ResolvedCustomerAnalysisContexts> {
  const dependencies = {
    ...defaultDependencies,
    ...input.dependencies,
  };
  const documentsById = new Map(
    input.documents.map((document) => [document.id, document]),
  );
  const storedContexts = await dependencies
    .listContexts({
      projectId: input.projectId,
      documentIds: input.documents.map((document) => document.id),
    })
    .catch((error) => {
      dependencies.warn({
        event: "customer_analysis_context_list_failed",
        project_id: input.projectId,
        error_type: error instanceof Error ? error.name : "UnknownError",
      });
      return [];
    });
  const contexts = new Map(
    storedContexts
      .filter((context) => {
        const document = documentsById.get(context.documentId);
        return (
          document &&
          isCurrentDocumentIntelligenceContext({
            sourceRevision: context.sourceRevision,
            documentSourceRevision: document.chunk_source_revision,
            compilerVersion: context.compilerVersion,
          })
        );
      })
      .map((context) => [context.documentId, context]),
  );

  const compiled: DocumentIntelligenceArtifact[] = [];
  for (const document of input.documents) {
    if (contexts.has(document.id)) continue;
    const artifact = dependencies.compileArtifact({
      documentId: document.id,
      projectId: document.project_id,
      title: document.title,
      fileName: document.file_name,
      fileFormat: document.file_format,
      fileSizeBytes: document.file_size_bytes,
      sourceRevision: document.chunk_source_revision,
      parserUsed: document.parser_used ?? "unknown",
      rawText: document.raw_text,
      structureMap: document.structure_map,
      isHighImpactDocument: isHighImpactDocument(document),
      compiledAt: dependencies.now(),
    });
    compiled.push(artifact);
    contexts.set(document.id, {
      documentId: artifact.documentId,
      sourceRevision: artifact.sourceRevision,
      compilerVersion: artifact.compilerVersion,
      parserUsed: artifact.parserUsed,
      quality: artifact.routing.quality,
      evidenceCounts: artifact.evidenceCounts,
      analysisContext: artifact.analysisContext,
    });
  }

  const persistenceResults = await Promise.allSettled(
    compiled.map(async (artifact) => ({
      artifact,
      stored: await dependencies.storeArtifact(artifact),
    })),
  );
  let persistenceFailureCount = 0;
  for (const [index, result] of persistenceResults.entries()) {
    const artifact = compiled[index];
    const failed = result.status === "rejected" || result.value.stored !== true;
    if (!failed) continue;
    persistenceFailureCount += 1;
    dependencies.warn({
      event: "compiled_on_demand_persist_failed",
      project_id: input.projectId,
      document_id: artifact?.documentId ?? null,
      source_revision: artifact?.sourceRevision ?? null,
      failure_type:
        result.status === "rejected"
          ? result.reason instanceof Error
            ? result.reason.name
            : "UnknownError"
          : "ArtifactNotStored",
    });
  }

  return {
    contexts,
    compiledOnDemandCount: compiled.length,
    persistenceFailureCount,
  };
}
