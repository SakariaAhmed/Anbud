import "server-only";

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const PREFIX = "enc:v1";
const AUTH_TAG_LENGTH = 16;
const SUPPORTED_AUTH_TAG_LENGTHS = new Set([12, 13, 14, 15, 16]);

function deriveKey(secret: string) {
  return createHash("sha256").update(secret).digest();
}

function getEncryptionSecrets() {
  const candidates = [process.env.APP_ENCRYPTION_KEY, process.env.SUPABASE_SERVICE_ROLE_KEY]
    .filter((value): value is string => Boolean(value?.trim()))
    .map((value) => value.trim());

  return Array.from(new Set(candidates));
}

function getEncryptionKey() {
  const [primary] = getEncryptionSecrets();
  if (!primary) {
    throw new Error("Missing encryption key. Set APP_ENCRYPTION_KEY or SUPABASE_SERVICE_ROLE_KEY.");
  }

  return deriveKey(primary);
}

function getDecryptionKeys() {
  const secrets = getEncryptionSecrets();
  if (!secrets.length) {
    throw new Error("Missing encryption key. Set APP_ENCRYPTION_KEY or SUPABASE_SERVICE_ROLE_KEY.");
  }

  return secrets.map((secret) => deriveKey(secret));
}

export function encryptString(value: string) {
  if (!value) {
    return "";
  }

  if (value.startsWith(`${PREFIX}:`)) {
    return value;
  }

  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getEncryptionKey(), iv, { authTagLength: AUTH_TAG_LENGTH });
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [PREFIX, iv.toString("base64"), tag.toString("base64"), encrypted.toString("base64")].join(":");
}

export function decryptString(value: string) {
  if (!value || !value.startsWith(`${PREFIX}:`)) {
    return value;
  }

  const parts = value.split(":");
  const [, , ivBase64, tagBase64, ...dataParts] = parts;
  const dataBase64 = dataParts.join(":");
  if (!ivBase64 || !tagBase64 || !dataBase64) {
    throw new Error("Ugyldig kryptert payload.");
  }

  const encrypted = Buffer.from(dataBase64, "base64");
  let lastError: Error | null = null;

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

  for (const { iv, tag } of payloadVariants) {
    const authTagLength = SUPPORTED_AUTH_TAG_LENGTHS.has(tag.length) ? tag.length : AUTH_TAG_LENGTH;

    for (const key of getDecryptionKeys()) {
      try {
        const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength });
        decipher.setAuthTag(tag);

        const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
        return decrypted.toString("utf8");
      } catch (error) {
        lastError = error instanceof Error ? error : new Error("Kunne ikke dekryptere payload.");
      }
    }
  }

  throw lastError ?? new Error("Kunne ikke dekryptere payload.");
}

export function encryptJson<T>(value: T) {
  return {
    encrypted: true,
    payload: encryptString(JSON.stringify(value)),
  };
}

export function decryptJson<T>(value: unknown, fallback: T): T {
  if (!value || typeof value !== "object") {
    return fallback;
  }

  const payload = (value as { encrypted?: boolean; payload?: string }).payload;
  if (!(value as { encrypted?: boolean }).encrypted || typeof payload !== "string") {
    return (value as T) ?? fallback;
  }

  try {
    return JSON.parse(decryptString(payload)) as T;
  } catch {
    return fallback;
  }
}
