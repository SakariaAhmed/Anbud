import "server-only";

export type SupabaseErrorLike = { message?: string } | null;

export function isMissingSchemaColumn(error: SupabaseErrorLike) {
  const message = (error?.message ?? "").toLowerCase();
  if (!message) {
    return false;
  }
  if (
    message.includes("violates") ||
    message.includes("not-null") ||
    message.includes("not null")
  ) {
    return false;
  }

  return (
    message.includes("schema cache") ||
    message.includes("does not exist") ||
    message.includes("could not find") ||
    message.includes("column ")
  );
}

export function isMissingRelationColumn(
  error: SupabaseErrorLike,
  relation: string,
) {
  const message = (error?.message ?? "").toLowerCase();
  if (!message) {
    return false;
  }

  return (
    message.includes(`column ${relation}.`) ||
    message.includes(`of '${relation}'`) ||
    (message.includes(relation) && message.includes("schema cache")) ||
    (message.includes(relation) && message.includes("does not exist"))
  );
}

export function missingColumnNameFromError<const TColumn extends string>(
  error: SupabaseErrorLike,
  columns: readonly TColumn[],
): TColumn | null {
  if (!isMissingSchemaColumn(error)) {
    return null;
  }

  const message = (error?.message ?? "").toLowerCase();
  return (
    columns.find((column) => {
      const normalized = column.toLowerCase();
      return (
        message.includes(`'${normalized}' column`) ||
        message.includes(`"${normalized}" column`) ||
        message.includes(`column '${normalized}'`) ||
        message.includes(`column "${normalized}"`) ||
        message.includes(`column ${normalized}`) ||
        message.includes(`.${normalized}`)
      );
    }) ?? null
  );
}

export function removeMissingStorageColumns(payload: Record<string, unknown>) {
  delete payload.file_storage_bucket;
  delete payload.file_storage_path;
}
