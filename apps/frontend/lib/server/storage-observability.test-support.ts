let activeClient: unknown = null;
let activeStorageBackend: unknown = null;

export function setStorageObservabilityTestClient(client: unknown) {
  activeClient = client;
}

export function createServiceClient() {
  if (!activeClient) {
    throw new Error("Storage/observability test client is not configured.");
  }
  return activeClient;
}

export function setAzureBlobStorageTestBackend(backend: unknown) {
  activeStorageBackend = backend;
}

export function defaultAzureBlobStorageBackend() {
  if (!activeStorageBackend) {
    throw new Error("Azure Blob Storage test backend is not configured.");
  }
  return activeStorageBackend;
}
