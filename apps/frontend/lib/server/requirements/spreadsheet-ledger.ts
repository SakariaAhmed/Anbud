import type { ProjectDocumentDetail } from "@/lib/types";
import type { RequirementLedgerEntry } from "@/lib/server/requirements/types";

// The spreadsheet parser (lib/server/documents.ts) emits one line per row:
// "Rad 6: A6: KD-01 | B6: Kategori | C6: Kravtekst". Requirement matrices
// are read row by row from that text, using the header row to find columns.
const SHEET_PATTERN = /^Ark: (.+)$/u;
const ROW_PATTERN = /^Rad (\d{1,6}): (.*)$/u;

const HEADER_MATCHERS = {
  id: /^(?:krav[\s-]*id|krav[\s-]*nr\.?|kravnummer|krav[\s-]*ref(?:eranse)?|id|nr\.?|ref\.?|requirement\s+id)$/iu,
  text: /^(?:kravtekst|krav|kravbeskrivelse|beskrivelse(?:\s+av\s+krav)?|requirement(?:\s+text)?)$/iu,
  type: /^(?:type|kravtype|krav\s*type|absolutt\s*\/\s*evaluert|prioritet|requirement\s+type)$/iu,
  category: /^(?:kategori|område|tema|kapittel|seksjon)$/iu,
  weight: /^vekt\b/iu,
  criterion: /^(?:evalueringskriterium|tildelingskriterium|evaluering)$/iu,
  reference: /^(?:ref\.?\s*bilag\s*\d*|referanse\s+til\s+.+|henvisning\s+til\s+krav)$/iu,
} as const;
type Column = keyof typeof HEADER_MATCHERS;

const REQUIREMENT_ID_PATTERN =
  /^(?:[A-ZÆØÅ]{1,8}[-.\s]?\d{1,4}(?:[.-]\d{1,3})*[a-z]?|\d{1,3}(?:\.\d{1,3}){1,4})$/u;
const MIN_REQUIREMENT_TEXT_CHARS = 15;

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

function headerColumns(row: SheetRow) {
  const columns: Partial<Record<Column, string>> = {};
  for (const [column, value] of row.cells) {
    const label = value.replace(/\s+/gu, " ").trim();
    for (const key of Object.keys(HEADER_MATCHERS) as Column[]) {
      if (!columns[key] && HEADER_MATCHERS[key].test(label)) {
        columns[key] = column;
        break;
      }
    }
  }
  return columns.id && columns.text && columns.id !== columns.text ? columns : null;
}

/**
 * Extracts one requirement per data row of a spreadsheet requirement matrix
 * (a header row with a requirement-ID column and a requirement-text column).
 * Rows with only a first-column label are section headings. Supplier answer
 * columns are not part of the source requirement. Returns [] when no sheet
 * holds a matrix with at least two requirement rows, so other extractors run.
 */
export function buildSpreadsheetRequirementLedger(
  document: Pick<ProjectDocumentDetail, "file_format" | "raw_text">,
): RequirementLedgerEntry[] {
  if (document.file_format !== "xlsx" && document.file_format !== "xls") return [];
  const entries: RequirementLedgerEntry[] = [];
  for (const sheet of parseSheets(document.raw_text)) {
    const headerIndex = sheet.rows.findIndex((row) => headerColumns(row));
    if (headerIndex < 0) continue;
    const columns = headerColumns(sheet.rows[headerIndex]!)!;
    const sheetEntries: RequirementLedgerEntry[] = [];
    let section = "";
    for (const row of sheet.rows.slice(headerIndex + 1)) {
      const value = (column: Column) => (columns[column] ? row.cells.get(columns[column]!) ?? "" : "");
      const id = value("id").replace(/\s+/gu, " ").trim();
      const text = value("text").replace(/\s+/gu, " ").trim();
      if (!REQUIREMENT_ID_PATTERN.test(id) || text.length < MIN_REQUIREMENT_TEXT_CHARS) {
        // A lone label in the first used column ("1 Krav til tilbyder") opens a section.
        if (row.cells.size === 1 && !text) section = [...row.cells.values()][0]!.trim();
        continue;
      }
      const category = value("category");
      sheetEntries.push({
        id,
        text,
        pages: [],
        heading: section || category || sheet.name,
        ...(category ? { service: category } : {}),
        sourceExcerpt: [
          `Ark ${sheet.name}, Rad ${row.number}`,
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
      });
    }
    if (sheetEntries.length >= 2) entries.push(...sheetEntries);
  }
  return entries;
}
