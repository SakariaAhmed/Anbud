import "server-only";

const MAX_ARTIFACT_INSTRUCTIONS_CHARS = 4000;
const MAX_ARTIFACT_SOURCE_DOCUMENT_IDS = 12;
const MAX_SOURCE_DOCUMENT_ID_CHARS = 200;

export function normalizeArtifactInstructions(value: unknown) {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, MAX_ARTIFACT_INSTRUCTIONS_CHARS) : undefined;
}

export function normalizeSourceDocumentIds(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }

  const seen = new Set<string>();
  const ids: string[] = [];
  for (const candidate of value) {
    if (typeof candidate !== "string") {
      continue;
    }

    const id = candidate.trim().slice(0, MAX_SOURCE_DOCUMENT_ID_CHARS);
    if (!id || seen.has(id)) {
      continue;
    }

    seen.add(id);
    ids.push(id);
    if (ids.length >= MAX_ARTIFACT_SOURCE_DOCUMENT_IDS) {
      break;
    }
  }

  return ids;
}
