import { createHash, createDecipheriv } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createClient } = require("../apps/frontend/node_modules/@supabase/supabase-js");

const BUCKET = "anbud-documents";
const PREFIX = "enc:v1";
const AUTH_TAG_LENGTH = 16;
const SUPPORTED_AUTH_TAG_LENGTHS = new Set([12, 13, 14, 15, 16]);

function loadEnvFile(path) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const index = trimmed.indexOf("=");
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim().replace(/^['"]|['"]$/g, "");
    if (key && process.env[key] == null) {
      process.env[key] = value;
    }
  }
}

loadEnvFile(".env");
loadEnvFile("apps/frontend/.env.local");

const supabaseUrl = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !serviceRoleKey) {
  throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.");
}

const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
});

function deriveKey(secret) {
  return createHash("sha256").update(secret).digest();
}

function getDecryptionKeys() {
  return [process.env.APP_ENCRYPTION_KEY, process.env.SUPABASE_SERVICE_ROLE_KEY]
    .filter((value) => value?.trim())
    .map((value) => deriveKey(value.trim()));
}

function decryptString(value) {
  if (!value || !value.startsWith(`${PREFIX}:`)) {
    return value || "";
  }

  const parts = value.split(":");
  const [, , ivBase64, tagBase64, ...dataParts] = parts;
  const dataBase64 = dataParts.join(":");
  const encrypted = Buffer.from(dataBase64, "base64");
  const payloadVariants = [
    {
      iv: Buffer.from(ivBase64, "base64"),
      tag: Buffer.from(tagBase64, "base64"),
    },
    {
      iv: Buffer.from(tagBase64, "base64"),
      tag: Buffer.from(ivBase64, "base64"),
    },
  ];

  let lastError;
  for (const { iv, tag } of payloadVariants) {
    const authTagLength = SUPPORTED_AUTH_TAG_LENGTHS.has(tag.length)
      ? tag.length
      : AUTH_TAG_LENGTH;
    for (const key of getDecryptionKeys()) {
      try {
        const decipher = createDecipheriv("aes-256-gcm", key, iv, {
          authTagLength,
        });
        decipher.setAuthTag(tag);
        return Buffer.concat([
          decipher.update(encrypted),
          decipher.final(),
        ]).toString("utf8");
      } catch (error) {
        lastError = error;
      }
    }
  }

  throw lastError || new Error("Could not decrypt payload.");
}

function decryptJson(value, fallback) {
  if (!value || typeof value !== "object") {
    return fallback;
  }

  if (!value.encrypted || typeof value.payload !== "string") {
    return value;
  }

  try {
    return JSON.parse(decryptString(value.payload));
  } catch {
    return fallback;
  }
}

function safePathSegment(value) {
  return String(value || "document")
    .normalize("NFKD")
    .replace(/[^\w.\-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 140) || "document";
}

function storedPath(scope, ownerId, fileId, fileName) {
  return [scope, ownerId, fileId, safePathSegment(fileName)].join("/");
}

function pageCountFromStructureMap(structureMap, fileFormat) {
  if (fileFormat !== "pdf" || !Array.isArray(structureMap)) return null;
  const pageNumbers = structureMap
    .map((entry) => String(entry?.reference || "").match(/\bside\s+(\d{1,5})\b/i)?.[1])
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value));
  return pageNumbers.length ? Math.max(...pageNumbers) : null;
}

function pageCountFromRawText(rawText, fileFormat) {
  if (fileFormat !== "pdf" || !rawText) return null;
  const pageNumbers = [...rawText.matchAll(/\[\[SIDE:(\d{1,5})\]\]/g)]
    .map((match) => Number(match[1]))
    .filter((value) => Number.isFinite(value));
  return pageNumbers.length ? Math.max(...pageNumbers) : null;
}

function fileSizeFromEncryptedBase64(encryptedBase64) {
  const fileBase64 = decryptString(encryptedBase64);
  return fileBase64 ? Buffer.from(fileBase64, "base64").length : 0;
}

async function ensureBucket() {
  const existing = await supabase.storage.getBucket(BUCKET);
  if (!existing.error) return;

  const created = await supabase.storage.createBucket(BUCKET, {
    public: false,
    fileSizeLimit: "40MB",
  });
  if (created.error && !/already exists|duplicate/i.test(created.error.message)) {
    throw new Error(created.error.message);
  }
}

async function uploadEncryptedPayload(path, encryptedBase64) {
  const { error } = await supabase.storage.from(BUCKET).upload(
    path,
    Buffer.from(encryptedBase64, "utf8"),
    {
      contentType: "application/octet-stream",
      cacheControl: "31536000",
      upsert: true,
    },
  );
  if (error) throw new Error(error.message);
}

async function backfillTable(config) {
  const { data, error } = await supabase
    .from(config.table)
    .select(config.select)
    .neq("file_base64", "");

  if (error) throw new Error(error.message);

  let migrated = 0;
  for (const row of data || []) {
    const path =
      row.file_storage_path ||
      storedPath(config.scope, row[config.ownerColumn], row.id, row.file_name || row.display_name || row.title);

    const structureMap = decryptJson(row.structure_map, []);
    const rawText = decryptString(row.raw_text || "");
    const fileSizeBytes = row.file_size_bytes > 0
      ? row.file_size_bytes
      : fileSizeFromEncryptedBase64(row.file_base64);
    const pageCount =
      row.page_count ??
      pageCountFromStructureMap(structureMap, row.file_format) ??
      pageCountFromRawText(rawText, row.file_format);

    await uploadEncryptedPayload(path, row.file_base64);

    const update = {
      file_storage_bucket: BUCKET,
      file_storage_path: path,
      file_base64: "",
      file_size_bytes: fileSizeBytes,
    };
    if (pageCount != null) {
      update.page_count = pageCount;
    }

    const result = await supabase
      .from(config.table)
      .update(update)
      .eq("id", row.id);

    if (result.error) throw new Error(result.error.message);
    migrated += 1;
  }

  return migrated;
}

await ensureBucket();

const projectDocuments = await backfillTable({
  table: "documents",
  scope: "projects",
  ownerColumn: "project_id",
  select:
    "id, project_id, title, display_name, file_name, file_format, file_size_bytes, page_count, file_storage_path, file_base64, raw_text, structure_map",
});

const serviceDocuments = await backfillTable({
  table: "service_documents",
  scope: "services",
  ownerColumn: "service_id",
  select:
    "id, service_id, title, file_name, file_format, file_size_bytes, page_count, file_storage_path, file_base64, raw_text, structure_map",
});

console.log(
  JSON.stringify({
    project_documents_migrated: projectDocuments,
    service_documents_migrated: serviceDocuments,
  }),
);
