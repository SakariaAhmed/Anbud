"use client";

import { useCallback } from "react";

import { prefetchProjectTabData } from "@/lib/client/project-api";

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

export function useProjectWorkspacePrefetch({
  projectId,
  customerAnalysisGenerated,
  solutionEvaluationGenerated,
  artifactCount,
  analysisLoaded,
  evaluationLoaded,
  executiveSummaryLoaded,
  artifactsLoaded,
}: {
  projectId: string;
  customerAnalysisGenerated: boolean;
  solutionEvaluationGenerated: boolean;
  artifactCount: number;
  analysisLoaded: boolean;
  evaluationLoaded: boolean;
  executiveSummaryLoaded: boolean;
  artifactsLoaded: boolean;
}) {
  return useCallback(
    (tab: PrefetchableProjectWorkspaceTab) => {
      void workspaceTabPreloaders[tab]?.();
      if (tab === "analysis" && analysisLoaded) return;
      if (tab === "evaluation" && evaluationLoaded) return;
      if (tab === "executive-summary" && executiveSummaryLoaded) return;
      if (
        (tab === "generator" ||
          tab === "delivery" ||
          tab === "requirements" ||
          tab === "bilag1") &&
        artifactsLoaded
      ) {
        return;
      }

      void prefetchProjectTabData(projectId, tab, {
        customerAnalysisGenerated,
        solutionEvaluationGenerated,
        artifactCount,
      });
    },
    [
      analysisLoaded,
      artifactCount,
      artifactsLoaded,
      customerAnalysisGenerated,
      evaluationLoaded,
      executiveSummaryLoaded,
      projectId,
      solutionEvaluationGenerated,
    ],
  );
}
