import "server-only";

import { DefaultAzureCredential } from "@azure/identity";
import {
  BlobServiceClient,
  type ContainerClient,
} from "@azure/storage-blob";

const DEFAULT_CONTAINER = "anbud-documents";
const MAX_FILE_BYTES = 40 * 1024 * 1024;

type ContainerClientFactory = (containerName: string) => ContainerClient;

function normalizedPath(path: string) {
  if (!path || path.startsWith("/") || path.includes("\0")) {
    throw new Error("Azure Blob Storage krever en ikke-tom, relativ objektsti.");
  }
  return path;
}

function normalizedPrefix(prefix: string) {
  const normalized = prefix.replace(/^\/+|\/+$/gu, "").trim();
  if (!normalized) {
    throw new Error("Lagringssletting krever et ikke-tomt prefiks.");
  }
  return `${normalized}/`;
}

function statusCode(error: unknown) {
  return Number((error as { statusCode?: unknown })?.statusCode ?? 0);
}

export function createAzureBlobStorageBackend(input: {
  containerName?: string;
  getContainerClient: ContainerClientFactory;
}) {
  const containerName = input.containerName?.trim() || DEFAULT_CONTAINER;

  function containerFor(bucket?: string | null) {
    const requested = bucket?.trim() || containerName;
    if (requested !== containerName) {
      throw new Error(
        `Azure Blob Storage-bøtten ${requested} er ikke tillatt; forventet ${containerName}.`,
      );
    }
    return input.getContainerClient(containerName);
  }

  return {
    async probeAccess(signal?: AbortSignal) {
      await containerFor().getProperties({ abortSignal: signal });
    },

    async uploadEncryptedBase64File(upload: {
      path: string;
      encryptedBase64: string;
    }) {
      const body = Buffer.from(upload.encryptedBase64, "utf8");
      if (body.byteLength > MAX_FILE_BYTES) {
        throw new Error("Dokumentfilen overskrider lagringsgrensen på 40 MiB.");
      }
      await containerFor()
        .getBlockBlobClient(normalizedPath(upload.path))
        .uploadData(body, {
          blobHTTPHeaders: {
            blobCacheControl: "max-age=31536000",
            blobContentType: "application/octet-stream",
          },
        });
      return { bucket: containerName, path: upload.path };
    },

    async downloadEncryptedBase64File(download: {
      bucket?: string | null;
      path?: string | null;
    }) {
      if (!download.path) return "";
      const body = await containerFor(download.bucket)
        .getBlockBlobClient(normalizedPath(download.path))
        .downloadToBuffer();
      return body.toString("utf8");
    },

    async removeStoredFiles(
      files: Array<{ bucket?: string | null; path?: string | null }>,
    ) {
      const unique = new Map<string, { bucket: string; path: string }>();
      for (const file of files) {
        if (!file.path) continue;
        const bucket = file.bucket?.trim() || containerName;
        containerFor(bucket);
        unique.set(`${bucket}\0${file.path}`, {
          bucket,
          path: normalizedPath(file.path),
        });
      }
      for (const file of unique.values()) {
        await containerFor(file.bucket)
          .getBlockBlobClient(file.path)
          .deleteIfExists({ deleteSnapshots: "include" });
      }
    },

    async listStoredFilesUnderPrefix(list: {
      bucket?: string | null;
      prefix: string;
    }) {
      const container = containerFor(list.bucket);
      const prefix = normalizedPrefix(list.prefix);
      const paths: string[] = [];
      try {
        for await (const blob of container.listBlobsFlat({ prefix })) {
          if (!blob.name.startsWith(prefix)) {
            throw new Error("Azure Blob Storage returnerte et objekt utenfor prefikset.");
          }
          paths.push(blob.name);
        }
      } catch (error) {
        if (statusCode(error) === 404) return [];
        throw error;
      }
      return [...new Set(paths)].sort();
    },
  };
}

let defaultBackend: ReturnType<typeof createAzureBlobStorageBackend> | null = null;

export function defaultAzureBlobStorageBackend() {
  if (defaultBackend) return defaultBackend;
  const accountUrl = process.env.AZURE_STORAGE_ACCOUNT_URL?.trim();
  if (!accountUrl || !/^https:\/\/[a-z0-9-]+\.blob\.core\.windows\.net\/?$/u.test(accountUrl)) {
    throw new Error(
      "AZURE_STORAGE_ACCOUNT_URL må være en HTTPS-adresse for Azure Blob Storage.",
    );
  }
  const service = new BlobServiceClient(accountUrl.replace(/\/+$/u, ""), new DefaultAzureCredential());
  defaultBackend = createAzureBlobStorageBackend({
    containerName: process.env.AZURE_STORAGE_CONTAINER,
    getContainerClient: (containerName) => service.getContainerClient(containerName),
  });
  return defaultBackend;
}
