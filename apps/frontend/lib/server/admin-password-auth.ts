import "server-only";

import { scrypt, timingSafeEqual } from "node:crypto";

const PRINCIPAL_ID_PATTERN = /^[A-Za-z0-9_-]{20,128}$/u;
const HASH_PATTERN = /^[A-Za-z0-9_-]+$/u;
const MAX_PASSWORD_LENGTH = 256;
const DERIVED_KEY_LENGTH = 32;

type ScryptHash = {
  cost: number;
  blockSize: number;
  parallelization: number;
  salt: Buffer;
  digest: Buffer;
};

function configuredHash() {
  return process.env.APP_ADMIN_ACCESS_PASSWORD_HASH?.trim() ?? "";
}

function parseHash(encoded: string): ScryptHash | null {
  const [algorithm, costText, blockSizeText, parallelizationText, saltText, digestText, extra] =
    encoded.split("$");
  if (
    algorithm !== "scrypt" ||
    extra !== undefined ||
    !saltText ||
    !digestText ||
    !HASH_PATTERN.test(saltText) ||
    !HASH_PATTERN.test(digestText)
  ) {
    return null;
  }

  const cost = Number(costText);
  const blockSize = Number(blockSizeText);
  const parallelization = Number(parallelizationText);
  if (
    !Number.isSafeInteger(cost) ||
    cost < 16_384 ||
    cost > 131_072 ||
    (cost & (cost - 1)) !== 0 ||
    !Number.isSafeInteger(blockSize) ||
    blockSize < 8 ||
    blockSize > 16 ||
    !Number.isSafeInteger(parallelization) ||
    parallelization < 1 ||
    parallelization > 4
  ) {
    return null;
  }

  const salt = Buffer.from(saltText, "base64url");
  const digest = Buffer.from(digestText, "base64url");
  if (salt.length < 16 || digest.length !== DERIVED_KEY_LENGTH) return null;
  return { cost, blockSize, parallelization, salt, digest };
}

function deriveKey(password: string, hash: ScryptHash) {
  return new Promise<Buffer>((resolve, reject) => {
    scrypt(
      password,
      hash.salt,
      DERIVED_KEY_LENGTH,
      {
        N: hash.cost,
        r: hash.blockSize,
        p: hash.parallelization,
        maxmem: 128 * hash.cost * hash.blockSize + 16 * 1024 * 1024,
      },
      (error, derivedKey) => {
        if (error) reject(error);
        else resolve(derivedKey);
      },
    );
  });
}

export function adminPrincipalId() {
  const principalId = process.env.APP_ADMIN_PRINCIPAL_ID?.trim() ?? "";
  if (!PRINCIPAL_ID_PATTERN.test(principalId)) {
    throw new Error("Invalid APP_ADMIN_PRINCIPAL_ID.");
  }
  return principalId;
}

export function adminDisplayName() {
  return (
    process.env.APP_ADMIN_DISPLAY_NAME?.trim().slice(0, 120) ||
    "Administrator"
  );
}

export function isAdminPasswordAuthConfigured() {
  try {
    return Boolean(
      parseHash(configuredHash()) &&
        adminPrincipalId() &&
        process.env.APP_SESSION_SECRET?.trim(),
    );
  } catch {
    return false;
  }
}

export async function verifyAdminPassword(input: string) {
  if (!input || input.length > MAX_PASSWORD_LENGTH) return false;
  const hash = parseHash(configuredHash());
  if (!hash) return false;
  const candidate = await deriveKey(input, hash);
  return timingSafeEqual(candidate, hash.digest);
}
