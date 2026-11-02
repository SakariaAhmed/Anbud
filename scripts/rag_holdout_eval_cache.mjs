// Framework adapter for invoking the REAL repository in a standalone process.
// No application/HTTP cache is read here; every verification uses fresh reads.
// Models, storage, crypto, SQL and persistence are never substituted.
export const unstable_cache = callback => callback;
export function revalidatePath() {}
export function revalidateTag() {}
