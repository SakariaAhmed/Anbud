import "server-only";

import type {
  ParsedUpload,
  SourceMapEntry,
} from "@/lib/server/documents";

const AZURE_DOCUMENT_INTELLIGENCE_API_VERSION = "2024-11-30";
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 300_000;

type AzurePoint = { x?: unknown; y?: unknown };
type AzureBoundingRegion = {
  pageNumber?: unknown;
  polygon?: unknown;
};

function configuredTimeoutMs() {
  const configured = Number(process.env.AZURE_DOCUMENT_INTELLIGENCE_TIMEOUT_MS);
  if (!Number.isFinite(configured) || configured < 5_000) {
    return DEFAULT_TIMEOUT_MS;
  }
  return Math.min(MAX_TIMEOUT_MS, Math.floor(configured));
}

function azureConfiguration() {
  const endpoint = process.env.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT?.trim();
  const key = process.env.AZURE_DOCUMENT_INTELLIGENCE_KEY?.trim();
  if (!endpoint || !key) return null;

  const url = new URL(endpoint);
  const localDevelopment = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !localDevelopment) {
    throw new Error("Azure Document Intelligence-endepunktet må bruke HTTPS.");
  }
  return { endpoint: url, key };
}

export function isAzureDocumentIntelligenceConfigured() {
  try {
    return azureConfiguration() !== null;
  } catch {
    return false;
  }
}

function boundedNumber(value: unknown, minimum: number, maximum: number) {
  const number = Number(value);
  return Number.isFinite(number) && number >= minimum && number <= maximum
    ? number
    : undefined;
}

function boundingRegion(value: unknown) {
  if (!Array.isArray(value) || !value.length) {
    return { page: null as number | null, polygon: undefined as number[] | undefined };
  }
  const region = value[0] as AzureBoundingRegion;
  const page = boundedNumber(region.pageNumber, 1, 100_000) ?? null;
  const polygon = Array.isArray(region.polygon)
    ? region.polygon
        .slice(0, 16)
        .flatMap((point) => {
          const candidate = point as AzurePoint;
          const x = boundedNumber(candidate.x, -1_000_000, 1_000_000);
          const y = boundedNumber(candidate.y, -1_000_000, 1_000_000);
          return x === undefined || y === undefined ? [] : [x, y];
        })
    : undefined;
  return { page, polygon: polygon?.length ? polygon : undefined };
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizedConfidence(value: unknown) {
  return boundedNumber(value, 0, 1);
}

export function normalizeAzureLayoutResult(input: {
  analyzeResult: unknown;
  title: string;
}): { rawText: string; sourceMap: SourceMapEntry[] } {
  const result =
    input.analyzeResult && typeof input.analyzeResult === "object"
      ? (input.analyzeResult as Record<string, unknown>)
      : {};
  const sourceMap: SourceMapEntry[] = [];
  const paragraphs = Array.isArray(result.paragraphs) ? result.paragraphs : [];

  for (const [index, value] of paragraphs.entries()) {
    const paragraph = value as Record<string, unknown>;
    const text = stringValue(paragraph.content);
    if (!text) continue;
    const region = boundingRegion(paragraph.boundingRegions);
    const role = stringValue(paragraph.role);
    sourceMap.push({
      reference: `${input.title}${region.page ? ` side ${region.page}` : ""}, avsnitt ${index + 1}`,
      text,
      kind: "azure_paragraph",
      parser: "azure-layout-v4",
      page: region.page,
      source_id: `paragraph-${index}`,
      ...(role ? { role } : {}),
      ...(region.polygon ? { polygon: region.polygon } : {}),
    });
  }

  const tables = Array.isArray(result.tables) ? result.tables : [];
  for (const [tableIndex, value] of tables.entries()) {
    const table = value as Record<string, unknown>;
    const cells = Array.isArray(table.cells) ? table.cells : [];
    const columnHeaders = new Map<number, string>();
    const rowCells = new Map<number, Map<number, string>>();
    let tableRegion = boundingRegion(table.boundingRegions);

    for (const cellValue of cells) {
      const cell = cellValue as Record<string, unknown>;
      const rowIndex = boundedNumber(cell.rowIndex, 0, 100_000);
      const columnIndex = boundedNumber(cell.columnIndex, 0, 10_000);
      const content = stringValue(cell.content);
      if (rowIndex === undefined || columnIndex === undefined || !content) continue;
      const kind = stringValue(cell.kind);
      if (kind === "columnHeader") columnHeaders.set(columnIndex, content);
      const row = rowCells.get(rowIndex) ?? new Map<number, string>();
      row.set(columnIndex, [row.get(columnIndex), content].filter(Boolean).join(" "));
      rowCells.set(rowIndex, row);
      if (!tableRegion.page) tableRegion = boundingRegion(cell.boundingRegions);
    }

    const columnIndexes = [...new Set(
      [...rowCells.values()].flatMap((row) => [...row.keys()]),
    )].sort((left, right) => left - right);
    const columns = columnIndexes.map(
      (columnIndex, position) =>
        columnHeaders.get(columnIndex) ?? `Kolonne ${position + 1}`,
    );

    for (const [rowIndex, row] of [...rowCells.entries()].sort(
      ([left], [right]) => left - right,
    )) {
      if (rowIndex === 0 && columnHeaders.size) continue;
      const mappedCells = Object.fromEntries(
        columnIndexes.map((columnIndex, position) => [
          columns[position] ?? `Kolonne ${position + 1}`,
          row.get(columnIndex) ?? "",
        ]),
      );
      const text = Object.entries(mappedCells)
        .filter(([, cell]) => cell)
        .map(([column, cell]) => `${column}: ${cell}`)
        .join(" | ");
      if (!text) continue;
      sourceMap.push({
        reference: `${input.title} tabell ${tableIndex + 1}, rad ${rowIndex + 1}${tableRegion.page ? `, side ${tableRegion.page}` : ""}`,
        text,
        kind: "azure_table_row",
        parser: "azure-layout-v4",
        page: tableRegion.page,
        table_index: tableIndex,
        row_index: rowIndex,
        columns,
        cells: mappedCells,
        source_id: `table-${tableIndex}-row-${rowIndex}`,
        ...(tableRegion.polygon ? { polygon: tableRegion.polygon } : {}),
      });
    }
  }

  const figures = Array.isArray(result.figures) ? result.figures : [];
  for (const [figureIndex, value] of figures.entries()) {
    const figure = value as Record<string, unknown>;
    const region = boundingRegion(figure.boundingRegions);
    const caption =
      figure.caption && typeof figure.caption === "object"
        ? stringValue((figure.caption as Record<string, unknown>).content)
        : "";
    const text = caption || `Figur ${figureIndex + 1} uten maskinlesbar bildetekst`;
    sourceMap.push({
      reference: `${input.title} figur ${figureIndex + 1}${region.page ? `, side ${region.page}` : ""}`,
      text,
      kind: "azure_figure",
      parser: "azure-layout-v4",
      page: region.page,
      source_id: stringValue(figure.id) || `figure-${figureIndex}`,
      ...(region.polygon ? { polygon: region.polygon } : {}),
      ...(normalizedConfidence(figure.confidence) !== undefined
        ? { confidence: normalizedConfidence(figure.confidence) }
        : {}),
    });
  }

  const resultContent = stringValue(result.content);
  return {
    rawText:
      resultContent ||
      sourceMap.map((entry) => entry.text).filter(Boolean).join("\n\n"),
    sourceMap,
  };
}

function abortAfter(timeoutMs: number, externalSignal?: AbortSignal) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const abort = () => controller.abort();
  externalSignal?.addEventListener("abort", abort, { once: true });
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timeout);
      externalSignal?.removeEventListener("abort", abort);
    },
  };
}

async function waitForPoll(milliseconds: number, signal: AbortSignal) {
  await new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("Azure Document Intelligence-kallet ble avbrutt."));
      return;
    }
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    const abort = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      reject(new Error("Azure Document Intelligence-kallet ble avbrutt."));
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

export async function extractWithAzureLayout(input: {
  buffer: Buffer;
  fileName: string;
  contentType: string;
  fileFormat: ParsedUpload["fileFormat"];
  title: string;
  useHighResolution?: boolean;
  signal?: AbortSignal;
}): Promise<ParsedUpload> {
  const configuration = azureConfiguration();
  if (!configuration) {
    throw new Error("Azure Document Intelligence er ikke konfigurert.");
  }
  const requestUrl = new URL(
    "documentintelligence/documentModels/prebuilt-layout:analyze",
    configuration.endpoint.toString().endsWith("/")
      ? configuration.endpoint
      : `${configuration.endpoint.toString()}/`,
  );
  requestUrl.searchParams.set("api-version", AZURE_DOCUMENT_INTELLIGENCE_API_VERSION);
  requestUrl.searchParams.set("outputContentFormat", "markdown");
  requestUrl.searchParams.set("output", "figures");
  if (input.useHighResolution) {
    requestUrl.searchParams.set("features", "ocrHighResolution");
  }

  const timeout = abortAfter(configuredTimeoutMs(), input.signal);
  try {
    const response = await fetch(requestUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Ocp-Apim-Subscription-Key": configuration.key,
      },
      body: JSON.stringify({ base64Source: input.buffer.toString("base64") }),
      signal: timeout.signal,
    });
    if (!response.ok) {
      throw new Error(`Azure Document Intelligence avviste dokumentet (${response.status}).`);
    }
    const operationLocation = response.headers.get("operation-location");
    if (!operationLocation) {
      throw new Error("Azure Document Intelligence manglet operation-location.");
    }
    const operationUrl = new URL(operationLocation);
    if (operationUrl.origin !== configuration.endpoint.origin) {
      throw new Error("Azure Document Intelligence returnerte et uventet poll-endepunkt.");
    }

    while (!timeout.signal.aborted) {
      await waitForPoll(650, timeout.signal);
      const poll = await fetch(operationUrl, {
        headers: { "Ocp-Apim-Subscription-Key": configuration.key },
        signal: timeout.signal,
      });
      if (!poll.ok) {
        throw new Error(`Azure Document Intelligence-polling feilet (${poll.status}).`);
      }
      const body = (await poll.json()) as Record<string, unknown>;
      const status = stringValue(body.status).toLowerCase();
      if (status === "failed" || status === "canceled") {
        throw new Error("Azure Document Intelligence kunne ikke analysere dokumentet.");
      }
      if (status !== "succeeded") continue;
      const normalized = normalizeAzureLayoutResult({
        analyzeResult: body.analyzeResult,
        title: input.title,
      });
      return {
        rawText: normalized.rawText,
        sourceMap: normalized.sourceMap,
        contentType: input.contentType,
        fileName: input.fileName,
        fileFormat: input.fileFormat,
        fileBase64: input.buffer.toString("base64"),
        parserUsed: "azure-layout-v4",
      };
    }
    throw new Error("Azure Document Intelligence overskred tidsfristen.");
  } finally {
    timeout.cleanup();
  }
}
