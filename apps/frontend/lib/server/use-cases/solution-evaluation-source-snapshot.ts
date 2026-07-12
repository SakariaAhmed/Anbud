export type StableSolutionEvaluationSourceSnapshot<Documents, Analysis> = {
  documents: Documents;
  customerAnalysis: Analysis;
  sourceRevision: number;
};

export type StableProjectSourceSnapshot<Value> = {
  value: Value;
  sourceRevision: number;
};

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
