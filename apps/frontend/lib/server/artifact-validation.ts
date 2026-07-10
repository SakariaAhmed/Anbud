import "server-only";

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

type MarkdownTable = {
  header: string[];
  rows: string[][];
  rawRows: string[];
};

const DOT_LEADER_PATTERN = /\.{4,}\s*\d{1,4}\s*$/;

function normalize(value: string) {
  return value.replace(/\s+/g, " ").trim();
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
  return Boolean(
    rowComparable &&
      expectedComparable &&
      (rowComparable === expectedComparable ||
        rowComparable.startsWith(`${expectedComparable} `) ||
        rowComparable.includes(` ${expectedComparable} `)),
  );
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
        status: unresolvedFallbackAnswers === 0 ? "pass" : "warning",
        severity: "warning",
      },
      unresolvedFallbackAnswers === 0
        ? undefined
        : `${unresolvedFallbackAnswers} kravsvar bør kontrolleres manuelt etter fallback-reparasjon.`,
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
