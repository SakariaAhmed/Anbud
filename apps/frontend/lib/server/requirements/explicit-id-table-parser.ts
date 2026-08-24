import { normalizePageText } from "@/lib/server/requirements/pdf-normalization";
import type { RequirementCorpusParserContext } from "@/lib/server/requirements/corpus-parser-context";
import type { RequirementLedgerEntry } from "@/lib/server/requirements/types";
import type { ProjectDocumentDetail } from "@/lib/types";

const PIPE_EXPLICIT_ID_TABLE_ROW_PATTERN =
  /^([A-ZÆØÅ]{2,8}\s*-\s*[A-ZÆØÅ]{1,4}\s*-?\s*\d{1,5})\s*\|\s*([ABC])\s*\|\s*(\S.*)$/iu;
const FLATTENED_EXPLICIT_ID_TABLE_ROW_PATTERN =
  /^([A-ZÆØÅ]{2,8}\s*-\s*[A-ZÆØÅ]{1,4}\s*-?\s*\d{1,5})\s*([ABC])\s*(.*)$/iu;
const ANSWER_INSTRUCTION_START_PATTERN =
  /(?:^|\s)(Bekreft|Beskriv|Oppgi|Angi|Redegjør|Dokumenter|Forklar|Skill)\b/iu;

function normalizeExplicitTableId(value: string) {
  return normalizePageText(value)
    .replace(/\s*-\s*/gu, "-")
    .replace(/\s+/gu, "");
}

function explicitIdTableRow(value: string) {
  const text = normalizePageText(value);
  const match =
    PIPE_EXPLICIT_ID_TABLE_ROW_PATTERN.exec(text) ??
    FLATTENED_EXPLICIT_ID_TABLE_ROW_PATTERN.exec(text);
  if (!match?.[1] || !match[2] || !match[3]) {
    if (!match?.[1] || !match[2]) {
      return null;
    }
  }

  const id = normalizeExplicitTableId(match[1]);
  const priority = match[2].toUpperCase();
  const idPriority = /-([ABC])\d{1,5}$/iu.exec(id)?.[1]?.toUpperCase();
  if (idPriority && idPriority !== priority) {
    return null;
  }

  const rawCategory = normalizePageText(match[3] ?? "")
    .replace(/^\|\s*/u, "")
    .trim();
  const instructionStart = rawCategory.search(ANSWER_INSTRUCTION_START_PATTERN);
  return {
    id,
    priority,
    category: normalizePageText(
      instructionStart >= 0
        ? rawCategory.slice(0, instructionStart)
        : rawCategory,
    ),
  };
}

function isAnswerInstructionStart(value: string) {
  return (
    /^Svarinstruks(?:jon)?\s*:/iu.test(value) ||
    ANSWER_INSTRUCTION_START_PATTERN.test(value)
  );
}

function isLikelyDetachedCategory(input: {
  value: string;
  followingText: string;
  context: RequirementCorpusParserContext;
}) {
  const value = normalizePageText(input.value);
  return (
    value.length >= 3 &&
    value.length <= 100 &&
    value.split(/\s+/u).length <= 8 &&
    !/[.!?]$/u.test(value) &&
    !isAnswerInstructionStart(value) &&
    !input.context.hasRequirementSignal(value) &&
    !input.context.hasStandaloneRequirementLanguage(value) &&
    (input.context.hasRequirementSignal(input.followingText) ||
      input.context.hasStandaloneRequirementLanguage(input.followingText))
  );
}

export type ExplicitIdPdfLayoutPage = {
  page: number;
  lines: Array<{
    y: number;
    text: string;
    items: Array<{
      str: string;
      x: number;
      y: number;
      width: number;
    }>;
  }>;
};

type ExplicitIdPdfTableLayout = {
  idX: number;
  typeX: number;
  serviceX: number | null;
  requirementX: number;
  answerX: number | null;
  answerKind: "instruction" | "supplierAnswer" | "none";
};

function explicitIdPdfTableLayout(
  items: ExplicitIdPdfLayoutPage["lines"][number]["items"],
): ExplicitIdPdfTableLayout | null {
  const normalized = items.map((item) => ({
    ...item,
    text: normalizePageText(item.str),
  }));
  const id = normalized.find((item) =>
    /^(?:Krav[\s-]*ID|Requirement[\s-]*ID)$/iu.test(item.text),
  );
  const type = normalized.find((item) =>
    /^(?:Type|Kravtype|Prioritet|Priority|Pri\.?)$/iu.test(item.text),
  );
  const service = normalized.find((item) =>
    /^(?:Tema|Tjeneste|Kategori|Område)$/iu.test(item.text),
  );
  const requirement = normalized.find((item) =>
    /^(?:Kundens\s+krav|Kravtekst|Requirement|Krav\s+som\s+Leverandøren\s+skal\s+besvare)$/iu.test(
      item.text,
    ),
  );
  const instruction = normalized.find((item) =>
    /^(?:Svarinstruks(?:jon)?|Besvarelsesinstruks(?:jon)?|Response\s+instruction)$/iu.test(
      item.text,
    ),
  );
  const supplierAnswer = normalized.find((item) =>
    /^(?:Status\s+og\s+leverandørens\s+besvarelse|Leverandørens\s+(?:bindende\s+)?(?:svar|besvarelse)|Supplier\s+(?:answer|response))$/iu.test(
      item.text,
    ),
  );
  const answer = instruction ?? supplierAnswer;

  if (
    !id ||
    !type ||
    !requirement ||
    !(id.x < type.x) ||
    (service
      ? !(type.x < service.x && service.x < requirement.x)
      : !(type.x < requirement.x)) ||
    (answer && !(requirement.x < answer.x)) ||
    (!answer && !service)
  ) {
    return null;
  }

  return {
    idX: id.x,
    typeX: type.x,
    serviceX: service?.x ?? null,
    requirementX: requirement.x,
    answerX: answer?.x ?? null,
    answerKind: supplierAnswer
      ? "supplierAnswer"
      : instruction
        ? "instruction"
        : "none",
  };
}

function explicitIdFromLayoutItem(value: string) {
  const match =
    /^([A-ZÆØÅ]{2,8}\s*-\s*[A-ZÆØÅ]{1,4}\s*-?\s*\d{1,5})$/iu.exec(
      normalizePageText(value),
    );
  return match?.[1] ? normalizeExplicitTableId(match[1]) : "";
}

function isExplicitIdPdfLayoutChrome(value: string) {
  const text = normalizePageText(value);
  return (
    /^Side\s+\d+(?:\s+av\s+\d+)?$/iu.test(text) ||
    /^Bilag\s+\d+\s*(?:[-–—|])/iu.test(text) ||
    /^(?:Fiktivt\s+testgrunnlag|Konfidensiell)\s*\|\s*Side\s+\d+(?:\s+av\s+\d+)?$/iu.test(
      text,
    )
  );
}

export function buildExplicitIdPdfLayoutRequirementLedger(
  pages: ExplicitIdPdfLayoutPage[],
  context: RequirementCorpusParserContext,
) {
  type Draft = {
    id: string;
    priority: string;
    serviceLines: string[];
    requirementLines: string[];
    answerLines: string[];
    pages: number[];
    heading: string;
    order: number;
    answerKind: ExplicitIdPdfTableLayout["answerKind"];
  };

  const requirements: RequirementLedgerEntry[] = [];
  let current: Draft | null = null;
  let activeHeading = "";
  let lastLayout: ExplicitIdPdfTableLayout | null = null;
  let sawHeader = false;
  let order = 0;

  function flush() {
    if (!current) return;

    const text = context.stripAnswerTextFromRequirement(
      context.stripRequirementChrome(current.requirementLines.join(" ")),
    );
    const service = normalizePageText(current.serviceLines.join(" "));
    if (
      text.length >= 18 &&
      service &&
      (context.hasRequirementSignal(text) ||
        context.hasStandaloneRequirementLanguage(text))
    ) {
      requirements.push({
        id: current.id,
        text,
        pages: [...new Set(current.pages)].sort((left, right) => left - right),
        heading: current.heading || "Kravtabell",
        tableId: "Eksplisitt kravtabell",
        service,
        sourceExcerpt: [
          current.id,
          current.priority,
          service,
          text,
          current.answerLines.length
            ? `${current.answerKind === "supplierAnswer" ? "Leverandørens svar" : "Svarinstruks"}: ${normalizePageText(current.answerLines.join(" "))}`
            : "",
        ]
          .filter(Boolean)
          .join(" ")
          .slice(0, 1800),
        answerExcerpt:
          current.answerKind === "supplierAnswer"
            ? normalizePageText(current.answerLines.join(" ")) || undefined
            : undefined,
        documentEntryOrder: current.order,
      });
    }
    current = null;
  }

  for (const page of pages) {
    let layout = lastLayout;
    for (const line of page.lines) {
      const text = normalizePageText(line.text);
      if (!text) continue;

      const headerLayout = explicitIdPdfTableLayout(line.items);
      if (headerLayout) {
        flush();
        layout = headerLayout;
        lastLayout = headerLayout;
        sawHeader = true;
        continue;
      }

      const requirementColumnX = layout?.requirementX;
      const lineFallsInsideRequirementColumn =
        requirementColumnX !== undefined &&
        line.items.some((item) => item.x >= requirementColumnX - 8);
      if (
        /^\d+(?:\.\d+)*\.?\s+\S/u.test(text) &&
        context.isLikelyHeadingLine(text) &&
        !lineFallsInsideRequirementColumn
      ) {
        flush();
        activeHeading = context.cleanHeadingCandidate(text);
        layout = null;
        continue;
      }

      if (!layout) continue;
      const activeLayout = layout;

      const idItem = line.items.find(
        (item) =>
          item.x < activeLayout.typeX - 6 &&
          Boolean(explicitIdFromLayoutItem(item.str)),
      );
      const id = idItem ? explicitIdFromLayoutItem(idItem.str) : "";
      const priorityItem = line.items.find(
        (item) =>
          item.x >= activeLayout.typeX - 10 &&
          item.x < activeLayout.requirementX - 8 &&
          /^[ABC]$/iu.test(normalizePageText(item.str)),
      );
      const priority = normalizePageText(priorityItem?.str ?? "").toUpperCase();

      if (id && priority) {
        const idPriority = /-([ABC])\d{1,5}$/iu.exec(id)?.[1]?.toUpperCase();
        if (idPriority && idPriority !== priority) {
          flush();
          layout = null;
          continue;
        }

        flush();
        order += 1;
        current = {
          id,
          priority,
          serviceLines: [],
          requirementLines: [],
          answerLines: [],
          pages: [page.page],
          heading: activeHeading,
          order,
          answerKind: layout.answerKind,
        };

        for (const item of line.items) {
          const itemText = normalizePageText(item.str);
          if (
            !itemText ||
            item === idItem ||
            item === priorityItem ||
            isExplicitIdPdfLayoutChrome(itemText)
          ) {
            continue;
          }
          if (
            layout.answerX !== null &&
            item.x >= layout.answerX - 12
          ) {
            current.answerLines.push(itemText);
          } else if (
            layout.serviceX !== null &&
            item.x >= layout.requirementX - 8
          ) {
            current.requirementLines.push(itemText);
          } else if (
            layout.serviceX !== null &&
            item.x >= layout.serviceX - 8
          ) {
            current.serviceLines.push(itemText);
          } else if (item.x >= layout.requirementX - 8) {
            current.serviceLines.push(itemText);
          }
        }
        continue;
      }

      if (!current) continue;
      let contributed = false;
      for (const item of line.items) {
        const itemText = normalizePageText(item.str);
        if (!itemText || isExplicitIdPdfLayoutChrome(itemText)) continue;
        if (
          layout.answerX !== null &&
          item.x >= layout.answerX - 12
        ) {
          current.answerLines.push(itemText);
          contributed = true;
        } else if (item.x >= layout.requirementX - 8) {
          current.requirementLines.push(itemText);
          contributed = true;
        } else if (
          !current.requirementLines.length &&
          item.x >= (layout.serviceX ?? layout.idX) - 8
        ) {
          current.serviceLines.push(itemText);
          contributed = true;
        }
      }
      if (contributed) {
        current.pages.push(page.page);
      }
    }
  }
  flush();

  const ids = requirements.map((entry) => entry.id);
  if (
    !sawHeader ||
    ids.length < 3 ||
    new Set(ids).size !== ids.length
  ) {
    return [];
  }

  return requirements;
}

export function explicitIdTableSourceIds(rawText: string) {
  const ids = rawText
    .replace(/\r\n/gu, "\n")
    .split("\n")
    .map((line) => explicitIdTableRow(line)?.id ?? "")
    .filter(Boolean);

  // A few pipe-shaped lines are not enough to establish an authoritative
  // requirement inventory. Requiring unique repeated rows keeps this parser
  // away from ordinary prose, cross-references, and small incidental tables.
  return ids.length >= 3 && new Set(ids).size === ids.length ? ids : [];
}

export function buildExplicitIdTableRequirementLedger(
  document: ProjectDocumentDetail,
  context: RequirementCorpusParserContext,
) {
  const authoritativeIds = explicitIdTableSourceIds(document.raw_text);
  if (!authoritativeIds.length) {
    return [];
  }

  const lines = context
    .splitDocumentPagesForRequirementScan(document)
    .flatMap((page) =>
      page.text
        .replace(/\r\n/gu, "\n")
        .split("\n")
        .map((raw) => ({
          page: page.page,
          raw,
          text: normalizePageText(raw),
        })),
    );
  const rowIndexes = lines.flatMap((line, index) =>
    explicitIdTableRow(line.text) ? [index] : [],
  );
  const requirements: RequirementLedgerEntry[] = [];
  let activeHeading = "";
  let rowCursor = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line) continue;

    if (
      /^\d+(?:\.\d+)*\.?\s+\S/u.test(line.text) &&
      context.isLikelyHeadingLine(line.text)
    ) {
      activeHeading = context.cleanHeadingCandidate(line.text);
    }

    const row = explicitIdTableRow(line.text);
    if (!row) continue;

    const nextRowIndex = rowIndexes[rowCursor + 1] ?? lines.length;
    const block = lines.slice(index + 1, nextRowIndex);
    let contentStart = 0;
    let service = row.category;
    if (!service) {
      const firstContentIndex = block.findIndex((entry) => Boolean(entry.text));
      if (firstContentIndex >= 0) {
        const followingText = block
          .slice(firstContentIndex + 1, firstContentIndex + 8)
          .map((entry) => entry.text)
          .filter(Boolean)
          .join(" ");
        if (
          isLikelyDetachedCategory({
            value: block[firstContentIndex]?.text ?? "",
            followingText,
            context,
          })
        ) {
          service = block[firstContentIndex]?.text ?? "";
          contentStart = firstContentIndex + 1;
        }
      }
    }
    const instructionIndex = block.findIndex((entry, blockIndex) => {
      if (blockIndex < contentStart || !isAnswerInstructionStart(entry.text)) {
        return false;
      }
      const precedingText = block
        .slice(contentStart, blockIndex)
        .map((candidate) => candidate.text)
        .filter(Boolean)
        .join(" ");
      return (
        context.hasRequirementSignal(precedingText) ||
        context.hasStandaloneRequirementLanguage(precedingText)
      );
    });
    const headingIndex = block.findIndex(
      (entry) =>
        /^\d+(?:\.\d+)*\.?\s+\S/u.test(entry.text) &&
        context.isLikelyHeadingLine(entry.text),
    );
    const boundaryIndexes = [instructionIndex, headingIndex].filter(
      (boundary) => boundary >= 0,
    );
    const requirementEnd = boundaryIndexes.length
      ? Math.min(...boundaryIndexes)
      : block.length;
    const requirementLines = block
      .slice(contentStart, requirementEnd)
      .map((entry) => entry.text)
      .filter(Boolean);
    const requirementText = context.stripAnswerTextFromRequirement(
      context.stripRequirementChrome(requirementLines.join(" ")),
    );
    const sourceLines = block
      .slice(
        0,
        instructionIndex >= 0
          ? instructionIndex + 1
          : requirementEnd,
      )
      .map((entry) => entry.text)
      .filter(Boolean);
    const pages = [
      ...new Set(
        [line, ...block.slice(0, requirementEnd)]
          .map((entry) => entry.page)
          .filter((page) => Number.isFinite(page)),
      ),
    ];

    if (
      requirementText.length >= 18 &&
      (context.hasRequirementSignal(requirementText) ||
        context.hasStandaloneRequirementLanguage(requirementText))
    ) {
      requirements.push({
        id: row.id,
        text: requirementText,
        pages,
        heading: activeHeading,
        tableId: "Eksplisitt kravtabell",
        service,
        sourceExcerpt: [line.text, ...sourceLines].join(" ").slice(0, 1800),
        documentEntryOrder: index,
      });
    }

    rowCursor += 1;
  }

  if (
    requirements.length !== authoritativeIds.length ||
    requirements.some(
      (entry, index) => entry.id !== authoritativeIds[index],
    )
  ) {
    // A partial parse must not mask the other parsers. The evaluation guard
    // separately rejects incomplete or polluted ledgers before scoring.
    return [];
  }

  return requirements;
}
