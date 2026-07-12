let activeClient: unknown = null;

export function setStorageObservabilityTestClient(client: unknown) {
  activeClient = client;
}

export function createServiceClient() {
  if (!activeClient) {
    throw new Error("Storage/observability test client is not configured.");
  }
  return activeClient;
}
