export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * An object whose fields have not been validated yet, such as parsed model
 * output. Every field must be narrowed before it is used as `T`.
 */
export type Untrusted<T> = { [K in keyof T]?: unknown };

/** Object elements of an untrusted array; other elements become empty rows. */
export function untrustedRows<T>(value: unknown): Untrusted<T>[] {
  return Array.isArray(value)
    ? value.map((row): Untrusted<T> => (isRecord(row) ? row : {}))
    : [];
}

export function untrustedObject<T>(value: unknown): Untrusted<T> {
  return isRecord(value) ? value : {};
}

export function stringOr(value: unknown, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

export function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

/** Copies the listed fields that hold strings; other values are dropped. */
export function stringFields<K extends string>(
  row: Partial<Record<K, unknown>>,
  keys: readonly K[],
): Partial<Record<K, string>> {
  const fields: Partial<Record<K, string>> = {};
  for (const key of keys) {
    const value = row[key];
    if (typeof value === "string") fields[key] = value;
  }
  return fields;
}
