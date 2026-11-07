import "server-only";

const MAX_ARTIFACT_INSTRUCTIONS_CHARS = 4000;
const MAX_SOURCE_DOCUMENT_ID_CHARS = 200;

/** Azure's APP_VERSION is the promoted immutable image reference. */
export function artifactGeneratorRevision(environment: Record<string, string | undefined> = process.env) {
  return environment.ARTIFACT_GENERATOR_REVISION?.trim() ||
    environment.VERCEL_GIT_COMMIT_SHA?.trim() ||
    environment.GIT_COMMIT_SHA?.trim() ||
    environment.APP_VERSION?.trim() ||
    "artifact-source-fence-v1";
}

export function normalizeArtifactInstructions(value: unknown) {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, MAX_ARTIFACT_INSTRUCTIONS_CHARS) : undefined;
}

export function normalizeSourceDocumentIds(value: unknown) {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error("source_document_ids må være en liste med dokument-ID-er.");
  }

  const seen = new Set<string>();
  const ids: string[] = [];
  for (const candidate of value) {
    if (typeof candidate !== "string") {
      throw new Error("source_document_ids inneholder en ugyldig dokument-ID.");
    }

    const id = candidate.trim();
    if (!id || id.length > MAX_SOURCE_DOCUMENT_ID_CHARS) {
      throw new Error("source_document_ids inneholder en tom eller for lang dokument-ID.");
    }
    if (seen.has(id)) {
      throw new Error(`source_document_ids inneholder duplikatet ${id}.`);
    }

    seen.add(id);
    ids.push(id);
  }

  return ids;
}
