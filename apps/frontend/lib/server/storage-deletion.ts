import "server-only";

export type StoredFileReference = {
  file_storage_bucket?: string | null;
  file_storage_path?: string | null;
};

const STORAGE_REFERENCE_PAGE_SIZE = 1_000;

export async function fetchStoredFileReferencesPaginated(
  fetchPage: (
    from: number,
    to: number,
  ) => PromiseLike<{
    data: unknown[] | null;
    error: { message?: string } | null;
  }>,
  pageSize = STORAGE_REFERENCE_PAGE_SIZE,
): Promise<StoredFileReference[]> {
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 1_000) {
    throw new Error("Storage reference page size must be from 1 to 1000.");
  }

  const files: StoredFileReference[] = [];
  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await fetchPage(offset, offset + pageSize - 1);
    if (error) {
      throw new Error(
        error.message || "Kunne ikke lese dokumentenes lagringsreferanser.",
      );
    }

    const page = (data ?? []) as StoredFileReference[];
    files.push(...page);
    if (page.length < pageSize) {
      return files;
    }
  }
}

export async function runStorageFirstDeletion<T>(input: {
  removeStorage: () => Promise<void>;
  deleteDatabaseRows: () => Promise<T>;
}): Promise<T> {
  await input.removeStorage();
  return input.deleteDatabaseRows();
}
