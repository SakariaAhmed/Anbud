import type { WorkflowStepStatus } from "@/components/projects/project-workspace-types";
import type {
  GeneratedArtifact,
  GeneratedArtifactAuthorityByType,
  GeneratedArtifactType,
  ProjectDetail,
  ProjectSnapshotResult,
} from "@/lib/types";

export function prependGeneratedArtifactVersion(
  artifacts: GeneratedArtifact[],
  artifact: GeneratedArtifact,
) {
  return [
    { ...artifact, is_current: true },
    ...artifacts
      .filter((item) => item.id !== artifact.id)
      .map((item) =>
        item.artifact_type === artifact.artifact_type
          ? { ...item, is_current: false }
          : item,
      ),
  ];
}

export function mergeGeneratedArtifactsForType(
  current: GeneratedArtifact[],
  incoming: GeneratedArtifact[],
  artifactType: GeneratedArtifactType,
) {
  const incomingIds = new Set(incoming.map((artifact) => artifact.id));
  return [
    ...incoming,
    ...current.filter(
      (artifact) =>
        artifact.artifact_type !== artifactType && !incomingIds.has(artifact.id),
    ),
  ];
}

export function reconcileGeneratedArtifactAuthority(
  artifacts: GeneratedArtifact[],
  authority: GeneratedArtifactAuthorityByType | undefined,
) {
  if (!authority) {
    return artifacts;
  }

  return artifacts.map((artifact) => {
    const record = authority[artifact.artifact_type];
    const isCurrent =
      record?.id === artifact.id &&
      record.artifact_version === artifact.artifact_version;
    return {
      ...artifact,
      is_current: isCurrent,
      source_is_current: isCurrent
        ? record.source_is_current
        : artifact.source_is_current,
    };
  });
}

export function loadedArtifactTypesMissingAuthorityVersion(
  artifacts: GeneratedArtifact[],
  authority: GeneratedArtifactAuthorityByType,
  loadedArtifactTypes: GeneratedArtifactType[],
) {
  const loadedTypes = new Set(loadedArtifactTypes);
  return (Object.entries(authority) as Array<
    [GeneratedArtifactType, GeneratedArtifactAuthorityByType[GeneratedArtifactType]]
  >)
    .filter(([artifactType, record]) => {
      if (!record || !loadedTypes.has(artifactType)) {
        return false;
      }
      return !artifacts.some(
        (artifact) =>
          artifact.artifact_type === artifactType &&
          artifact.id === record.id &&
          artifact.artifact_version === record.artifact_version,
      );
    })
    .map(([artifactType]) => artifactType);
}

export function hasAuthoritativeCurrentArtifact(
  project: Pick<
    ProjectDetail,
    "artifact_authority" | "current_artifact_types" | "generated_artifacts"
  >,
  artifactType: GeneratedArtifactType,
) {
  if (project.artifact_authority) {
    return project.artifact_authority[artifactType]?.source_is_current === true;
  }
  if (project.current_artifact_types) {
    return project.current_artifact_types.includes(artifactType);
  }
  return project.generated_artifacts.some(
    (artifact) =>
      artifact.artifact_type === artifactType &&
      artifact.is_current === true &&
      artifact.source_is_current === true,
  );
}

export function canEditGeneratedArtifact(artifact: GeneratedArtifact) {
  return artifact.is_current === true && artifact.source_is_current === true;
}

export function createLatestArtifactAuthorityRequestGate() {
  let latestSequence = 0;
  return {
    start() {
      latestSequence += 1;
      return latestSequence;
    },
    isLatest(sequence: number) {
      return sequence === latestSequence;
    },
  };
}

export function applyProjectSnapshot(
  project: ProjectDetail,
  snapshot: ProjectSnapshotResult,
  options: { invalidateExecutiveSummary?: boolean } = {},
): ProjectDetail {
  const solutionEvaluationGenerated = snapshot.solution_evaluation_generated;
  const executiveSummaryGenerated =
    solutionEvaluationGenerated && !options.invalidateExecutiveSummary;
  const currentArtifactTypes =
    snapshot.current_artifact_types ?? project.current_artifact_types;
  const artifactAuthority =
    snapshot.artifact_authority ?? project.artifact_authority;
  return {
    ...project,
    ...snapshot,
    customer_analysis: snapshot.customer_analysis_generated
      ? project.customer_analysis
      : null,
    solution_evaluation: solutionEvaluationGenerated
      ? project.solution_evaluation
      : null,
    executive_summary: executiveSummaryGenerated
      ? project.executive_summary
      : null,
    has_executive_summary: executiveSummaryGenerated
      ? project.has_executive_summary
      : false,
    current_artifact_types: currentArtifactTypes,
    artifact_authority: artifactAuthority,
    generated_artifacts: reconcileGeneratedArtifactAuthority(
      project.generated_artifacts,
      artifactAuthority,
    ),
  };
}

export function solutionProposalWorkflowStatus(input: {
  hasGeneratedSolutionDescription: boolean;
  hasReadyEvaluationBasis: boolean;
  hasCustomerAnalysis: boolean;
}): WorkflowStepStatus {
  if (input.hasGeneratedSolutionDescription) {
    return "Generert";
  }

  if (input.hasReadyEvaluationBasis || input.hasCustomerAnalysis) {
    return "Klar";
  }

  return "Venter";
}
