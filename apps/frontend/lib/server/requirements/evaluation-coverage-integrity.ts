import type { RequirementLedgerEntry } from "@/lib/server/requirements/types";

export type RequirementCoverageIntegrityItem = {
  order_index?: number | null;
  reference?: string | null;
  full_reference?: string | null;
  source_reference?: string | null;
  source_document_id?: string | null;
  table_id?: string | null;
  requirement_subtitle?: string | null;
  requirement?: string | null;
  assessment?: string | null;
  rationale?: string | null;
  evidence?: string | null;
  recommendation?: string | null;
  answer_document_id?: string | null;
  answer_document_title?: string | null;
};

export type RequirementCoverageIntegrityCoverage = {
  total_requirements?: number | null;
  assessed_requirements?: number | null;
  good?: number | null;
  weak?: number | null;
  missing?: number | null;
  unclear?: number | null;
  items?: RequirementCoverageIntegrityItem[] | null;
};

export type RequirementCoverageIntegrityIssue = {
  code: string;
  message: string;
  index?: number;
  reference?: string;
};

export type RequirementCoverageIntegrityReport = {
  ok: boolean;
  sourceCount: number;
  itemCount: number;
  issueCount: number;
  issues: RequirementCoverageIntegrityIssue[];
};

function compactForMessage(value: unknown, limit = 140) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length <= limit ? text : `${text.slice(0, limit)}...`;
}

function normalizeComparableText(value: unknown) {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[‐‑‒–—]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/[“”"]/g, "")
    .trim();
}

function normalizeReferenceKey(value: unknown) {
  return normalizeComparableText(value).replace(/[^a-z0-9æøå]+/gi, "");
}

function itemReferenceValues(item: RequirementCoverageIntegrityItem) {
  return [
    item.reference,
    item.full_reference,
    item.source_reference,
    item.table_id,
    item.requirement_subtitle,
  ]
    .map((value) => String(value ?? "").trim())
    .filter(Boolean);
}

function sourceReferenceCandidates(entry: RequirementLedgerEntry) {
  return [
    entry.id,
    entry.tableId,
    entry.service,
    [entry.tableId, entry.service].filter(Boolean).join(" "),
  ]
    .map(normalizeReferenceKey)
    .filter((value) => value.length >= 2);
}

function itemReferencesSource(
  item: RequirementCoverageIntegrityItem,
  entry: RequirementLedgerEntry,
) {
  const referenceValues = itemReferenceValues(item).map(normalizeReferenceKey);
  const sourceCandidates = sourceReferenceCandidates(entry);
  if (!sourceCandidates.length) {
    return true;
  }

  return referenceValues.some((reference) =>
    sourceCandidates.some(
      (candidate) =>
        reference === candidate ||
        reference.includes(candidate) ||
        (candidate.length >= 6 && candidate.includes(reference)),
    ),
  );
}

function itemRequirementMatchesSource(
  item: RequirementCoverageIntegrityItem,
  entry: RequirementLedgerEntry,
) {
  const actual = normalizeComparableText(item.requirement).replace(
    /\s*(?:\u2026|\.{3})$/u,
    "",
  );
  const expected = normalizeComparableText(entry.text);
  if (!actual || !expected) {
    return false;
  }

  return (
    actual === expected ||
    expected.startsWith(actual) ||
    actual.startsWith(expected)
  );
}

function hasMatchedAnswer(item: RequirementCoverageIntegrityItem) {
  return Boolean(item.answer_document_id || item.answer_document_title);
}

function evidenceMatchesAnswerSource(
  item: RequirementCoverageIntegrityItem,
  entry: RequirementLedgerEntry,
) {
  const evidence = normalizeComparableText(item.evidence);
  if (evidence.length < 16) {
    return false;
  }

  return [entry.answerExcerpt, entry.answerEvidenceExcerpt]
    .map(normalizeComparableText)
    .filter((value) => value.length >= 16)
    .some(
      (answerSource) =>
        answerSource.includes(evidence) ||
        evidence.includes(
          answerSource.slice(0, Math.min(answerSource.length, 160)),
        ),
    );
}

function addIssue(
  issues: RequirementCoverageIntegrityIssue[],
  issue: RequirementCoverageIntegrityIssue,
) {
  issues.push({
    ...issue,
    reference: issue.reference ? compactForMessage(issue.reference, 90) : undefined,
  });
}

export function analyzeRequirementCoverageIntegrity(input: {
  sourceLedger: RequirementLedgerEntry[];
  coverage: RequirementCoverageIntegrityCoverage | null | undefined;
}): RequirementCoverageIntegrityReport {
  const issues: RequirementCoverageIntegrityIssue[] = [];
  const sourceCount = input.sourceLedger.length;
  const items = Array.isArray(input.coverage?.items) ? input.coverage.items : [];

  if (!input.coverage) {
    addIssue(issues, {
      code: "missing_coverage",
      message: "Vurderingen mangler requirement_coverage.",
    });
  }

  if ((input.coverage?.total_requirements ?? 0) !== sourceCount) {
    addIssue(issues, {
      code: "total_mismatch",
      message: `total_requirements=${input.coverage?.total_requirements ?? "mangler"}, forventet ${sourceCount}.`,
    });
  }

  if ((input.coverage?.assessed_requirements ?? 0) !== sourceCount) {
    addIssue(issues, {
      code: "assessed_mismatch",
      message: `assessed_requirements=${input.coverage?.assessed_requirements ?? "mangler"}, forventet ${sourceCount}.`,
    });
  }

  if (items.length !== sourceCount) {
    addIssue(issues, {
      code: "item_count_mismatch",
      message: `items=${items.length}, forventet ${sourceCount}.`,
    });
  }

  const countSum =
    (input.coverage?.good ?? 0) +
    (input.coverage?.weak ?? 0) +
    (input.coverage?.missing ?? 0) +
    (input.coverage?.unclear ?? 0);
  if (items.length > 0 && countSum !== items.length) {
    addIssue(issues, {
      code: "assessment_count_mismatch",
      message: `Godt/Dårlig/Mangler/Uklart summerer til ${countSum}, men items=${items.length}.`,
    });
  }

  const seenOrderIndexes = new Set<number>();
  const seenIdentityKeys = new Set<string>();
  const validAssessments = new Set(["Godt", "Dårlig", "Mangler", "Uklart"]);

  items.forEach((item, index) => {
    const reference = String(item.reference ?? "").trim();
    const sourceEntry = input.sourceLedger[index];
    const orderIndex =
      typeof item.order_index === "number" && Number.isFinite(item.order_index)
        ? Math.round(item.order_index)
        : null;

    if (orderIndex !== index) {
      addIssue(issues, {
        code: "order_index_mismatch",
        index,
        reference,
        message: `Rad ${index + 1} har order_index=${item.order_index ?? "mangler"}, forventet ${index}.`,
      });
    }

    if (orderIndex !== null) {
      if (seenOrderIndexes.has(orderIndex)) {
        addIssue(issues, {
          code: "duplicate_order_index",
          index,
          reference,
          message: `order_index=${orderIndex} forekommer flere ganger.`,
        });
      }
      seenOrderIndexes.add(orderIndex);
    }

    const sourceDocumentScope =
      normalizeReferenceKey(item.source_document_id) ||
      normalizeReferenceKey(sourceEntry?.documentId);
    const referenceIdentity = [
      normalizeReferenceKey(item.reference),
      normalizeReferenceKey(item.full_reference),
      normalizeReferenceKey(item.source_reference),
    ];
    const identityKey = [sourceDocumentScope, ...referenceIdentity].join("|");
    if (referenceIdentity.some(Boolean)) {
      if (seenIdentityKeys.has(identityKey)) {
        addIssue(issues, {
          code: "duplicate_reference_identity",
          index,
          reference,
          message: "Samme reference/full_reference/source_reference forekommer flere ganger.",
        });
      }
      seenIdentityKeys.add(identityKey);
    }

    if (!reference) {
      addIssue(issues, {
        code: "missing_reference",
        index,
        message: `Rad ${index + 1} mangler reference.`,
      });
    }

    if (!validAssessments.has(String(item.assessment ?? ""))) {
      addIssue(issues, {
        code: "invalid_assessment",
        index,
        reference,
        message: `Rad ${index + 1} har ugyldig assessment=${item.assessment ?? "mangler"}.`,
      });
    }

    for (const field of ["rationale", "evidence", "recommendation"] as const) {
      if (!String(item[field] ?? "").trim()) {
        addIssue(issues, {
          code: `missing_${field}`,
          index,
          reference,
          message: `Rad ${index + 1} mangler ${field}.`,
        });
      }
    }

    if (item.assessment === "Mangler" && hasMatchedAnswer(item)) {
      addIssue(issues, {
        code: "missing_with_matched_answer",
        index,
        reference,
        message:
          "Rad er vurdert som Mangler selv om den er koblet til et svardokument.",
      });
    }

    if (!sourceEntry) {
      addIssue(issues, {
        code: "invented_item",
        index,
        reference,
        message: `Rad ${index + 1} finnes ikke i kildeledgeren.`,
      });
      return;
    }

    if (!itemReferencesSource(item, sourceEntry)) {
      addIssue(issues, {
        code: "invented_reference",
        index,
        reference,
        message: `Rad ${index + 1} matcher ikke kildekrav ${compactForMessage(sourceEntry.id, 90)}.`,
      });
    }

    if (!itemRequirementMatchesSource(item, sourceEntry)) {
      addIssue(issues, {
        code: "requirement_text_mismatch",
        index,
        reference,
        message: `Rad ${index + 1} har kravtekst som ikke matcher kildeledgeren.`,
      });
    }

    if (
      item.assessment === "Godt" &&
      (!hasMatchedAnswer(item) ||
        !evidenceMatchesAnswerSource(item, sourceEntry))
    ) {
      addIssue(issues, {
        code: "good_evidence_not_answer_bound",
        index,
        reference,
        message:
          `Rad ${index + 1} er vurdert som Godt, men evidence er ikke bundet til den matchede svarteksten eller Svargrunnlag.`,
      });
    }
  });

  return {
    ok: issues.length === 0,
    sourceCount,
    itemCount: items.length,
    issueCount: issues.length,
    issues,
  };
}

export function assertRequirementCoverageIntegrity(input: {
  sourceLedger: RequirementLedgerEntry[];
  coverage: RequirementCoverageIntegrityCoverage | null | undefined;
}) {
  const report = analyzeRequirementCoverageIntegrity(input);
  if (!report.ok) {
    throw new Error(
      `Kravdekning feilet integritetssjekk: ${report.issues
        .slice(0, 6)
        .map((issue) => `${issue.code}: ${issue.message}`)
        .join(" | ")}`,
    );
  }
  return report;
}
