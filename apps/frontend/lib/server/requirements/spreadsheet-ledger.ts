import type { ProjectDocumentDetail } from "@/lib/types";
import type { RequirementLedgerEntry } from "@/lib/server/requirements/types";

// The spreadsheet parser (lib/server/documents.ts) emits one line per row:
// "Rad 6: A6: KD-01 | B6: Kategori | C6: Kravtekst". Requirement matrices
// are read row by row from that text, using the header row to find columns.
const SHEET_PATTERN = /^Ark: (.+)$/u;
const ROW_PATTERN = /^Rad (\d{1,6}): (.*)$/u;

const HEADER_MATCHERS = {
  id: /^(?:krav[\s-]*id|krav[\s-]*nr\.?|kravnummer|krav[\s-]*ref(?:eranse)?|id|nr\.?|ref\.?|requirement\s+id)$/iu,
  text: /^(?:kravtekst|kravbeskrivelse|beskrivelse(?:\s+(?:av\s+)?krav(?:et)?)?|requirement(?:\s+text)?|krav)$/iu,
  title: /^(?:krav|kravtittel|tittel|overskrift)$/iu,
  type: /^(?:type|kravtype|krav\s*type|absolutt\s*\/\s*evaluert|prioritet|requirement\s+type)$/iu,
  category: /^(?:kategori|område|tema|kapittel|seksjon)$/iu,
  weight: /^vekt\b/iu,
  criterion: /^(?:evalueringskriterium|tildelingskriterium|evaluering)$/iu,
  reference: /^(?:ref\.?\s*bilag\s*\d*|referanse\s+til\s+.+|henvisning\s+til\s+krav)$/iu,
  // Columns the supplier fills in; never part of the source requirement.
  answer: /^(?:leverandørens\s+(?:svar|besvarelse|kommentar)|tilbyders\s+(?:svar|besvarelse|kommentar)|svar|besvarelse|henvisning\s+i\s+tilbudet|oppfylt(?:\s*\(?\s*ja\s*\/\s*nei\s*\)?)?)$/iu,
} as const;
// A sheet with price or quantity columns is a price form, not a matrix.
// "Enhet" or "Antall" alone is not enough: an organisational-unit column
// is common in requirement matrices.
const PRICE_HEADER = /^(?:pris|enhetspris|sum|beløp|totalpris|timepris|pris\s+per\b.*)$/iu;
type Column = keyof typeof HEADER_MATCHERS;

// The ID column is known from its header, so plain numbers ("7", "3.2") are
// IDs there too.
const REQUIREMENT_ID_PATTERN =
  /^(?:[A-ZÆØÅa-zæøå]{1,8}(?:-[A-ZÆØÅa-zæøå]{1,8})*[-.\s]?\d{1,4}(?:[.-]\d{1,3})*[a-z]?|\d{1,4}(?:\.\d{1,3}){0,4})$/u;
// Any value that looks like it is meant as an ID (has a digit, is short).
const ID_LIKE = /^(?=.*\d)\S.{0,23}$/u;
const MIN_REQUIREMENT_TEXT_CHARS = 1;

type SheetRow = { number: number; cells: Map<string, string> };

function parseRow(number: number, body: string): SheetRow {
  const cells = new Map<string, string>();
  // Split only before the next cell address of this row, so a literal " | "
  // inside a cell does not start a new cell.
  for (const part of body.split(new RegExp(` \\| (?=[A-Z]{1,3}${number}: )`, "u"))) {
    const match = new RegExp(`^([A-Z]{1,3})${number}: ([\\s\\S]*)$`, "u").exec(part);
    if (match) cells.set(match[1]!, match[2]!.trim());
  }
  return { number, cells };
}

function parseSheets(rawText: string) {
  const sheets: Array<{ name: string; rows: SheetRow[] }> = [];
  for (const line of rawText.split("\n")) {
    const sheet = SHEET_PATTERN.exec(line.trim());
    if (sheet) {
      sheets.push({ name: sheet[1]!.trim(), rows: [] });
      continue;
    }
    const row = ROW_PATTERN.exec(line.trim());
    if (row && sheets.length) {
      sheets.at(-1)!.rows.push(parseRow(Number(row[1]), row[2]!));
    }
  }
  return sheets;
}

// Which column holds the requirement text when several qualify: the full
// wording beats a description, which beats a short "Krav" title.
function textPriority(label: string) {
  if (/^kravtekst$|^requirement\s+text$/iu.test(label)) return 4;
  if (/^(?:kravbeskrivelse|beskrivelse\s+(?:av\s+)?krav(?:et)?)$/iu.test(label)) return 3;
  if (/^(?:beskrivelse|requirement)$/iu.test(label)) return 2;
  return 1;
}

function headerColumns(row: SheetRow, continuation?: SheetRow) {
  const columns: Partial<Record<Column, string>> = {};
  // A header may span two rows ("Krav-" / "ID", or ID and text labels on
  // separate rows): each column's label is tried from either row and joined.
  const labels = new Map<string, string[]>();
  for (const [column, value] of row.cells) labels.set(column, [value]);
  for (const [column, value] of continuation?.cells ?? []) {
    const first = labels.get(column)?.[0];
    labels.set(column, first ? [first, value, `${first} ${value}`, `${first}${value}`] : [value]);
  }
  const clean = (label: string) => label.replace(/[()]/gu, " ").replace(/\s+/gu, " ").trim();
  const textCandidates: Array<{ column: string; priority: number }> = [];
  for (const [column, candidates] of labels) {
    const textLabel = candidates.map(clean).find((label) => HEADER_MATCHERS.text.test(label));
    if (textLabel) {
      textCandidates.push({ column, priority: textPriority(textLabel) });
      continue;
    }
    for (const key of Object.keys(HEADER_MATCHERS) as Column[]) {
      if (key === "text" || key === "title") continue;
      if (
        !columns[key] &&
        !Object.values(columns).includes(column) &&
        candidates.some((label) => HEADER_MATCHERS[key].test(clean(label)))
      ) {
        columns[key] = column;
        break;
      }
    }
  }
  textCandidates.sort((left, right) => right.priority - left.priority);
  const [text, title] = textCandidates.filter((candidate) => candidate.column !== columns.id);
  if (text) columns.text = text.column;
  if (title && title.priority === 1) columns.title = title.column;
  const isPriceForm = [...labels.values()].some((candidates) => candidates.some((label) => PRICE_HEADER.test(clean(label))));
  return columns.id && columns.text && columns.id !== columns.text && !isPriceForm ? columns : null;
}

type MatrixRow = {
  sheet: string;
  row: SheetRow;
  columns: Partial<Record<Column, string>>;
  section: string;
  /** Text-column cells of following rows without an ID. */
  continuation: string[];
};

/** Every data row of every requirement matrix: a header row (possibly over
 * two rows, possibly repeated with another layout further down) followed by
 * rows whose ID column holds an ID. A numeric ID that prefixes the next
 * row's ID ("1" before "1.1") and carries no type or weight is a section. */
function matrixRows(document: Pick<ProjectDocumentDetail, "file_format" | "raw_text">) {
  if (document.file_format !== "xlsx" && document.file_format !== "xls") return [];
  const rows: MatrixRow[] = [];
  for (const sheet of parseSheets(document.raw_text)) {
    let columns: Partial<Record<Column, string>> | null = null;
    let section = "";
    for (let index = 0; index < sheet.rows.length; index += 1) {
      const row = sheet.rows[index]!;
      // A two-row header starts on a row that carries a header label and no
      // ID; a data row followed by another layout's header is not one.
      const values = [...row.cells.values()].map((value) => value.trim());
      const startsHeader =
        values.some((value) => Object.values(HEADER_MATCHERS).some((matcher) => matcher.test(value))) &&
        !values.some((value) => REQUIREMENT_ID_PATTERN.test(value));
      const header =
        headerColumns(row) ??
        (startsHeader && sheet.rows[index + 1] ? headerColumns(row, sheet.rows[index + 1]) : null);
      if (header) {
        columns = header;
        if (!headerColumns(row)) index += 1;
        continue;
      }
      if (!columns) continue;
      const cell = (column?: string) => (column ? (row.cells.get(column) ?? "").replace(/\s+/gu, " ").trim() : "");
      const id = cell(columns.id);
      const text = cell(columns.text);
      if (!id) {
        // A row with only requirement text continues the previous one.
        const onlyText = text && [...row.cells.keys()].every((column) => column === columns!.text);
        if (onlyText && rows.at(-1)?.sheet === sheet.name) rows.at(-1)!.continuation.push(text);
        else if (row.cells.size === 1) section = [...row.cells.values()][0]!.trim();
        continue;
      }
      if (REQUIREMENT_ID_PATTERN.test(id)) {
        const nextId = (sheet.rows[index + 1]?.cells.get(columns.id!) ?? "").trim();
        // A numbered heading row, not a parent requirement that states one.
        const isNumberedSection =
          /^\d{1,4}(?:\.\d{1,3})*$/u.test(id) &&
          nextId.startsWith(`${id}.`) &&
          !cell(columns.type) &&
          !cell(columns.weight) &&
          text.length <= 80 &&
          // Unicode-aware: \b does not end "må" or "bør".
          !/(?<![\p{L}\p{N}])(?:skal|bør|må)(?![\p{L}\p{N}])/iu.test(text);
        if (isNumberedSection) {
          section = [id, text || cell(columns.title)].filter(Boolean).join(" ");
          continue;
        }
        rows.push({ sheet: sheet.name, row, columns, section, continuation: [] });
      } else if (ID_LIKE.test(id) && text) {
        // An unusual ID form ("1.1a", "K1-A", "REQ_001") is still the
        // matrix's ID: the row is kept under it, never dropped.
        rows.push({ sheet: sheet.name, row, columns, section, continuation: [] });
      } else if (row.cells.size === 1) {
        // A lone label ("1 Krav til tilbyder") opens a section.
        section = [...row.cells.values()][0]!.trim();
      }
    }
  }
  return rows;
}

/** The IDs of all matrix data rows, whether or not their text or ID form
 * could be read: completeness checks use this, so no row disappears. */
export function spreadsheetRequirementIds(
  document: Pick<ProjectDocumentDetail, "file_format" | "raw_text">,
) {
  return matrixRows(document).map(({ row, columns }) =>
    (row.cells.get(columns.id!) ?? "").replace(/\s+/gu, " ").trim(),
  );
}

/**
 * Extracts one requirement per data row of a spreadsheet requirement matrix
 * (a header row with a requirement-ID column and a requirement-text column).
 * Rows with only a first-column label are section headings. Supplier answer
 * columns are not part of the source requirement; a row whose text cell is
 * empty is not emitted, but its ID stays in `spreadsheetRequirementIds`, so
 * the completeness guard reports it.
 * Returns [] when no sheet holds a matrix, so other extractors run.
 */
export function buildSpreadsheetRequirementLedger(
  document: Pick<ProjectDocumentDetail, "file_format" | "raw_text">,
): RequirementLedgerEntry[] {
  // A readable row keeps its ID as written, also an unusual form ("1.1a",
  // "K1-A", "REQ_001"): dropping it lost the requirement.
  return matrixRows(document).flatMap(({ sheet, row, columns, section, continuation }) => {
    const value = (column: Column) => (columns[column] ? row.cells.get(columns[column]!) ?? "" : "");
    const id = value("id").replace(/\s+/gu, " ").trim();
    // Only the requirement text column (and its continuation rows): other
    // cells, often supplier answers, never stand in for missing wording;
    // such a row stays in the inventory so the completeness guard reports it.
    const body = [value("text"), ...continuation].join(" ").replace(/\s+/gu, " ").trim();
    // A short title column ("Krav") is kept with the full description.
    const title = value("title").replace(/\s+/gu, " ").trim();
    const text = title && body && !body.startsWith(title) ? `${title}: ${body}` : body || title;
    if (text.length < MIN_REQUIREMENT_TEXT_CHARS) return [];
    const category = value("category");
    return [{
      id,
      text,
      pages: [],
      heading: section || category || sheet,
      ...(category ? { service: category } : {}),
      sourceExcerpt: [
        `Ark ${sheet}, Rad ${row.number}`,
        `Krav-ID: ${id}`,
        category ? `Kategori: ${category}` : "",
        `Kravtekst: ${text}`,
        value("type") ? `Type: ${value("type")}` : "",
        value("weight") ? `Vekt: ${value("weight")}` : "",
        value("criterion") ? `Evalueringskriterium: ${value("criterion")}` : "",
        value("reference") ? `Referanse: ${value("reference")}` : "",
      ]
        .filter(Boolean)
        .join(" | "),
    }];
  });
}
