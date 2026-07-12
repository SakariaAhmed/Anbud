function isEscaped(value: string, index: number) {
  let backslashCount = 0;

  for (let cursor = index - 1; cursor >= 0 && value[cursor] === "\\"; cursor -= 1) {
    backslashCount += 1;
  }

  return backslashCount % 2 === 1;
}

/**
 * Splits a Markdown table row without treating escaped pipes as delimiters.
 * Only the backslash that escapes a pipe is removed; all other backslashes are
 * preserved so paths and other literal content survive client-side rendering.
 */
export function splitMarkdownTableRow(line: string) {
  const trimmed = line.trim();
  const start = trimmed.startsWith("|") ? 1 : 0;
  const lastIndex = trimmed.length - 1;
  const end =
    lastIndex >= start &&
    trimmed[lastIndex] === "|" &&
    !isEscaped(trimmed, lastIndex)
      ? lastIndex
      : trimmed.length;
  const body = trimmed.slice(start, end);
  const cells: string[] = [];
  let current = "";
  let backslashCount = 0;

  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (char === "\\") {
      current += char;
      backslashCount += 1;
      continue;
    }

    if (char !== "|") {
      current += char;
      backslashCount = 0;
      continue;
    }

    if (backslashCount % 2 === 1) {
      current = `${current.slice(0, -1)}|`;
      backslashCount = 0;
      continue;
    }

    cells.push(current.trim());
    current = "";
    backslashCount = 0;
  }

  cells.push(current.trim());
  return cells;
}
