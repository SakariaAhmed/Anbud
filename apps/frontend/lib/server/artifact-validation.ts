import "server-only";

import { createHash } from "node:crypto";

import {
  isMarkdownSeparatorRow,
  splitMarkdownTableRow,
} from "@/lib/server/requirements/markdown-table";
import type { GeneratedArtifactType } from "@/lib/types";

export type ArtifactQualityStatus = "pass" | "warning" | "fail";

export type ArtifactQualityCheck = {
  label: string;
  value: string | number | boolean;
  status: ArtifactQualityStatus;
  severity: "info" | "warning" | "high";
};

export type ArtifactQualityReport = {
  status: ArtifactQualityStatus;
  metrics: {
    requirementRows: number;
    expectedRequirementRows: number;
    missingExpectedRequirements: number;
    extraRequirementRows: number;
    outOfOrderExpectedRequirements: number;
    unresolvedFallbackAnswers: number;
    tocRows: number;
    dotLeaderRows: number;
    emptyAnswers: number;
    missingAnswerEvidence: number;
    missingSources: number;
    duplicateRequirementTexts: number;
    emptySections: number;
  };
  checks: ArtifactQualityCheck[];
  issues: string[];
};

export type RequirementQualityExpectations = {
  expectedRequirementCount?: number;
  expectedRequirementRefs?: string[];
  unresolvedFallbackAnswers?: number;
};

export type ImmutableRequirementRowManifestEntry = {
  order_index: number;
  ref: string;
  requirement_text_normalized: string;
  source_locator: string;
  source_document_id: string | null;
  row_sha256: string;
};

export type ImmutableRequirementRowManifest = {
  version: 1;
  rows: ImmutableRequirementRowManifestEntry[];
  manifest_sha256: string;
};

type MarkdownTable = {
  header: string[];
  rows: string[][];
  rawRows: string[];
};

const DOT_LEADER_PATTERN = /\.{4,}\s*\d{1,4}\s*$/;

function normalize(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeImmutableRowValue(value: unknown) {
  return String(value ?? "").normalize("NFKC").replace(/\s+/g, " ").trim();
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function immutableRequirementRowPayload(input: {
  orderIndex: number;
  ref: unknown;
  requirementText: unknown;
  sourceLocator: unknown;
  sourceDocumentId?: unknown;
}) {
  return {
    order_index: input.orderIndex,
    ref: normalizeImmutableRowValue(input.ref),
    requirement_text_normalized: normalizeImmutableRowValue(
      input.requirementText,
    ),
    source_locator: normalizeImmutableRowValue(input.sourceLocator),
    source_document_id:
      normalizeImmutableRowValue(input.sourceDocumentId) || null,
  };
}

export function buildImmutableRequirementRowManifest(
  rows: Array<{
    ref: string;
    requirementText: string;
    sourceLocator: string;
    sourceDocumentId?: string | null;
  }>,
): ImmutableRequirementRowManifest {
  const manifestRows = rows.map((row, orderIndex) => {
    const payload = immutableRequirementRowPayload({
      orderIndex,
      ref: row.ref,
      requirementText: row.requirementText,
      sourceLocator: row.sourceLocator,
      sourceDocumentId: row.sourceDocumentId,
    });
    return {
      ...payload,
      row_sha256: sha256(JSON.stringify(payload)),
    };
  });

  return {
    version: 1,
    rows: manifestRows,
    manifest_sha256: sha256(JSON.stringify(manifestRows)),
  };
}

function normalizeRequirementRef(value: string) {
  return normalize(value)
    .toLowerCase()
    .replace(/\s*-\s*/g, "-")
    .replace(/\s*\.\s*/g, ".")
    .replace(/^krav\s*(?:nr\.?|nummer)?\s*/i, "krav ")
    .replace(/^id\s*/i, "id ")
    .replace(/^req\s*[- ]?\s*/i, "req-");
}

function requirementRefVariants(value: string) {
  const normalized = normalizeRequirementRef(value);
  return Array.from(
    new Set([
      normalized,
      normalized.replace(/\s+/g, ""),
      normalized.replace(/^id\s+/i, "id"),
      normalized.replace(/^krav\s+/i, "krav"),
    ].filter(Boolean)),
  );
}

function normalizeRequirementRefComparable(value: string) {
  return normalizeRequirementRef(value)
    .replace(/[^a-z0-9æøå]+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function requirementRefMatchesExpected(rowRef: string, expectedRef: string) {
  const rowVariants = new Set(requirementRefVariants(rowRef));
  if (
    requirementRefVariants(expectedRef).some((variant) =>
      rowVariants.has(variant),
    )
  ) {
    return true;
  }

  const rowComparable = normalizeRequirementRefComparable(rowRef);
  const expectedComparable = normalizeRequirementRefComparable(expectedRef);
  return Boolean(rowComparable && expectedComparable && rowComparable === expectedComparable);
}

function parseMarkdownTables(markdown: string) {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const tables: MarkdownTable[] = [];
  let current: string[] = [];

  function flush() {
    if (current.length < 2) {
      current = [];
      return;
    }

    const nonDivider = current.filter((line) => !isMarkdownSeparatorRow(line));
    if (nonDivider.length >= 2) {
      tables.push({
        header: splitMarkdownTableRow(nonDivider[0]),
        rows: nonDivider.slice(1).map(splitMarkdownTableRow),
        rawRows: nonDivider.slice(1),
      });
    }
    current = [];
  }

  for (const line of lines) {
    if (line.trim().startsWith("|")) {
      current.push(line);
    } else {
      flush();
    }
  }
  flush();

  return tables;
}

function isRequirementTable(table: MarkdownTable) {
  const header = table.header.map((cell) => cell.toLowerCase());
  return (
    header.some((cell) => cell.includes("kravref")) &&
    header.some((cell) => cell === "krav") &&
    header.some((cell) => cell === "svar")
  );
}

function getColumnIndex(table: MarkdownTable, pattern: RegExp) {
  return table.header.findIndex((cell) => pattern.test(cell));
}

function detectEmptySections(markdown: string) {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  let emptySections = 0;

  for (let index = 0; index < lines.length; index += 1) {
    if (!/^#{2,4}\s+\S/.test(lines[index].trim())) continue;
    const nextContent = lines
      .slice(index + 1)
      .find((line) => line.trim() && !/^#{2,4}\s+\S/.test(line.trim()));
    if (!nextContent) emptySections += 1;
  }

  return emptySections;
}

function statusFromHighIssues(highIssues: number, warnings: number): ArtifactQualityStatus {
  if (highIssues > 0) return "fail";
  if (warnings > 0) return "warning";
  return "pass";
}

export function requirementQualityExpectations(
  metadata: unknown,
): RequirementQualityExpectations {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return {};
  }

  const requirementResponse = (
    metadata as {
      requirement_response?: {
        total_requirements?: unknown;
        requirement_refs?: unknown;
        deterministic_fallback_answers_after_handoff?: unknown;
        unresolved_fallback_answers?: unknown;
      };
    }
  ).requirement_response;

  if (
    !requirementResponse ||
    typeof requirementResponse !== "object" ||
    Array.isArray(requirementResponse)
  ) {
    return {};
  }

  const totalRequirements =
    typeof requirementResponse.total_requirements === "number" &&
    Number.isFinite(requirementResponse.total_requirements)
      ? Math.max(0, Math.round(requirementResponse.total_requirements))
      : undefined;
  const requirementRefs = Array.isArray(requirementResponse.requirement_refs)
    ? requirementResponse.requirement_refs
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.replace(/\s+/g, " ").trim())
        .filter(Boolean)
    : undefined;
  const unresolvedFallbackAnswers =
    typeof requirementResponse.deterministic_fallback_answers_after_handoff ===
      "number" &&
    Number.isFinite(
      requirementResponse.deterministic_fallback_answers_after_handoff,
    )
      ? Math.max(
          0,
          Math.round(
            requirementResponse.deterministic_fallback_answers_after_handoff,
          ),
        )
      : Array.isArray(requirementResponse.unresolved_fallback_answers)
        ? requirementResponse.unresolved_fallback_answers.length
        : undefined;

  return {
    expectedRequirementCount: totalRequirements,
    expectedRequirementRefs: requirementRefs,
    unresolvedFallbackAnswers,
  };
}

function inputSnapshotRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
}

function readImmutableRequirementRowManifest(
  value: unknown,
): ImmutableRequirementRowManifest | null {
  const manifest = inputSnapshotRecord(value);
  if (
    manifest.version !== 1 ||
    !Array.isArray(manifest.rows) ||
    typeof manifest.manifest_sha256 !== "string" ||
    !manifest.manifest_sha256
  ) {
    return null;
  }

  const rows: ImmutableRequirementRowManifestEntry[] = [];
  for (const [index, value] of manifest.rows.entries()) {
    const row = inputSnapshotRecord(value);
    if (
      row.order_index !== index ||
      typeof row.ref !== "string" ||
      !row.ref ||
      typeof row.requirement_text_normalized !== "string" ||
      !row.requirement_text_normalized ||
      typeof row.source_locator !== "string" ||
      !row.source_locator ||
      !(
        row.source_document_id === null ||
        typeof row.source_document_id === "string"
      ) ||
      typeof row.row_sha256 !== "string"
    ) {
      return null;
    }
    const payload = immutableRequirementRowPayload({
      orderIndex: index,
      ref: row.ref,
      requirementText: row.requirement_text_normalized,
      sourceLocator: row.source_locator,
      sourceDocumentId: row.source_document_id,
    });
    if (
      payload.ref !== row.ref ||
      payload.requirement_text_normalized !==
        row.requirement_text_normalized ||
      payload.source_locator !== row.source_locator ||
      payload.source_document_id !== row.source_document_id ||
      sha256(JSON.stringify(payload)) !== row.row_sha256
    ) {
      return null;
    }
    rows.push({
      ...payload,
      row_sha256: row.row_sha256,
    });
  }

  if (sha256(JSON.stringify(rows)) !== manifest.manifest_sha256) {
    return null;
  }
  return {
    version: 1,
    rows,
    manifest_sha256: manifest.manifest_sha256,
  };
}

function renderedImmutableRequirementRows(contentMarkdown: string) {
  return parseMarkdownTables(contentMarkdown)
    .filter(isRequirementTable)
    .flatMap((table) => {
      const refIndex = getColumnIndex(table, /kravref/i);
      const requirementIndex = getColumnIndex(table, /^krav$/i);
      const sourceIndex = getColumnIndex(
        table,
        /^(?:kildegrunnlag|kilde|source|source reference)$/i,
      );
      return table.rows.map((row, orderIndex) =>
        immutableRequirementRowPayload({
          orderIndex,
          ref: row[refIndex] ?? "",
          requirementText: row[requirementIndex] ?? "",
          sourceLocator: row[sourceIndex] ?? "",
        }),
      );
    })
    .map((row, orderIndex) => ({ ...row, order_index: orderIndex }));
}

function renderedRequirementAnswerRows(contentMarkdown: string) {
  return parseMarkdownTables(contentMarkdown)
    .filter(isRequirementTable)
    .flatMap((table) => {
      const refIndex = getColumnIndex(table, /kravref/i);
      const answerIndex = getColumnIndex(table, /^svar$/i);
      const evidenceIndex = getColumnIndex(
        table,
        /^(?:svargrunnlag|answer evidence|evidence|bevis)$/i,
      );
      return table.rows.map((row) => ({
        ref: normalize(row[refIndex] ?? ""),
        answer: normalize(row[answerIndex] ?? ""),
        evidence: normalize(row[evidenceIndex] ?? ""),
      }));
    })
    .map((row, orderIndex) => ({ ...row, order_index: orderIndex }));
}

function reviewRows(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const row = inputSnapshotRecord(item);
    return Number.isSafeInteger(row.order_index) &&
      (row.order_index as number) >= 0 &&
      typeof row.ref === "string" &&
      row.ref.trim()
      ? [
          {
            ...row,
            order_index: row.order_index as number,
            ref: row.ref.trim(),
          },
        ]
      : [];
  });
}

function reviewMetadataCount(
  requirementResponse: Record<string, unknown>,
  fieldPrefix: string,
) {
  const configuredCount = requirementResponse[`${fieldPrefix}_answers`];
  const rows = requirementResponse[`${fieldPrefix}_rows`];
  const refs = requirementResponse[`${fieldPrefix}_refs`];
  return Math.max(
    Number.isSafeInteger(configuredCount) && (configuredCount as number) >= 0
      ? (configuredCount as number)
      : 0,
    Array.isArray(rows) ? rows.length : 0,
    Array.isArray(refs) ? refs.length : 0,
  );
}

function reviewRowMatchesImmutableProvenance(
  row: Record<string, unknown> & { order_index: number; ref: string },
  immutableRowManifest: ImmutableRequirementRowManifest,
) {
  const immutableRow = immutableRowManifest.rows[row.order_index];
  if (
    !immutableRow ||
    normalizeImmutableRowValue(row.ref) !== immutableRow.ref ||
    typeof row.source_locator !== "string" ||
    normalizeImmutableRowValue(row.source_locator) !==
      immutableRow.source_locator ||
    !Object.prototype.hasOwnProperty.call(row, "source_document_id")
  ) {
    return false;
  }
  const sourceDocumentId =
    row.source_document_id === null
      ? null
      : typeof row.source_document_id === "string" &&
          row.source_document_id.trim()
        ? normalizeImmutableRowValue(row.source_document_id)
        : undefined;
  return sourceDocumentId === immutableRow.source_document_id;
}

export function buildValidatedManualArtifactInputSnapshot(input: {
  artifactType: GeneratedArtifactType;
  title: string;
  contentMarkdown: string;
  parentContentMarkdown?: string;
  parentInputSnapshot: unknown;
  parentArtifactId: string;
  editedAt: string;
  acknowledgeDeterministicRepairs?: boolean;
}) {
  const parentInputSnapshot = inputSnapshotRecord(input.parentInputSnapshot);
  if (input.artifactType !== "forbedret_kravsvar") {
    return {
      ...parentInputSnapshot,
      edited_manually: true,
      edited_at: input.editedAt,
      parent_artifact_id: input.parentArtifactId,
    };
  }

  const generationMetadata = inputSnapshotRecord(
    parentInputSnapshot.generation_metadata,
  );
  const requirementResponse = inputSnapshotRecord(
    generationMetadata.requirement_response,
  );
  const rawExpectedRequirementCount = requirementResponse.total_requirements;
  const rawExpectedRequirementRefs = requirementResponse.requirement_refs;
  const immutableRowManifest = readImmutableRequirementRowManifest(
    requirementResponse.immutable_row_manifest,
  );
  const expectations = requirementQualityExpectations(generationMetadata);
  const expectedRequirementCount = expectations.expectedRequirementCount;
  const expectedRequirementRefs = expectations.expectedRequirementRefs;
  if (
    !Number.isSafeInteger(rawExpectedRequirementCount) ||
    (rawExpectedRequirementCount as number) <= 0 ||
    !Array.isArray(rawExpectedRequirementRefs) ||
    rawExpectedRequirementRefs.length !== rawExpectedRequirementCount ||
    !rawExpectedRequirementRefs.every(
      (reference) => typeof reference === "string" && reference.trim(),
    ) ||
    expectedRequirementCount !== rawExpectedRequirementCount ||
    !Array.isArray(expectedRequirementRefs) ||
    expectedRequirementRefs.length !== expectedRequirementCount ||
    !immutableRowManifest ||
    immutableRowManifest.rows.length !== expectedRequirementCount ||
    immutableRowManifest.rows.some(
      (row, index) =>
        !requirementRefMatchesExpected(
          row.ref,
          expectedRequirementRefs[index] ?? "",
        ),
    ) ||
    requirementResponse.coverage_enforced !== true ||
    requirementResponse.source_evidence_enforced !== true
  ) {
    throw new Error(
      "Kravbesvarelsen mangler et komplett, uforanderlig kravgrunnlag for manuell redigering. Regenerer kravbesvarelsen før du redigerer den.",
    );
  }

  const renderedRows = renderedImmutableRequirementRows(input.contentMarkdown);
  const immutableRowsMatch =
    renderedRows.length === immutableRowManifest.rows.length &&
    renderedRows.every((row, index) => {
      const expected = immutableRowManifest.rows[index];
      return (
        expected?.order_index === index &&
        row.order_index === index &&
        row.ref === expected.ref &&
        row.requirement_text_normalized ===
          expected.requirement_text_normalized &&
        row.source_locator === expected.source_locator
      );
    });
  if (!immutableRowsMatch) {
    throw new Error(
      "Endringene kan ikke lagres som autoritativ kravbesvarelse fordi kravradens identitet, rekkefølge, kravtekst eller kildegrunnlag er endret. Bare svar og svargrunnlag kan redigeres manuelt.",
    );
  }

  const qualityReport = validateGeneratedArtifact({
    artifactType: input.artifactType,
    title: input.title,
    contentMarkdown: input.contentMarkdown,
    expectedRequirementCount,
    expectedRequirementRefs,
  });
  if (qualityReport.status === "fail") {
    throw new Error(
      `Endringene kan ikke lagres fordi kravbesvarelsen ikke lenger består kvalitetskontrollen: ${qualityReport.issues.join(" ")}`,
    );
  }

  const updatedRequirementResponse = { ...requirementResponse };
  const remediatedRows: Array<{
    kind: "template" | "control";
    order_index: number;
    ref: string;
  }> = [];
  if (
    input.acknowledgeDeterministicRepairs === true &&
    typeof input.parentContentMarkdown === "string"
  ) {
    const parentRows = renderedRequirementAnswerRows(
      input.parentContentMarkdown,
    );
    const editedRows = renderedRequirementAnswerRows(input.contentMarkdown);
    for (const [kind, fieldPrefix] of [
      ["template", "deterministic_template_repair"],
      ["control", "deterministic_control_repair"],
    ] as const) {
      const rowsField = `${fieldPrefix}_rows`;
      const refsField = `${fieldPrefix}_refs`;
      const countField = `${fieldPrefix}_answers`;
      const rows = reviewRows(updatedRequirementResponse[rowsField]);
      if (!rows.length) continue;
      const configuredCount = updatedRequirementResponse[countField];
      const configuredRefs = Array.isArray(
        updatedRequirementResponse[refsField],
      )
        ? (updatedRequirementResponse[refsField] as unknown[])
            .filter((ref): ref is string => typeof ref === "string")
            .map((ref) => ref.trim())
            .filter(Boolean)
        : [];
      const reviewMetadataIsComplete =
        Number.isSafeInteger(configuredCount) &&
        configuredCount === rows.length &&
        configuredRefs.length === rows.length &&
        rows.every(
          (row, index) =>
            normalizeImmutableRowValue(configuredRefs[index]) ===
              normalizeImmutableRowValue(row.ref) &&
            reviewRowMatchesImmutableProvenance(row, immutableRowManifest),
        );
      if (!reviewMetadataIsComplete) continue;
      const remainingRows = rows.filter((row) => {
        const parent = parentRows[row.order_index];
        const edited = editedRows[row.order_index];
        const changed =
          parent &&
          edited &&
          parent.ref === edited.ref &&
          normalizeImmutableRowValue(parent.ref) ===
            normalizeImmutableRowValue(row.ref) &&
          edited.answer.length >= 16 &&
          edited.answer !== parent.answer;
        if (changed) {
          remediatedRows.push({
            kind,
            order_index: row.order_index,
            ref: row.ref,
          });
        }
        return !changed;
      });
      updatedRequirementResponse[rowsField] = remainingRows;
      updatedRequirementResponse[refsField] = remainingRows.map(
        (row) => row.ref,
      );
      updatedRequirementResponse[countField] = remainingRows.length;
    }
  }
  const templateRepairCount = reviewMetadataCount(
    updatedRequirementResponse,
    "deterministic_template_repair",
  );
  const controlRepairCount = reviewMetadataCount(
    updatedRequirementResponse,
    "deterministic_control_repair",
  );
  const proposalInputCount = Math.max(
    Number.isSafeInteger(
      updatedRequirementResponse.proposal_input_required_count,
    ) &&
      (updatedRequirementResponse.proposal_input_required_count as number) >= 0
      ? (updatedRequirementResponse.proposal_input_required_count as number)
      : 0,
    Array.isArray(updatedRequirementResponse.proposal_input_required_rows)
      ? updatedRequirementResponse.proposal_input_required_rows.length
      : 0,
    Array.isArray(updatedRequirementResponse.proposal_input_required_refs)
      ? updatedRequirementResponse.proposal_input_required_refs.length
      : 0,
  );
  const knownReviewCount =
    Math.max(0, templateRepairCount) +
    Math.max(0, controlRepairCount) +
    Math.max(0, proposalInputCount);
  const originalKnownReviewCount =
    reviewMetadataCount(
      requirementResponse,
      "deterministic_template_repair",
    ) +
    reviewMetadataCount(
      requirementResponse,
      "deterministic_control_repair",
    ) +
    Math.max(
      Number.isSafeInteger(requirementResponse.proposal_input_required_count) &&
        (requirementResponse.proposal_input_required_count as number) >= 0
        ? (requirementResponse.proposal_input_required_count as number)
        : 0,
      Array.isArray(requirementResponse.proposal_input_required_rows)
        ? requirementResponse.proposal_input_required_rows.length
        : 0,
      Array.isArray(requirementResponse.proposal_input_required_refs)
        ? requirementResponse.proposal_input_required_refs.length
        : 0,
    );
  const manualReviewRequired =
    knownReviewCount > 0 ||
    (originalKnownReviewCount === 0 &&
      requirementResponse.manual_review_required === true);
  updatedRequirementResponse.manual_review_required = manualReviewRequired;
  if (!manualReviewRequired) {
    delete updatedRequirementResponse.manual_review_note;
  }

  return {
    ...parentInputSnapshot,
    generation_metadata: {
      ...generationMetadata,
      requirement_response: updatedRequirementResponse,
    },
    edited_manually: true,
    edited_at: input.editedAt,
    parent_artifact_id: input.parentArtifactId,
    artifact_quality_report: qualityReport,
    manual_edit_validation: {
      status: qualityReport.status,
      validated_at: input.editedAt,
      expected_requirement_count: expectedRequirementCount,
      expected_requirement_refs: expectedRequirementRefs,
      immutable_row_manifest_sha256:
        immutableRowManifest.manifest_sha256,
      deterministic_repairs_acknowledged:
        input.acknowledgeDeterministicRepairs === true,
      remediated_repair_rows: remediatedRows,
    },
  };
}

export function validateGeneratedArtifact(input: {
  artifactType: GeneratedArtifactType;
  title: string;
  contentMarkdown: string;
  expectedRequirementCount?: number;
  expectedRequirementRefs?: string[];
  unresolvedFallbackAnswers?: number;
}): ArtifactQualityReport {
  const tables = parseMarkdownTables(input.contentMarkdown);
  const requirementTables = tables.filter(isRequirementTable);
  let requirementRows = 0;
  let tocRows = 0;
  let dotLeaderRows = 0;
  let emptyAnswers = 0;
  let missingAnswerEvidence = 0;
  let missingSources = 0;
  const requirementTexts = new Map<string, number>();
  const requirementRefValues: string[] = [];

  for (const table of requirementTables) {
    const requirementIndex = getColumnIndex(table, /^krav$/i);
    const refIndex = getColumnIndex(table, /kravref/i);
    const answerIndex = getColumnIndex(table, /^svar$/i);
    const evidenceIndex = getColumnIndex(
      table,
      /^(?:svargrunnlag|answer evidence|evidence|bevis)$/i,
    );
    const sourceIndex = getColumnIndex(
      table,
      /^(?:kildegrunnlag|kilde|source|source reference)$/i,
    );

    for (const row of table.rows) {
      requirementRows += 1;
      const requirement = normalize(row[requirementIndex] ?? "");
      const answer = normalize(row[answerIndex] ?? "");
      const evidence = normalize(row[evidenceIndex] ?? "");
      const source = normalize(row[sourceIndex] ?? "");
      requirementRefValues.push(row[refIndex] ?? "");

      if (/^table of contents$/i.test(requirement) || /^innholdsfortegnelse$/i.test(requirement)) {
        tocRows += 1;
      }
      if (DOT_LEADER_PATTERN.test(requirement)) {
        dotLeaderRows += 1;
      }
      if (!answer || /^[-–—]$/.test(answer)) {
        emptyAnswers += 1;
      }
      if (!evidence || /^[-–—]$/.test(evidence)) {
        missingAnswerEvidence += 1;
      }
      if (!source || /^[-–—]$/.test(source)) {
        missingSources += 1;
      }

      const duplicateKey = requirement.toLowerCase();
      if (duplicateKey.length >= 20) {
        requirementTexts.set(duplicateKey, (requirementTexts.get(duplicateKey) ?? 0) + 1);
      }
    }
  }

  const duplicateRequirementTexts = Array.from(requirementTexts.values()).reduce(
    (sum, count) => sum + Math.max(0, count - 1),
    0,
  );
  const emptySections = detectEmptySections(input.contentMarkdown);
  const expectedRequirementRefs = (input.expectedRequirementRefs ?? [])
    .map(normalizeRequirementRef)
    .filter(Boolean);
  const missingExpectedRequirements = expectedRequirementRefs.filter((ref) => {
    return !requirementRefValues.some((rowRef) =>
      requirementRefMatchesExpected(rowRef, ref),
    );
  }).length;
  const coveredExpectedRequirements =
    expectedRequirementRefs.length - missingExpectedRequirements;
  const expectedRequirementRows = Math.max(
    0,
    Math.round(input.expectedRequirementCount ?? 0),
  );
  const unresolvedFallbackAnswers = Math.max(
    0,
    Math.round(input.unresolvedFallbackAnswers ?? 0),
  );
  const extraRequirementRows =
    expectedRequirementRows > 0
      ? Math.max(0, requirementRows - expectedRequirementRows)
      : 0;
  const outOfOrderExpectedRequirements = expectedRequirementRefs.filter(
    (ref, index) =>
      !requirementRefMatchesExpected(requirementRefValues[index] ?? "", ref),
  ).length;
  const issues: string[] = [];
  const checks: ArtifactQualityCheck[] = [];
  let highIssues = 0;
  let warnings = 0;

  function addCheck(check: ArtifactQualityCheck, issue?: string) {
    checks.push(check);
    if (check.status === "fail") highIssues += 1;
    if (check.status === "warning") warnings += 1;
    if (issue) issues.push(issue);
  }

  addCheck(
    {
      label: "Innhold",
      value: input.contentMarkdown.trim().length,
      status: input.contentMarkdown.trim().length >= 300 ? "pass" : "fail",
      severity: "high",
    },
    input.contentMarkdown.trim().length >= 300
      ? undefined
      : "Artefakten er for kort til å være et komplett generatorresultat.",
  );

  if (input.artifactType === "forbedret_kravsvar") {
    addCheck(
      {
        label: "Kravrader",
        value: requirementRows,
        status: requirementRows > 0 ? "pass" : "fail",
        severity: "high",
      },
      requirementRows > 0 ? undefined : "Kravbesvarelsen mangler kravtabell.",
    );
    if (expectedRequirementRows > 0) {
      addCheck(
        {
          label: "Eksakt kravraddekning",
          value: `${requirementRows}/${expectedRequirementRows}`,
          status: requirementRows === expectedRequirementRows ? "pass" : "fail",
          severity: "high",
        },
        requirementRows === expectedRequirementRows
          ? undefined
          : `Kravbesvarelsen har ${requirementRows} kravrader, men kravledgeren forventer nøyaktig ${expectedRequirementRows}.`,
      );
      addCheck(
        {
          label: "Forventet kravdekning",
          value: expectedRequirementRefs.length
            ? `${coveredExpectedRequirements}/${expectedRequirementRows}`
            : `${requirementRows}/${expectedRequirementRows}`,
          status:
            (expectedRequirementRefs.length
              ? coveredExpectedRequirements
              : requirementRows) >= expectedRequirementRows
              ? "pass"
              : "fail",
          severity: "high",
        },
        (expectedRequirementRefs.length
          ? coveredExpectedRequirements
          : requirementRows) >= expectedRequirementRows
          ? undefined
          : `Kravbesvarelsen dekker ${
              expectedRequirementRefs.length
                ? coveredExpectedRequirements
                : requirementRows
            } krav, men kravledgeren forventer minst ${expectedRequirementRows}.`,
      );
    }
    if (expectedRequirementRefs.length > 0) {
      addCheck(
        {
          label: "Kjente kravreferanser",
          value: `${expectedRequirementRefs.length - missingExpectedRequirements}/${expectedRequirementRefs.length}`,
          status: missingExpectedRequirements === 0 ? "pass" : "fail",
          severity: "high",
        },
        missingExpectedRequirements === 0
          ? undefined
          : `${missingExpectedRequirements} kravreferanser fra kravledgeren mangler i kravbesvarelsen.`,
      );
      addCheck(
        {
          label: "Kravrekkefølge",
          value: `${expectedRequirementRefs.length - outOfOrderExpectedRequirements}/${expectedRequirementRefs.length}`,
          status: outOfOrderExpectedRequirements === 0 ? "pass" : "fail",
          severity: "high",
        },
        outOfOrderExpectedRequirements === 0
          ? undefined
          : `${outOfOrderExpectedRequirements} kravrader står ikke i samme rekkefølge som kravledgeren.`,
      );
    }
    addCheck(
      {
        label: "Svar til manuell kontroll",
        value: unresolvedFallbackAnswers,
        status: unresolvedFallbackAnswers === 0 ? "pass" : "fail",
        severity: "high",
      },
      unresolvedFallbackAnswers === 0
        ? undefined
        : `${unresolvedFallbackAnswers} kravsvar er fortsatt deterministisk fallback etter reparasjon og kan ikke lagres som ferdig.`,
    );
    addCheck(
      {
        label: "TOC-rader",
        value: tocRows,
        status: tocRows === 0 ? "pass" : "fail",
        severity: "high",
      },
      tocRows === 0 ? undefined : "Kravtabellen inneholder innholdsfortegnelse som krav.",
    );
    addCheck(
      {
        label: "Dot-leader-rader",
        value: dotLeaderRows,
        status: dotLeaderRows === 0 ? "pass" : "fail",
        severity: "high",
      },
      dotLeaderRows === 0
        ? undefined
        : "Kravtabellen inneholder punktlinjer fra innholdsfortegnelse.",
    );
    addCheck(
      {
        label: "Tomme svar",
        value: emptyAnswers,
        status: emptyAnswers === 0 ? "pass" : "fail",
        severity: "high",
      },
      emptyAnswers === 0 ? undefined : "Minst én kravrad mangler svar.",
    );
    addCheck(
      {
        label: "Svargrunnlag",
        value: missingAnswerEvidence,
        status: missingAnswerEvidence === 0 ? "pass" : "fail",
        severity: "high",
      },
      missingAnswerEvidence === 0
        ? undefined
        : "Minst én kravrad mangler svargrunnlag.",
    );
    addCheck(
      {
        label: "Kildegrunnlag",
        value: missingSources,
        status: missingSources === 0 ? "pass" : "fail",
        severity: "high",
      },
      missingSources === 0 ? undefined : "Minst én kravrad mangler kildegrunnlag.",
    );
    addCheck({
      label: "Duplikate kravtekster",
      value: duplicateRequirementTexts,
      status: duplicateRequirementTexts === 0 ? "pass" : "warning",
      severity: "warning",
    });
  }

  addCheck({
    label: "Tomme seksjoner",
    value: emptySections,
    status: emptySections === 0 ? "pass" : "warning",
    severity: "warning",
  });

  return {
    status: statusFromHighIssues(highIssues, warnings),
    metrics: {
      requirementRows,
      expectedRequirementRows,
      missingExpectedRequirements,
      extraRequirementRows,
      outOfOrderExpectedRequirements,
      unresolvedFallbackAnswers,
      tocRows,
      dotLeaderRows,
      emptyAnswers,
      missingAnswerEvidence,
      missingSources,
      duplicateRequirementTexts,
      emptySections,
    },
    checks,
    issues,
  };
}

function isRepairableRequirementRow(row: string[]) {
  const joined = row.join(" ");
  return (
    /^table of contents$/i.test(normalize(joined)) ||
    /^innholdsfortegnelse$/i.test(normalize(joined)) ||
    DOT_LEADER_PATTERN.test(joined)
  );
}

export function repairGeneratedArtifactContent(input: {
  artifactType: GeneratedArtifactType;
  contentMarkdown: string;
}) {
  if (input.artifactType !== "forbedret_kravsvar") {
    return { contentMarkdown: input.contentMarkdown, repairedRows: 0 };
  }

  const lines = input.contentMarkdown.replace(/\r\n/g, "\n").split("\n");
  let repairedRows = 0;
  const output: string[] = [];
  let tableBuffer: string[] = [];

  function flushTable() {
    if (!tableBuffer.length) return;
    const header = splitMarkdownTableRow(
      tableBuffer.find((line) => !isMarkdownSeparatorRow(line)) ?? "",
    );
    const isReqTable =
      header.some((cell) => cell.toLowerCase().includes("kravref")) &&
      header.some((cell) => cell.toLowerCase() === "krav");

    if (!isReqTable) {
      output.push(...tableBuffer);
      tableBuffer = [];
      return;
    }

    const cleaned = tableBuffer.filter((line, index) => {
      if (index < 2 || isMarkdownSeparatorRow(line)) return true;
      const row = splitMarkdownTableRow(line);
      if (!isRepairableRequirementRow(row)) return true;
      repairedRows += 1;
      return false;
    });
    output.push(...cleaned);
    tableBuffer = [];
  }

  for (const line of lines) {
    if (line.trim().startsWith("|")) {
      tableBuffer.push(line);
    } else {
      flushTable();
      output.push(line);
    }
  }
  flushTable();

  return {
    contentMarkdown: repairedRows > 0 ? output.join("\n") : input.contentMarkdown,
    repairedRows,
  };
}
