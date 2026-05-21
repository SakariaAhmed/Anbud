import "server-only";

import { createServiceClient } from "@/lib/server/supabase";

export const DOCUMENT_FILE_BUCKET = "anbud-documents";

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
  const pathsByBucket = new Map<string, string[]>();
  for (const file of files) {
    if (!file.path) {
      continue;
    }
    const bucket = file.bucket || DOCUMENT_FILE_BUCKET;
    const paths = pathsByBucket.get(bucket) ?? [];
    paths.push(file.path);
    pathsByBucket.set(bucket, paths);
  }

  await Promise.all(
    [...pathsByBucket.entries()].map(async ([bucket, paths]) => {
      const supabase = createServiceClient();
      await supabase.storage.from(bucket).remove(paths);
    }),
  );
}
