import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createClient } = require("../apps/frontend/node_modules/@supabase/supabase-js");

const PREFIX = "enc:v1";
const AUTH_TAG_LENGTH = 16;
const SUPPORTED_AUTH_TAG_LENGTHS = new Set([12, 13, 14, 15, 16]);

const args = new Set(process.argv.slice(2));
const APPLY = args.has("--apply");
const VERIFY_NEW_ONLY = args.has("--verify-new-only");

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
loadEnvFile(".env.local");
loadEnvFile("apps/frontend/.env.local");

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required.`);
  }

  return value;
}

const supabaseUrl = required("SUPABASE_URL");
const serviceRoleKey = required("SUPABASE_SERVICE_ROLE_KEY");
const newEncryptionSecret = required("NEW_APP_ENCRYPTION_KEY");

const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
});

function deriveKey(secret) {
  return createHash("sha256").update(secret).digest();
}

function uniqueSecrets(values) {
  const seen = new Set();
  return values
    .map((value) => value?.trim())
    .filter(Boolean)
    .filter((value) => {
      const hash = createHash("sha256").update(value).digest("hex");
      if (seen.has(hash)) return false;
      seen.add(hash);
      return true;
    });
}

function sameSecret(left, right) {
  const leftHash = deriveKey(left);
  const rightHash = deriveKey(right);
  return timingSafeEqual(leftHash, rightHash);
}

const oldSecrets = VERIFY_NEW_ONLY
  ? [newEncryptionSecret]
  : uniqueSecrets([
      newEncryptionSecret,
      process.env.OLD_APP_ENCRYPTION_KEY,
      process.env.APP_ENCRYPTION_KEY,
      process.env.SUPABASE_SERVICE_ROLE_KEY,
    ]);

if (!oldSecrets.length) {
  throw new Error(
    "At least one old key is required. Set OLD_APP_ENCRYPTION_KEY, APP_ENCRYPTION_KEY, or SUPABASE_SERVICE_ROLE_KEY.",
  );
}

if (
  !VERIFY_NEW_ONLY &&
  process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() &&
  sameSecret(process.env.SUPABASE_SERVICE_ROLE_KEY.trim(), newEncryptionSecret)
) {
  throw new Error("NEW_APP_ENCRYPTION_KEY must be different from SUPABASE_SERVICE_ROLE_KEY.");
}

const decryptionKeys = oldSecrets.map(deriveKey);
const encryptionKey = deriveKey(newEncryptionSecret);

function encryptString(value) {
  if (!value) {
    return "";
  }

  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [
    PREFIX,
    iv.toString("base64"),
    tag.toString("base64"),
    encrypted.toString("base64"),
  ].join(":");
}

function decryptString(value) {
  if (!value || !value.startsWith(`${PREFIX}:`)) {
    return value || "";
  }

  const parts = value.split(":");
  const [, , ivBase64, tagBase64, ...dataParts] = parts;
  const dataBase64 = dataParts.join(":");
  if (!ivBase64 || !tagBase64 || !dataBase64) {
    throw new Error("Invalid encrypted payload.");
  }

  const encrypted = Buffer.from(dataBase64, "base64");
  const payloadVariants = [
    {
      iv: Buffer.from(ivBase64, "base64"),
      tag: Buffer.from(tagBase64, "base64"),
    },
    {
      // Legacy payloads wrote auth tag before IV.
      iv: Buffer.from(tagBase64, "base64"),
      tag: Buffer.from(ivBase64, "base64"),
    },
  ];

  let lastError;
  for (const { iv, tag } of payloadVariants) {
    const authTagLength = SUPPORTED_AUTH_TAG_LENGTHS.has(tag.length)
      ? tag.length
      : AUTH_TAG_LENGTH;

    for (const key of decryptionKeys) {
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

function encryptJson(value) {
  return {
    encrypted: true,
    payload: encryptString(JSON.stringify(value)),
  };
}

function decryptJson(value) {
  if (!value || typeof value !== "object") {
    return value;
  }

  if (!value.encrypted || typeof value.payload !== "string") {
    return value;
  }

  return JSON.parse(decryptString(value.payload));
}

function rotateString(value) {
  if (!value) return value;
  return encryptString(decryptString(value));
}

function rotateJson(value) {
  if (!value || typeof value !== "object" || !value.encrypted) {
    return value;
  }

  return encryptJson(decryptJson(value));
}

function updateStats(stats, table, field) {
  const key = `${table}.${field}`;
  stats[key] = (stats[key] ?? 0) + 1;
}

async function selectAll(table, select) {
  const rows = [];
  const pageSize = 500;

  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from(table)
      .select(select)
      .range(from, from + pageSize - 1);

    if (error) throw new Error(`${table}: ${error.message}`);

    rows.push(...(data ?? []));
    if (!data || data.length < pageSize) break;
  }

  return rows;
}

async function updateRow(table, id, patch) {
  if (!APPLY || !Object.keys(patch).length) return;

  const { error } = await supabase.from(table).update(patch).eq("id", id);
  if (error) throw new Error(`${table}.${id}: ${error.message}`);
}

async function rotateTable({ table, select, stringFields = [], jsonFields = [] }, stats) {
  const rows = await selectAll(table, select);

  for (const row of rows) {
    const patch = {};

    for (const field of stringFields) {
      if (!row[field]) continue;
      patch[field] = rotateString(row[field]);
      updateStats(stats, table, field);
    }

    for (const field of jsonFields) {
      if (!row[field]?.encrypted) continue;
      patch[field] = rotateJson(row[field]);
      updateStats(stats, table, field);
    }

    await updateRow(table, row.id, patch);
  }

  return rows.length;
}

async function downloadStorageText(bucket, path) {
  const { data, error } = await supabase.storage.from(bucket).download(path);
  if (error || !data) {
    throw new Error(`${bucket}/${path}: ${error?.message || "download failed"}`);
  }

  return Buffer.from(await data.arrayBuffer()).toString("utf8");
}

async function uploadStorageText(bucket, path, value) {
  if (!APPLY) return;

  const { error } = await supabase.storage.from(bucket).upload(
    path,
    Buffer.from(value, "utf8"),
    {
      contentType: "application/octet-stream",
      cacheControl: "31536000",
      upsert: true,
    },
  );

  if (error) throw new Error(`${bucket}/${path}: ${error.message}`);
}

async function rotateStoredFiles(table, ownerField, stats) {
  const rows = await selectAll(
    table,
    `id, ${ownerField}, file_storage_bucket, file_storage_path`,
  );

  for (const row of rows) {
    const bucket = row.file_storage_bucket || "anbud-documents";
    const path = row.file_storage_path;
    if (!path) continue;

    try {
      const encryptedBase64 = await downloadStorageText(bucket, path);
      if (!encryptedBase64) continue;

      const rotated = rotateString(encryptedBase64);
      await uploadStorageText(bucket, path, rotated);
      updateStats(stats, table, "storage_file");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${table}.${row.id} storage ${bucket}/${path}: ${message}`);
    }
  }
}

async function main() {
  const stats = {};
  const tableConfigs = [
    {
      table: "documents",
      select: "id, file_base64, raw_text, structure_map",
      stringFields: ["file_base64", "raw_text"],
      jsonFields: ["structure_map"],
    },
    {
      table: "service_documents",
      select: "id, file_base64, raw_text, structure_map, ai_summary",
      stringFields: ["file_base64", "raw_text", "ai_summary"],
      jsonFields: ["structure_map"],
    },
    {
      table: "customer_analyses",
      select: "id, result_json",
      jsonFields: ["result_json"],
    },
    {
      table: "solution_evaluations",
      select: "id, result_json",
      jsonFields: ["result_json"],
    },
    {
      table: "executive_summaries",
      select: "id, result_json, input_snapshot",
      jsonFields: ["result_json", "input_snapshot"],
    },
    {
      table: "generated_artifacts",
      select: "id, input_snapshot",
      jsonFields: ["input_snapshot"],
    },
    {
      table: "chat_sessions",
      select: "id, summary_encrypted",
      stringFields: ["summary_encrypted"],
    },
    {
      table: "chat_messages",
      select: "id, context_snapshot",
      jsonFields: ["context_snapshot"],
    },
  ];

  for (const config of tableConfigs) {
    await rotateTable(config, stats);
  }

  await rotateStoredFiles("documents", "project_id", stats);
  await rotateStoredFiles("service_documents", "service_id", stats);

  console.log(
    JSON.stringify(
      {
        mode: VERIFY_NEW_ONLY ? "verify-new-only" : APPLY ? "apply" : "dry-run",
        changed_fields: stats,
      },
      null,
      2,
    ),
  );
}

await main();
