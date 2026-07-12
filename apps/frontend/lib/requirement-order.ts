const MISSING_ORDER_VALUE = 1_000_000_000;

export type RequirementOrderInput = {
  reference?: string | null;
  sourceReference?: string | null;
  group?: string | null;
  orderIndex?: number | null;
  documentOrderIndex?: number | null;
  entryOrderIndex?: number | null;
  fallbackIndex?: number;
};

function normalizedText(value: string | null | undefined) {
  return (value ?? "")
    .replace(/[‐‑‒–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function finiteNumber(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function missingAwareNumber(value: number | null) {
  return value ?? MISSING_ORDER_VALUE;
}

function letterRank(value: string | undefined) {
  if (!value) return 0;
  return value.toUpperCase().charCodeAt(0) - 64;
}

function parseNumberList(value: string) {
  return [...value.matchAll(/\d{1,5}/g)].map((match) => Number(match[0]));
}

function compareNumberList(left: number[], right: number[]) {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const delta =
      (left[index] ?? MISSING_ORDER_VALUE) -
      (right[index] ?? MISSING_ORDER_VALUE);
    if (delta !== 0) return delta;
  }

  return 0;
}

function compareSharedRequirementSequence(left: number[], right: number[]) {
  if (left.length < 2 || right.length < 2) return 0;
  const sharedPrefixLength = Math.min(left.length, right.length) - 1;
  for (let index = 0; index < sharedPrefixLength; index += 1) {
    if (left[index] !== right[index]) return 0;
  }
  return compareNumberList(left, right);
}

function firstMatchedNumber(text: string, pattern: RegExp) {
  const match = pattern.exec(text);
  return match?.[1] ? Number(match[1]) : null;
}

function pageStart(text: string) {
  return firstMatchedNumber(text, /\b(?:side|page)\s+(\d{1,5})\b/i);
}

function rowIndex(text: string) {
  return firstMatchedNumber(text, /\b(?:rad|row)\s+(\d{1,5})\b/i);
}

function tableKey(text: string) {
  const tableMatch =
    /\b(?:tabell|table)\s*(?:id)?\s*(\d{1,5})(?:\s*[-.]\s*(\d{1,5})([A-Z]?))?/i.exec(
      text,
    ) ?? /\bdocling\s+tabell\s+(\d{1,5})\b/i.exec(text);

  if (!tableMatch) return [];

  return [
    Number(tableMatch[1] ?? MISSING_ORDER_VALUE),
    tableMatch[2] ? Number(tableMatch[2]) : 0,
    letterRank(tableMatch[3]),
  ];
}

function requirementKey(text: string) {
  const cleaned = text
    .replace(/\b(?:side|page)\s+\d{1,5}\s+krav\s+\d{1,5}\b/gi, " ")
    .replace(/\b(?:side|page)\s+\d{1,5}(?:\s*[-–]\s*\d{1,5})?/gi, " ")
    .replace(
      /\b(?:tabell|table)\s*(?:id)?\s*\d{1,5}(?:\s*[-.]\s*\d{1,5}[A-Z]?)?/gi,
      " ",
    );
  const explicit =
    /\b(?:krav|req|requirement|id)\s*[-.:]?\s*(\d{1,5}(?:\s*[-.]\s*\d{1,5}){0,8}[A-Z]?)/i.exec(
      cleaned,
    )?.[1] ?? cleaned.match(/\b\d{1,5}(?:\s*[.-]\s*\d{1,5}){1,8}[A-Z]?\b/)?.[0];

  if (!explicit) return [];

  const numbers = parseNumberList(explicit);
  const letter = explicit.match(/([A-Z])\s*$/i)?.[1];
  return letter ? [...numbers, letterRank(letter)] : numbers;
}

function buildOrderKey(input: RequirementOrderInput) {
  const combined = [
    input.sourceReference,
    input.group,
    input.reference,
  ]
    .map(normalizedText)
    .filter(Boolean)
    .join(" ");

  return {
    documentOrder: finiteNumber(input.documentOrderIndex),
    entryOrder: finiteNumber(input.entryOrderIndex),
    explicitOrder: finiteNumber(input.orderIndex),
    page: pageStart(combined),
    table: tableKey(combined),
    row: rowIndex(combined),
    requirement: requirementKey(combined),
    fallbackIndex: input.fallbackIndex ?? MISSING_ORDER_VALUE,
    text: combined.toLocaleLowerCase("nb"),
  };
}

export function compareRequirementOrder(
  left: RequirementOrderInput,
  right: RequirementOrderInput,
) {
  const leftKey = buildOrderKey(left);
  const rightKey = buildOrderKey(right);

  if (leftKey.documentOrder !== null || rightKey.documentOrder !== null) {
    const documentDelta =
      missingAwareNumber(leftKey.documentOrder) -
      missingAwareNumber(rightKey.documentOrder);
    if (documentDelta !== 0) return documentDelta;
  }

  if (leftKey.entryOrder !== null && rightKey.entryOrder !== null) {
    const entryDelta = leftKey.entryOrder - rightKey.entryOrder;
    if (entryDelta !== 0) return entryDelta;
  }

  if (leftKey.entryOrder !== null || rightKey.entryOrder !== null) {
    const pageDelta =
      missingAwareNumber(leftKey.page) - missingAwareNumber(rightKey.page);
    if (pageDelta !== 0) return pageDelta;

    const sequenceDelta = compareSharedRequirementSequence(
      leftKey.requirement.length ? leftKey.requirement : leftKey.table,
      rightKey.requirement.length ? rightKey.requirement : rightKey.table,
    );
    if (sequenceDelta !== 0) return sequenceDelta;

    const entryDelta =
      missingAwareNumber(leftKey.entryOrder) -
      missingAwareNumber(rightKey.entryOrder);
    if (entryDelta !== 0) return entryDelta;
  }

  if (leftKey.explicitOrder !== null || rightKey.explicitOrder !== null) {
    const explicitOrderDelta =
      missingAwareNumber(leftKey.explicitOrder) -
      missingAwareNumber(rightKey.explicitOrder);
    if (explicitOrderDelta !== 0) return explicitOrderDelta;
  }

  const pageDelta =
    missingAwareNumber(leftKey.page) - missingAwareNumber(rightKey.page);
  if (pageDelta !== 0) return pageDelta;

  const requirementDelta = compareNumberList(
    leftKey.requirement,
    rightKey.requirement,
  );
  if (requirementDelta !== 0) return requirementDelta;

  const tableDelta = compareNumberList(leftKey.table, rightKey.table);
  if (tableDelta !== 0) return tableDelta;

  const rowDelta =
    missingAwareNumber(leftKey.row) - missingAwareNumber(rightKey.row);
  if (rowDelta !== 0) return rowDelta;

  const fallbackDelta = leftKey.fallbackIndex - rightKey.fallbackIndex;
  if (fallbackDelta !== 0) return fallbackDelta;

  return leftKey.text.localeCompare(rightKey.text, "nb", {
    numeric: true,
    sensitivity: "base",
  });
}

export function sortByRequirementOrder<T>(
  items: T[],
  toOrderInput: (item: T, index: number) => RequirementOrderInput,
) {
  return items
    .map((item, index) => ({ item, index }))
    .sort((left, right) =>
      compareRequirementOrder(
        {
          fallbackIndex: left.index,
          ...toOrderInput(left.item, left.index),
        },
        {
          fallbackIndex: right.index,
          ...toOrderInput(right.item, right.index),
        },
      ),
    )
    .map(({ item }) => item);
}
