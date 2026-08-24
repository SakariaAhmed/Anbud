import "server-only";

import { defaultAzureBlobStorageBackend } from "@/lib/server/azure-blob-storage";

function safePathSegment(value: string) {
  return value
    .normalize("NFKD")
    .replace(/[^\w.\-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 140) || "document";
}

export function buildStoredFilePath(input: {
  scope: "projects" | "services";
  ownerId: string;
  fileId: string;
  fileName: string;
}) {
  return [
    input.scope,
    safePathSegment(input.ownerId),
    safePathSegment(input.fileId),
    safePathSegment(input.fileName),
  ].join("/");
}

export function buildStoredFilePrefix(input: {
  scope: "projects" | "services";
  ownerId: string;
  fileId?: string | null;
}) {
  return [
    input.scope,
    safePathSegment(input.ownerId),
    input.fileId ? safePathSegment(input.fileId) : null,
  ]
    .filter((segment): segment is string => Boolean(segment))
    .join("/");
}

export async function uploadEncryptedBase64File(input: {
  path: string;
  encryptedBase64: string;
}) {
  return defaultAzureBlobStorageBackend().uploadEncryptedBase64File(input);
}

export async function downloadEncryptedBase64File(input: {
  bucket?: string | null;
  path?: string | null;
}) {
  return defaultAzureBlobStorageBackend().downloadEncryptedBase64File(input);
}

export async function removeStoredFiles(
  files: Array<{ bucket?: string | null; path?: string | null }>,
) {
  return defaultAzureBlobStorageBackend().removeStoredFiles(files);
}

export async function listStoredFilesUnderPrefix(input: {
  bucket?: string | null;
  prefix: string;
}) {
  return defaultAzureBlobStorageBackend().listStoredFilesUnderPrefix(input);
}

export async function removeStoredFilePrefixes(
  prefixes: Array<{ bucket?: string | null; prefix: string }>,
) {
  const uniquePrefixes = [
    ...new Map(
      prefixes
        .filter((entry) => Boolean(entry.prefix))
        .map((entry) => [`${entry.bucket ?? ""}\0${entry.prefix}`, entry]),
    ).values(),
  ];

  for (const entry of uniquePrefixes) {
    const paths = await listStoredFilesUnderPrefix(entry);
    await removeStoredFiles(
      paths.map((path) => ({ bucket: entry.bucket, path })),
    );
    const remaining = await listStoredFilesUnderPrefix(entry);
    if (remaining.length) {
      throw new Error(
        `Dokumentlageret inneholder fortsatt ${remaining.length} fil(er) under ${
          entry.bucket || "anbud-documents"
        }/${entry.prefix}.`,
      );
    }
  }
}
