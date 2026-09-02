export type StableSolutionEvaluationSourceSnapshot<Documents, Analysis> = {
  documents: Documents;
  customerAnalysis: Analysis;
  sourceRevision: number;
};

export type StableProjectSourceSnapshot<Value> = {
  value: Value;
  sourceRevision: number;
};

const PROJECT_SOURCE_REVISION_CHANGED = "PROJECT_SOURCE_REVISION_CHANGED";

export function isProjectSourceRevisionChangedError(
  error: unknown,
): error is Error {
  return (
    error instanceof Error &&
    error.message.includes(PROJECT_SOURCE_REVISION_CHANGED)
  );
}

export async function runWithProjectSourceRevisionRetry<Value>(input: {
  run: (attempt: number) => Promise<Value>;
  onRetry?: (input: { attempt: number; error: Error }) => void | Promise<void>;
  maxAttempts?: number;
}) {
  const maxAttempts = Math.max(1, input.maxAttempts ?? 2);

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await input.run(attempt);
    } catch (error) {
      if (
        !isProjectSourceRevisionChangedError(error) ||
        attempt === maxAttempts
      ) {
        throw error;
      }
      await input.onRetry?.({ attempt, error });
    }
  }

  throw new Error("Klarte ikke å lese et stabilt prosjektgrunnlag.");
}

export async function readStableProjectSourceSnapshot<Value>(input: {
  readSourceRevision: () => Promise<number>;
  readValue: () => Promise<Value>;
  maxAttempts?: number;
}): Promise<StableProjectSourceSnapshot<Value>> {
  const maxAttempts = Math.max(1, input.maxAttempts ?? 3);

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const revisionBefore = await input.readSourceRevision();
    const value = await input.readValue();
    const revisionAfter = await input.readSourceRevision();

    if (revisionBefore === revisionAfter) {
      return { value, sourceRevision: revisionAfter };
    }
  }

  throw new Error(
    "Prosjektgrunnlaget ble endret under innlesing. Vent til dokumentbehandlingen er ferdig og prøv igjen.",
  );
}

export async function readStableSolutionEvaluationSourceSnapshot<
  Documents,
  Analysis,
>(input: {
  readSourceRevision: () => Promise<number>;
  readDocuments: () => Promise<Documents>;
  readCustomerAnalysis: () => Promise<Analysis>;
  maxAttempts?: number;
}): Promise<StableSolutionEvaluationSourceSnapshot<Documents, Analysis>> {
  const snapshot = await readStableProjectSourceSnapshot({
    readSourceRevision: input.readSourceRevision,
    readValue: () =>
      Promise.all([input.readDocuments(), input.readCustomerAnalysis()]),
    maxAttempts: input.maxAttempts,
  });
  return {
    documents: snapshot.value[0],
    customerAnalysis: snapshot.value[1],
    sourceRevision: snapshot.sourceRevision,
  };
}
