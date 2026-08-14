import "server-only";

import {
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

import { encryptString } from "@/lib/server/crypto";

const GUEST_CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const GUEST_CODE_GROUPS = 6;
const GUEST_CODE_GROUP_LENGTH = 5;

function hmacSecret(purpose: "email" | "guest-code" | "request-context") {
  const dedicated =
    purpose === "guest-code"
      ? process.env.APP_GUEST_CODE_PEPPER?.trim()
      : purpose === "email"
        ? process.env.APP_IDENTITY_LOOKUP_SECRET?.trim()
        : process.env.APP_ACTIVITY_HASH_SECRET?.trim();
  const fallback = process.env.APP_SESSION_SECRET?.trim();
  const secret = dedicated || fallback;
  if (!secret) {
    throw new Error(`Missing HMAC secret for ${purpose}.`);
  }
  return secret;
}

function hmac(value: string, purpose: "email" | "guest-code" | "request-context") {
  return createHmac("sha256", hmacSecret(purpose))
    .update(value)
    .digest("hex");
}

export function normalizeEmail(value: string) {
  return value.trim().normalize("NFKC").toLocaleLowerCase("en-US");
}

export function validateEmail(value: string) {
  const normalized = normalizeEmail(value);
  if (
    normalized.length < 3 ||
    normalized.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(normalized)
  ) {
    throw new Error("Ugyldig e-postadresse.");
  }
  return normalized;
}

export function emailHmac(email: string) {
  return hmac(validateEmail(email), "email");
}

export function encryptEmail(email: string) {
  return encryptString(validateEmail(email));
}

export function maskEmail(email: string) {
  const normalized = validateEmail(email);
  const [localPart, domain] = normalized.split("@");
  const visibleLocal =
    localPart.length <= 2
      ? `${localPart[0] ?? "*"}*`
      : `${localPart.slice(0, 2)}${"*".repeat(Math.min(5, localPart.length - 2))}`;
  return `${visibleLocal}@${domain}`;
}

function randomGuestCodeCharacters(length: number): string {
  const bytes = randomBytes(length * 2);
  let result = "";
  let cursor = 0;
  while (result.length < length) {
    const value = bytes[cursor];
    cursor += 1;
    if (value === undefined) {
      return `${result}${randomGuestCodeCharacters(length - result.length)}`;
    }
    const acceptedCeiling =
      Math.floor(256 / GUEST_CODE_ALPHABET.length) *
      GUEST_CODE_ALPHABET.length;
    if (value >= acceptedCeiling) continue;
    result += GUEST_CODE_ALPHABET[value % GUEST_CODE_ALPHABET.length];
  }
  return result;
}

export function normalizeGuestCode(value: string) {
  return value
    .trim()
    .toUpperCase()
    .replace(/^GST[_\s-]*/u, "")
    .replace(/[^A-Z2-9]/gu, "");
}

export function generateGuestCode() {
  const raw = randomGuestCodeCharacters(
    GUEST_CODE_GROUPS * GUEST_CODE_GROUP_LENGTH,
  );
  const groups = Array.from({ length: GUEST_CODE_GROUPS }, (_, index) =>
    raw.slice(
      index * GUEST_CODE_GROUP_LENGTH,
      (index + 1) * GUEST_CODE_GROUP_LENGTH,
    ),
  );
  return `gst_${groups.join("-")}`;
}

export function guestCodeHmac(code: string) {
  const normalized = normalizeGuestCode(code);
  if (
    normalized.length !==
    GUEST_CODE_GROUPS * GUEST_CODE_GROUP_LENGTH
  ) {
    return hmac(`invalid:${normalized}`, "guest-code");
  }
  return hmac(normalized, "guest-code");
}

export function guestCodeLastFour(code: string) {
  return normalizeGuestCode(code).slice(-4);
}

export function safeHmacEqual(left: string, right: string) {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return (
    leftBytes.length === rightBytes.length &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}

export function requestContextHmac(value: string) {
  return value ? hmac(value, "request-context") : null;
}
