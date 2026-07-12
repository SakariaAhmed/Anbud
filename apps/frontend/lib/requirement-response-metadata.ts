export type RequirementResponseArtifactMetadata = {
  ledgerConfidence?: {
    level?: string;
    score?: number;
    requirement_count?: number;
  };
  fallbackAfterHandoff: number;
  unresolvedFallbackAnswers: Array<{
    nr: number;
    ref: string;
    reason?: string;
  }>;
  manualReviewRequired: boolean;
  manualReviewNote?: string;
  templateRepairCount: number;
  templateRepairRefs: string[];
  templateRepairRows: Array<{
    ref: string;
    orderIndex?: number;
    sourceDocumentId?: string;
    sourceLocator?: string;
  }>;
  controlRepairCount: number;
  controlRepairRefs: string[];
  controlRepairRows: Array<{
    ref: string;
    pattern?: string;
    repairStage?: "pre_handoff" | "handoff";
    orderIndex?: number;
    sourceDocumentId?: string;
    sourceLocator?: string;
  }>;
  proposalInputRequiredCount: number;
  proposalInputRequiredRefs: string[];
  proposalInputRequiredRows: Array<{
    ref: string;
    reasons: string[];
    orderIndex?: number;
    sourceDocumentId?: string;
    sourceLocator?: string;
  }>;
};

export function deterministicRepairCount(
  metadata: Pick<
    RequirementResponseArtifactMetadata,
    "templateRepairCount" | "controlRepairCount"
  >,
) {
  return metadata.templateRepairCount + metadata.controlRepairCount;
}

export function requirementResponseManualReviewBadgeLabel(
  metadata: Pick<
    RequirementResponseArtifactMetadata,
    | "templateRepairCount"
    | "controlRepairCount"
    | "proposalInputRequiredCount"
  >,
) {
  const repairCount = deterministicRepairCount(metadata);
  const proposalCount = metadata.proposalInputRequiredCount;
  if (repairCount > 0 && proposalCount > 0) {
    return `${repairCount} deterministisk reparert${repairCount === 1 ? " krav" : "e krav"} · ${proposalCount} med tilbudsinput`;
  }
  if (repairCount > 0) {
    return `${repairCount} krav krever manuell gjennomgang`;
  }
  if (proposalCount > 0) {
    return `${proposalCount} krav trenger tilbudsinput`;
  }
  return "Manuell gjennomgang påkrevd";
}

export function shouldShowDeterministicRepairAcknowledgement(
  metadata: Pick<
    RequirementResponseArtifactMetadata,
    "templateRepairCount" | "controlRepairCount"
  >,
  isEditing: boolean,
) {
  return isEditing && deterministicRepairCount(metadata) > 0;
}

export function deterministicControlPatternLabel(pattern?: string) {
  const labels: Record<string, string> = {
    timed_reminder: "Tidsstyrte påminnelser",
    historical_migration: "Historisk migrering",
    audit_change_log: "Endringslogg",
    backup_restore: "Backup og gjenoppretting",
    acceptance_test: "Akseptansetest",
    no_manual_spreadsheet: "Arbeidsflyt uten regneark",
    structured_export: "Strukturert eksport",
    api_source_bound: "Kildebundet API-kontrakt",
    api_calendar_identity: "API for kalender og identitet",
    api_membership_register: "API for medlemsregister",
    automatic_notification_access: "Varsling og tilgang",
    dimensioning_supplier_baseline: "Dimensjonering og ytelse",
  };
  return pattern ? labels[pattern] : undefined;
}

export function deterministicRepairStageLabel(
  stage?: "pre_handoff" | "handoff",
) {
  return stage === "pre_handoff"
    ? "Reparert før AI-handoff"
    : stage === "handoff"
      ? "Reparert under AI-handoff"
      : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nonNegativeInteger(value: unknown) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.round(value))
    : 0;
}

function reviewRowIdentity(value: Record<string, unknown>) {
  return {
    orderIndex:
      typeof value.order_index === "number" &&
      Number.isSafeInteger(value.order_index) &&
      value.order_index >= 0
        ? value.order_index
        : undefined,
    sourceDocumentId:
      typeof value.source_document_id === "string" &&
      value.source_document_id.trim()
        ? value.source_document_id.trim()
        : undefined,
    sourceLocator:
      typeof value.source_locator === "string" && value.source_locator.trim()
        ? value.source_locator.trim()
        : undefined,
  };
}

function deterministicRepairStage(
  value: unknown,
): "pre_handoff" | "handoff" | undefined {
  return value === "pre_handoff" || value === "handoff" ? value : undefined;
}

export function requirementResponseArtifactMetadata(
  inputSnapshot: unknown,
): RequirementResponseArtifactMetadata {
  const snapshot = isRecord(inputSnapshot) ? inputSnapshot : {};
  const generationMetadata = isRecord(snapshot.generation_metadata)
    ? snapshot.generation_metadata
    : {};
  const requirementResponse = isRecord(generationMetadata.requirement_response)
    ? generationMetadata.requirement_response
    : {};
  const fallbackAfterHandoff = nonNegativeInteger(
    requirementResponse.deterministic_fallback_answers_after_handoff,
  );
  const unresolvedFallbackAnswers = Array.isArray(
    requirementResponse.unresolved_fallback_answers,
  )
    ? requirementResponse.unresolved_fallback_answers
        .map((value) => (isRecord(value) ? value : null))
        .filter((value): value is Record<string, unknown> => Boolean(value))
        .map((value) => ({
          nr:
            typeof value.nr === "number" && Number.isFinite(value.nr)
              ? Math.round(value.nr)
              : 0,
          ref: typeof value.ref === "string" ? value.ref.trim() : "",
          reason: typeof value.reason === "string" ? value.reason.trim() : undefined,
        }))
        .filter((value) => value.nr > 0 && value.ref)
    : [];
  const templateRepairCount = nonNegativeInteger(
    requirementResponse.deterministic_template_repair_answers,
  );
  const templateRepairRows = Array.isArray(
    requirementResponse.deterministic_template_repair_rows,
  )
    ? requirementResponse.deterministic_template_repair_rows
        .map((value) => (isRecord(value) ? value : null))
        .filter((value): value is Record<string, unknown> => Boolean(value))
        .map((value) => ({
          ref: typeof value.ref === "string" ? value.ref.trim() : "",
          ...reviewRowIdentity(value),
        }))
        .filter((value) => value.ref)
    : [];
  const templateRepairRefs = templateRepairRows.length
    ? templateRepairRows.map((row) => row.ref)
    : Array.isArray(requirementResponse.deterministic_template_repair_refs)
      ? requirementResponse.deterministic_template_repair_refs
          .filter((value): value is string => typeof value === "string")
          .map((value) => value.replace(/\s+/g, " ").trim())
          .filter(Boolean)
      : [];
  const controlRepairRows = Array.isArray(
    requirementResponse.deterministic_control_repair_rows,
  )
    ? requirementResponse.deterministic_control_repair_rows
        .map((value) => (isRecord(value) ? value : null))
        .filter((value): value is Record<string, unknown> => Boolean(value))
        .map((value) => ({
          ref: typeof value.ref === "string" ? value.ref.trim() : "",
          pattern:
            typeof value.pattern === "string" && value.pattern.trim()
              ? value.pattern.trim()
              : undefined,
          repairStage: deterministicRepairStage(value.repair_stage),
          ...reviewRowIdentity(value),
        }))
        .filter((value) => value.ref)
    : [];
  const controlRepairRefs = controlRepairRows.length
    ? controlRepairRows.map((row) => row.ref)
    : Array.isArray(requirementResponse.deterministic_control_repair_refs)
        ? requirementResponse.deterministic_control_repair_refs
            .filter((value): value is string => typeof value === "string")
            .map((value) => value.replace(/\s+/g, " ").trim())
            .filter(Boolean)
        : [];
  const controlRepairCount = Math.max(
    nonNegativeInteger(
      requirementResponse.deterministic_control_repair_answers,
    ),
    controlRepairRefs.length,
  );
  const proposalInputRequiredRows = Array.isArray(
    requirementResponse.proposal_input_required_rows,
  )
    ? requirementResponse.proposal_input_required_rows
        .map((value) => (isRecord(value) ? value : null))
        .filter((value): value is Record<string, unknown> => Boolean(value))
        .map((value) => ({
          ref: typeof value.ref === "string" ? value.ref.trim() : "",
          reasons: Array.isArray(value.reasons)
            ? Array.from(
                new Set(
                  value.reasons
                    .filter(
                      (reason): reason is string => typeof reason === "string",
                    )
                    .map((reason) => reason.trim())
                    .filter(Boolean),
                ),
              )
            : [],
          ...reviewRowIdentity(value),
        }))
        .filter((value) => value.ref && value.reasons.length)
    : [];
  const proposalInputRequiredRefs = proposalInputRequiredRows.length
    ? proposalInputRequiredRows.map((row) => row.ref)
    : Array.isArray(requirementResponse.proposal_input_required_refs)
        ? requirementResponse.proposal_input_required_refs
            .filter((value): value is string => typeof value === "string")
            .map((value) => value.replace(/\s+/g, " ").trim())
            .filter(Boolean)
        : [];
  const proposalInputRequiredCount = Math.max(
    nonNegativeInteger(requirementResponse.proposal_input_required_count),
    proposalInputRequiredRefs.length,
  );
  const manualReviewRequired =
    requirementResponse.manual_review_required === true ||
    templateRepairCount > 0 ||
    templateRepairRefs.length > 0 ||
    controlRepairCount > 0 ||
    proposalInputRequiredCount > 0;
  const manualReviewNote =
    typeof requirementResponse.manual_review_note === "string" &&
    requirementResponse.manual_review_note.trim()
      ? requirementResponse.manual_review_note.trim()
      : undefined;
  const ledgerConfidence = isRecord(requirementResponse.ledger_confidence)
    ? {
        level:
          typeof requirementResponse.ledger_confidence.level === "string"
            ? requirementResponse.ledger_confidence.level
            : undefined,
        score:
          typeof requirementResponse.ledger_confidence.score === "number" &&
          Number.isFinite(requirementResponse.ledger_confidence.score)
            ? requirementResponse.ledger_confidence.score
            : undefined,
        requirement_count:
          typeof requirementResponse.ledger_confidence.requirement_count ===
            "number" &&
          Number.isFinite(
            requirementResponse.ledger_confidence.requirement_count,
          )
            ? requirementResponse.ledger_confidence.requirement_count
            : undefined,
      }
    : undefined;

  return {
    ledgerConfidence,
    fallbackAfterHandoff: Math.max(
      fallbackAfterHandoff,
      unresolvedFallbackAnswers.length,
    ),
    unresolvedFallbackAnswers,
    manualReviewRequired,
    manualReviewNote,
    templateRepairCount: Math.max(templateRepairCount, templateRepairRefs.length),
    templateRepairRefs,
    templateRepairRows,
    controlRepairCount,
    controlRepairRefs,
    controlRepairRows,
    proposalInputRequiredCount,
    proposalInputRequiredRefs,
    proposalInputRequiredRows,
  };
}
