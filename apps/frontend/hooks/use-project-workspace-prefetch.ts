"use client";

import { useCallback } from "react";

import { prefetchProjectTabData } from "@/lib/client/project-api";
import type { GeneratedArtifactType } from "@/lib/types";

type PrefetchableProjectWorkspaceTab =
  | "documents"
  | "analysis"
  | "bilag1"
  | "service-description"
  | "requirements"
  | "generator"
  | "evaluation"
  | "delivery"
  | "executive-summary";

const workspaceTabPreloaders: Partial<
  Record<PrefetchableProjectWorkspaceTab, () => Promise<unknown>>
> = {
  analysis: () => import("@/components/projects/project-analysis-tab"),
  bilag1: () => import("@/components/projects/project-bilag1-tab"),
  "service-description": () =>
    import("@/components/projects/project-service-description-tab"),
  requirements: () =>
    import("@/components/projects/project-requirement-response-tab"),
  generator: () => import("@/components/projects/project-generator-tab"),
  evaluation: () => import("@/components/projects/project-evaluation-tab"),
  delivery: () => import("@/components/projects/project-delivery-tab"),
  "executive-summary": () =>
    import("@/components/projects/project-executive-summary-tab"),
};

const artifactTypeByTab: Partial<
  Record<PrefetchableProjectWorkspaceTab, GeneratedArtifactType>
> = {
  bilag1: "bilag1_rekonstruksjon",
  delivery: "gjennomforing_og_risiko",
  generator: "losningsutkast",
  requirements: "forbedret_kravsvar",
};

export function useProjectWorkspacePrefetch({
  projectId,
  customerAnalysisGenerated,
  solutionEvaluationGenerated,
  artifactCount,
  analysisLoaded,
  evaluationLoaded,
  executiveSummaryLoaded,
  loadedArtifactTypes,
}: {
  projectId: string;
  customerAnalysisGenerated: boolean;
  solutionEvaluationGenerated: boolean;
  artifactCount: number;
  analysisLoaded: boolean;
  evaluationLoaded: boolean;
  executiveSummaryLoaded: boolean;
  loadedArtifactTypes: GeneratedArtifactType[];
}) {
  return useCallback(
    (tab: PrefetchableProjectWorkspaceTab) => {
      void workspaceTabPreloaders[tab]?.();
      if (tab === "analysis" && analysisLoaded) return;
      if (tab === "evaluation" && evaluationLoaded) return;
      if (tab === "executive-summary" && executiveSummaryLoaded) return;
      const artifactType = artifactTypeByTab[tab];
      if (
        artifactType &&
        (artifactCount === 0 || loadedArtifactTypes.includes(artifactType))
      ) {
        return;
      }

      void prefetchProjectTabData(projectId, tab, {
        customerAnalysisGenerated,
        solutionEvaluationGenerated,
        artifactCount,
        artifactType,
      });
    },
    [
      analysisLoaded,
      artifactCount,
      customerAnalysisGenerated,
      evaluationLoaded,
      executiveSummaryLoaded,
      loadedArtifactTypes,
      projectId,
      solutionEvaluationGenerated,
    ],
  );
}
