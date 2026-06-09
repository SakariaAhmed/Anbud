import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createClient } = require("../apps/frontend/node_modules/@supabase/supabase-js");
const OpenAI = require("../apps/frontend/node_modules/openai").default;

const PREFIX = "enc:v1";
const AUTH_TAG_LENGTH = 16;
const SUPPORTED_AUTH_TAG_LENGTHS = new Set([12, 13, 14, 15, 16]);
const MAX_CHUNK_CHARS = 4800;
const CHUNK_OVERLAP_CHARS = 550;
const EMBEDDING_BATCH_SIZE = 32;
const INSERT_BATCH_SIZE = 80;

function loadEnvFile(path) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const index = trimmed.indexOf("=");
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim().replace(/^['"]|['"]$/g, "");
    if (key && process.env[key] == null) process.env[key] = value;
  }
}

loadEnvFile(".env");
loadEnvFile("apps/frontend/.env.local");

const supabaseUrl = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const openAiKey = process.env.OPENAI_API_KEY;
const embeddingModel = process.env.OPENAI_EMBEDDING_MODEL || "text-embedding-3-small";
const limitArg = process.argv.find((arg) => arg.startsWith("--limit="));
const limit = limitArg ? Number(limitArg.split("=")[1]) : null;

if (!supabaseUrl || !serviceRoleKey) {
  throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.");
}
if (!process.env.APP_ENCRYPTION_KEY) {
  throw new Error("APP_ENCRYPTION_KEY is required.");
}

const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const openai = openAiKey ? new OpenAI({ apiKey: openAiKey }) : null;

function deriveKey(secret) {
  return createHash("sha256").update(secret).digest();
}

function getEncryptionKey() {
  return deriveKey(process.env.APP_ENCRYPTION_KEY);
}

function encryptString(value) {
  if (!value) return "";
  if (value.startsWith(`${PREFIX}:`)) return value;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getEncryptionKey(), iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [PREFIX, iv.toString("base64"), tag.toString("base64"), encrypted.toString("base64")].join(":");
}

function decryptString(value) {
  if (!value || !value.startsWith(`${PREFIX}:`)) return value || "";
  const parts = value.split(":");
  const [, , ivBase64, tagBase64, ...dataParts] = parts;
  const encrypted = Buffer.from(dataParts.join(":"), "base64");
  let lastError;
  for (const payload of [
    { iv: Buffer.from(ivBase64, "base64"), tag: Buffer.from(tagBase64, "base64") },
    { iv: Buffer.from(tagBase64, "base64"), tag: Buffer.from(ivBase64, "base64") },
  ]) {
    try {
      const authTagLength = SUPPORTED_AUTH_TAG_LENGTHS.has(payload.tag.length)
        ? payload.tag.length
        : AUTH_TAG_LENGTH;
      const decipher = createDecipheriv("aes-256-gcm", getEncryptionKey(), payload.iv, {
        authTagLength,
      });
      decipher.setAuthTag(payload.tag);
      return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("Could not decrypt payload.");
}

function decryptJson(value, fallback) {
  if (!value || typeof value !== "object") return fallback;
  if (!value.encrypted || typeof value.payload !== "string") return value;
  try {
    return JSON.parse(decryptString(value.payload));
  } catch {
    return fallback;
  }
}

function normalizeText(value) {
  return String(value || "")
    .replace(/\r\n/g, "\n")
    .replace(/\u0000/g, "")
    .replace(/[ \t]+/g, " ")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .replace(/\n{4,}/g, "\n\n")
    .trim();
}

function hashText(value) {
  return createHash("sha256").update(value).digest("hex");
}

function findSplitPoint(text, preferredEnd, minimumEnd) {
  const window = text.slice(minimumEnd, Math.min(preferredEnd, text.length));
  const paragraphBreak = window.lastIndexOf("\n\n");
  if (paragraphBreak >= 0) return minimumEnd + paragraphBreak;
  const lineBreak = window.lastIndexOf("\n");
  if (lineBreak >= 0) return minimumEnd + lineBreak;
  const sentenceBreak = Math.max(window.lastIndexOf(". "), window.lastIndexOf("? "), window.lastIndexOf("! "));
  if (sentenceBreak >= 0) return minimumEnd + sentenceBreak + 1;
  const wordBreak = window.lastIndexOf(" ");
  return wordBreak >= 0 ? minimumEnd + wordBreak : Math.min(preferredEnd, text.length);
}

function splitText(text) {
  const normalized = normalizeText(text);
  if (!normalized) return [];
  if (normalized.length <= MAX_CHUNK_CHARS) return [normalized];
  const chunks = [];
  let cursor = 0;
  while (cursor < normalized.length) {
    const preferredEnd = cursor + MAX_CHUNK_CHARS;
    const minimumEnd = Math.min(cursor + Math.floor(MAX_CHUNK_CHARS * 0.72), normalized.length);
    const end = preferredEnd >= normalized.length
      ? normalized.length
      : findSplitPoint(normalized, preferredEnd, minimumEnd);
    const chunk = normalized.slice(cursor, end).trim();
    if (chunk) chunks.push(chunk);
    if (end >= normalized.length) break;
    const nextCursor = Math.max(0, end - CHUNK_OVERLAP_CHARS);
    cursor = nextCursor <= cursor ? end : nextCursor;
  }
  return chunks;
}

function detectKind(text, fileFormat) {
  if (fileFormat === "xlsx" || fileFormat === "xls") return "spreadsheet_rows";
  if (/\b(evalueringskriter|award criteria|tildelingskriter|evaluation criteria)\b/i.test(text)) return "evaluation_criteria";
  if (/\b(risiko|risk|sårbarhet|mitigering|avvik)\b/i.test(text)) return "risk";
  if (/\b(pris|kostnad|betaling|kontrakt|ssa-|sanksjon|dagmulkt|commercial|pricing)\b/i.test(text)) return "commercial_term";
  if (/\b(arkitektur|architecture|integrasjon|api|plattform|sikkerhet|identity|monitorering|backup)\b/i.test(text)) return "architecture_signal";
  if (/\b(req\.?|requirement|krav(?:tekst)?|shall|must|skal|må)\b/i.test(text)) return text.includes(" | ") ? "requirement_row" : "requirement";
  if (/\b(table|tabell|row|rad|kolonne|column)\b/i.test(text) || text.includes(" | ")) return "table";
  return "paragraph";
}

function pageRange(reference, text) {
  const pageNumbers = [
    ...`${reference}\n${text}`.matchAll(/\b(?:side|page)\s+(\d{1,5})\b/gi),
    ...`${reference}\n${text}`.matchAll(/\[\[SIDE:(\d{1,5})\]\]/g),
  ].map((match) => Number(match[1])).filter(Number.isFinite);
  return {
    page_start: pageNumbers.length ? Math.min(...pageNumbers) : null,
    page_end: pageNumbers.length ? Math.max(...pageNumbers) : null,
  };
}

function buildChunks(document) {
  const entries = Array.isArray(document.structure_map) && document.structure_map.length
    ? document.structure_map
    : [{ reference: document.title, text: document.raw_text }];
  const chunks = [];
  for (const entry of entries) {
    for (const part of splitText(entry.text)) {
      const range = pageRange(entry.reference, part);
      chunks.push({
        chunk_index: chunks.length,
        kind: detectKind(part, document.file_format),
        reference: entry.reference || document.title,
        heading_path: [],
        ...range,
        text: part,
        token_count: Math.max(1, Math.ceil(part.length / 4)),
        content_hash: hashText(part),
      });
    }
  }
  return chunks;
}

async function createEmbeddings(texts) {
  if (!openai || !texts.length) return [];
  const embeddings = [];
  for (let index = 0; index < texts.length; index += EMBEDDING_BATCH_SIZE) {
    const batch = texts.slice(index, index + EMBEDDING_BATCH_SIZE);
    const response = await openai.embeddings.create({
      model: embeddingModel,
      input: batch,
      encoding_format: "float",
    });
    for (const item of response.data) {
      embeddings[index + item.index] = item.embedding;
    }
  }
  return embeddings;
}

async function insertBatches(rows) {
  for (let index = 0; index < rows.length; index += INSERT_BATCH_SIZE) {
    const { error } = await supabase.from("document_chunks").insert(rows.slice(index, index + INSERT_BATCH_SIZE));
    if (error) throw new Error(error.message);
  }
}

async function backfillDocument(sourceType, document) {
  const chunks = buildChunks(document);
  const embeddings = await createEmbeddings(chunks.map((chunk) => chunk.text));
  await supabase.from("document_chunks").delete().eq("source_type", sourceType).eq("source_id", document.id);
  const now = new Date().toISOString();
  const rows = chunks.map((chunk, index) => ({
    source_type: sourceType,
    source_id: document.id,
    project_id: sourceType === "project_document" ? document.project_id : null,
    service_id: sourceType === "service_document" ? document.service_id : null,
    document_title: document.title,
    file_name: document.file_name,
    file_format: document.file_format,
    role: document.role ?? null,
    supporting_subtype: document.supporting_subtype ?? null,
    chunk_index: chunk.chunk_index,
    kind: chunk.kind,
    reference: chunk.reference,
    heading_path: chunk.heading_path,
    page_start: chunk.page_start,
    page_end: chunk.page_end,
    token_count: chunk.token_count,
    text_encrypted: encryptString(chunk.text),
    content_hash: chunk.content_hash,
    metadata: {
      file_name: document.file_name,
      file_format: document.file_format,
      role: document.role ?? null,
      supporting_subtype: document.supporting_subtype ?? null,
      content_hash: chunk.content_hash,
    },
    embedding: embeddings[index] ?? null,
    embedding_model: embeddings[index] ? embeddingModel : null,
    embedding_created_at: embeddings[index] ? now : null,
  }));
  if (rows.length) {
    await insertBatches(rows);
    const { error } = await supabase.rpc("update_document_chunk_search_vectors", {
      source_type_filter: sourceType,
      source_id_filter: document.id,
      chunks: chunks.map((chunk) => ({
        chunk_index: chunk.chunk_index,
        search_text: [document.title, document.file_name, chunk.kind, chunk.reference, chunk.text].join("\n"),
      })),
    });
    if (error) throw new Error(error.message);
  }
  return chunks.length;
}

async function fetchRows(table, select) {
  let query = supabase.from(table).select(select).order("created_at", { ascending: true });
  if (limit && Number.isFinite(limit)) query = query.limit(limit);
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return data || [];
}

const projectDocuments = await fetchRows(
  "documents",
  "id, project_id, role, supporting_subtype, title, file_name, file_format, raw_text, structure_map, created_at",
);
const serviceDocuments = await fetchRows(
  "service_documents",
  "id, service_id, title, file_name, file_format, raw_text, structure_map, created_at",
);

let indexed = 0;
let chunks = 0;

for (const row of projectDocuments) {
  const count = await backfillDocument("project_document", {
    ...row,
    raw_text: decryptString(row.raw_text || ""),
    structure_map: decryptJson(row.structure_map, []),
  });
  indexed += 1;
  chunks += count;
  console.log(`Indexed project document ${row.id}: ${count} chunks`);
}

for (const row of serviceDocuments) {
  const count = await backfillDocument("service_document", {
    ...row,
    raw_text: decryptString(row.raw_text || ""),
    structure_map: decryptJson(row.structure_map, []),
  });
  indexed += 1;
  chunks += count;
  console.log(`Indexed service document ${row.id}: ${count} chunks`);
}

console.log(JSON.stringify({ indexed_documents: indexed, indexed_chunks: chunks }, null, 2));
