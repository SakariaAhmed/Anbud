import "server-only";

import { normalizePdfReferenceTypography } from "@/lib/server/requirements/pdf-normalization";
import { cleanTableRequirement } from "@/lib/server/requirements/pdf-table-repairs";
import type { RequirementLedgerEntry } from "@/lib/server/requirements/types";

type RequirementLedgerQualitySeverity = "error" | "warning";

type RequirementLedgerQualityIssue = {
  severity: RequirementLedgerQualitySeverity;
  code: string;
  index: number;
  id: string;
  field: string;
  value: string;
};

const MALFORMED_REFERENCE_PATTERNS: Array<{ code: string; pattern: RegExp }> = [
  {
    code: "truncated_table_service",
    pattern:
      /\bTabell\s+ID\s+\d{1,3}-\d{1,3}\s+-\s+(?:Der|Sikker|Konfigurasjons|Dokumentasjo)\s*(?:$|[,|])/i,
  },
  {
    code: "duplicated_change_suffix",
    pattern: /\bendringshåndtering ering\b/i,
  },
  {
    code: "misclassified_report_sentence",
    pattern: /\bRapportene vil gi\b/i,
  },
  {
    code: "misclassified_named_continuation",
    pattern:
      /\b\p{Lu}[\p{L}\p{M}0-9&().-]+(?:\s+\p{Lu}[\p{L}\p{M}0-9&().-]+)*\s+løpende\b/u,
  },
  {
    code: "split_third_party_supplier",
    pattern: /\bTredjepart\s+s\s*-\s*leverandør(?:er|\s+er)\b/i,
  },
  {
    code: "wrong_third_party_supplier_title",
    pattern: /\bTredjepartsprogramvare og -løsninger\b/i,
  },
  {
    code: "malformed_compact_id",
    pattern: /\bID\d{1,3}\s*[-.]\s*\d{1,3}\b/i,
  },
  {
    code: "misclassified_requirement_heading",
    pattern: /\bDokumentasjonen vil omfatte følgende hovedområder\b/i,
  },
];

const MALFORMED_REQUIREMENT_PATTERNS: Array<{ code: string; pattern: RegExp }> = [
  {
    code: "truncated_control_requirement",
    pattern: /^Redegjør for kontrollmekanismer ved$/i,
  },
  {
    code: "truncated_describe_requirement",
    pattern: /^Leverandøren skal beskrive$/i,
  },
  {
    code: "truncated_authentication_requirement",
    pattern: /^Leverandøren bes beskrive løsning for$/i,
  },
  {
    code: "mid_sentence_requirement_start",
    pattern: /^resultatet\./i,
  },
  {
    code: "dangling_software_responsibility_phrase",
    pattern: /\bLeveransen og som$/i,
  },
];

function compactIssueValue(value: string) {
  return value.replace(/\s+/g, " ").trim().slice(0, 220);
}

function issueForPattern(input: {
  entry: RequirementLedgerEntry;
  index: number;
  field: string;
  value: string;
  code: string;
}): RequirementLedgerQualityIssue {
  return {
    severity: "error",
    code: input.code,
    index: input.index,
    id: input.entry.id,
    field: input.field,
    value: compactIssueValue(input.value),
  };
}

function findRequirementLedgerQualityIssues(
  entries: RequirementLedgerEntry[],
): RequirementLedgerQualityIssue[] {
  const issues: RequirementLedgerQualityIssue[] = [];

  entries.forEach((entry, index) => {
    const referenceFields = {
      id: normalizePdfReferenceTypography(entry.id),
      heading: normalizePdfReferenceTypography(entry.heading),
      tableId: normalizePdfReferenceTypography(entry.tableId ?? ""),
      service: normalizePdfReferenceTypography(entry.service ?? ""),
    };

    for (const [field, value] of Object.entries(referenceFields)) {
      if (!value) continue;
      for (const { code, pattern } of MALFORMED_REFERENCE_PATTERNS) {
        if (pattern.test(value)) {
          issues.push(issueForPattern({ entry, index, field, value, code }));
        }
      }
    }

    const requirement = cleanTableRequirement(entry.text);
    for (const { code, pattern } of MALFORMED_REQUIREMENT_PATTERNS) {
      if (pattern.test(requirement)) {
        issues.push(
          issueForPattern({
            entry,
            index,
            field: "text",
            value: requirement,
            code,
          }),
        );
      }
    }
  });

  return issues;
}

export function assertRequirementLedgerQualityForEvaluation(
  entries: RequirementLedgerEntry[],
  options?: { stage?: string; documentTitle?: string },
) {
  const issues = findRequirementLedgerQualityIssues(entries);
  const errors = issues.filter((issue) => issue.severity === "error");

  if (errors.length) {
    const summary = errors
      .slice(0, 6)
      .map(
        (issue) =>
          `${issue.code} @ ${issue.index + 1} ${issue.field} (${issue.id}): ${issue.value}`,
      )
      .join(" | ");
    throw new Error(
      [
        "Kravledgeren inneholder kjente PDF-ekstraksjonsfeil og stoppes før LLM-vurdering.",
        options?.stage ? `Steg: ${options.stage}.` : "",
        options?.documentTitle ? `Dokument: ${options.documentTitle}.` : "",
        summary,
      ]
        .filter(Boolean)
        .join(" "),
    );
  }

  return issues;
}
