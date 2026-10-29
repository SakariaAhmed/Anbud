import { createHash } from "node:crypto";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
function orderedKeys(value) {
  if (Array.isArray(value)) return value.map(orderedKeys);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, orderedKeys(value[key])]));
  return value;
}

export function responseFingerprint(body, contentType = "") {
  return { sha256: sha(body), ...(contentType.includes("application/json") ? { jsonSha256: sha(JSON.stringify(orderedKeys(JSON.parse(body.toString())))) } : {}) };
}
