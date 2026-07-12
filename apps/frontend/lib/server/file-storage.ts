import "server-only";

import { createServiceClient } from "@/lib/server/supabase";

const DOCUMENT_FILE_BUCKET = "anbud-documents";
const STORAGE_DELETE_BATCH_SIZE = 1_000;
const STORAGE_LIST_PAGE_SIZE = 1_000;

let bucketReadyPromise: Promise<void> | null = null;

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

async function ensureBucket() {
  if (!bucketReadyPromise) {
    bucketReadyPromise = (async () => {
      const supabase = createServiceClient();
      const existing = await supabase.storage.getBucket(DOCUMENT_FILE_BUCKET);
      if (!existing.error) {
        return;
      }

      const created = await supabase.storage.createBucket(DOCUMENT_FILE_BUCKET, {
        public: false,
        fileSizeLimit: "40MB",
      });

      if (
        created.error &&
        !/already exists|duplicate/i.test(created.error.message)
      ) {
        throw new Error(
          created.error.message || "Kunne ikke opprette dokumentlager.",
        );
      }
    })();
  }

  return bucketReadyPromise;
}

export async function uploadEncryptedBase64File(input: {
  path: string;
  encryptedBase64: string;
}) {
  await ensureBucket();
  const supabase = createServiceClient();
  const { error } = await supabase.storage
    .from(DOCUMENT_FILE_BUCKET)
    .upload(input.path, Buffer.from(input.encryptedBase64, "utf8"), {
      contentType: "application/octet-stream",
      cacheControl: "31536000",
      upsert: true,
    });

  if (error) {
    throw new Error(error.message || "Kunne ikke lagre dokumentfil.");
  }

  return {
    bucket: DOCUMENT_FILE_BUCKET,
    path: input.path,
  };
}

export async function downloadEncryptedBase64File(input: {
  bucket?: string | null;
  path?: string | null;
}) {
  if (!input.path) {
    return "";
  }

  const supabase = createServiceClient();
  const { data, error } = await supabase.storage
    .from(input.bucket || DOCUMENT_FILE_BUCKET)
    .download(input.path);

  if (error || !data) {
    throw new Error(error?.message || "Kunne ikke hente dokumentfil.");
  }

  return Buffer.from(await data.arrayBuffer()).toString("utf8");
}

export async function removeStoredFiles(
  files: Array<{ bucket?: string | null; path?: string | null }>,
) {
  const pathsByBucket = new Map<string, Set<string>>();
  for (const file of files) {
    if (!file.path) {
      continue;
    }
    const bucket = file.bucket || DOCUMENT_FILE_BUCKET;
    const paths = pathsByBucket.get(bucket) ?? new Set<string>();
    paths.add(file.path);
    pathsByBucket.set(bucket, paths);
  }

  for (const [bucket, pathSet] of pathsByBucket) {
    const paths = [...pathSet];
    const supabase = createServiceClient();
    for (
      let offset = 0;
      offset < paths.length;
      offset += STORAGE_DELETE_BATCH_SIZE
    ) {
      const batch = paths.slice(offset, offset + STORAGE_DELETE_BATCH_SIZE);
      const { error } = await supabase.storage.from(bucket).remove(batch);
      if (error) {
        throw new Error(
          error.message || `Kunne ikke slette dokumentfiler fra ${bucket}.`,
        );
      }
    }
  }
}

function isMissingBucketError(error: {
  message?: string;
  statusCode?: string | number;
}) {
  return (
    String(error.statusCode ?? "") === "404" &&
    /bucket[^\n]*not found|not found[^\n]*bucket/iu.test(error.message ?? "")
  );
}

export async function listStoredFilesUnderPrefix(input: {
  bucket?: string | null;
  prefix: string;
}) {
  const bucket = input.bucket || DOCUMENT_FILE_BUCKET;
  const normalizedPrefix = input.prefix.replace(/^\/+|\/+$/gu, "").trim();
  if (!normalizedPrefix) {
    throw new Error("Lagringssletting krever et ikke-tomt prefiks.");
  }

  const pendingPrefixes = [normalizedPrefix];
  const visitedPrefixes = new Set<string>();
  const paths: string[] = [];
  const supabase = createServiceClient();
  while (pendingPrefixes.length) {
    const currentPrefix = pendingPrefixes.shift();
    if (!currentPrefix || visitedPrefixes.has(currentPrefix)) continue;
    visitedPrefixes.add(currentPrefix);

    for (let offset = 0; ; offset += STORAGE_LIST_PAGE_SIZE) {
      const { data, error } = await supabase.storage
        .from(bucket)
        .list(currentPrefix, {
          limit: STORAGE_LIST_PAGE_SIZE,
          offset,
          sortBy: { column: "name", order: "asc" },
        });
      if (error) {
        if (isMissingBucketError(error)) return [];
        throw new Error(
          error.message ||
            `Kunne ikke lese dokumentfiler under ${bucket}/${currentPrefix}.`,
        );
      }

      const page = data ?? [];
      for (const entry of page) {
        const name = String(entry?.name ?? "");
        if (!name || name === "." || name === ".." || name.includes("/")) {
          throw new Error(
            `Dokumentlageret returnerte et ugyldig navn under ${bucket}/${currentPrefix}.`,
          );
        }
        const childPath = `${currentPrefix}/${name}`;
        if (entry.id == null && entry.metadata == null) {
          pendingPrefixes.push(childPath);
        } else {
          paths.push(childPath);
        }
      }

      if (page.length < STORAGE_LIST_PAGE_SIZE) break;
    }
  }

  return [...new Set(paths)].sort();
}

export async function removeStoredFilePrefixes(
  prefixes: Array<{ bucket?: string | null; prefix: string }>,
) {
  const uniquePrefixes = [
    ...new Map(
      prefixes
        .filter((entry) => Boolean(entry.prefix))
        .map((entry) => [
          `${entry.bucket || DOCUMENT_FILE_BUCKET}\0${entry.prefix}`,
          entry,
        ]),
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
          entry.bucket || DOCUMENT_FILE_BUCKET
        }/${entry.prefix}.`,
      );
    }
  }
}
