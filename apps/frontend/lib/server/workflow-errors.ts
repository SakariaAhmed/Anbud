// Only fixed domain messages may cross the production error boundary.
const ERRORS: Record<string, { status: number; message: string }> = {
  CUSTOMER_ANALYSIS_CHANGED: { status: 409, message: "Analysen er endret siden du åpnet den. Utkastet ditt er beholdt. Last inn siste analyse før du lagrer igjen." },
  CUSTOMER_ANALYSIS_REVISION_REQUIRED: { status: 409, message: "Last inn siste analyse før du lagrer. Utkastet ditt er beholdt." },
  PROJECT_SOURCE_REVISION_CHANGED: { status: 409, message: "Prosjektgrunnlaget ble endret under generering. Vent til dokumentbehandlingen er ferdig, og start på nytt. Tidligere analyser er bevart i historikken." },
  ARTIFACT_SOURCE_REVISION_CHANGED: { status: 409, message: "Prosjektgrunnlaget ble endret. Last inn prosjektet på nytt før du genererer." },
  SERVICE_LIBRARY_REVISION_CHANGED: { status: 409, message: "Tjenestebiblioteket ble endret under generering. Start på nytt med siste grunnlag." },
  PROJECT_WORKFLOW_BUSY: { status: 409, message: "Prosjektet har en jobb som fortsatt pågår. Vent til den er ferdig før du starter en ny generering." },
  DOCUMENT_INDEX_NOT_READY: { status: 409, message: "Dokumentbehandlingen er ikke ferdig. Vent til dokumentene er klare før du genererer." },
  CUSTOMER_ANALYSIS_REQUIRED: { status: 422, message: "Generer kundeanalyse før løsningsvurdering." },
  SOLUTION_EVALUATION_REQUIRED: { status: 422, message: "Generer vurdering før lederoppsummering eller forbedring av systemløsningen." },
  PROJECT_JOB_SUPERSEDED: { status: 409, message: "En nyere jobb har overtatt. Last inn prosjektet for å se siste resultat." },
};
const LEGACY: Record<string, string> = {
  "Generer kundeanalyse før løsningsvurdering.": "CUSTOMER_ANALYSIS_REQUIRED",
  "Generer vurdering før lederoppsummering.": "SOLUTION_EVALUATION_REQUIRED",
  "Generer vurdering før du forbedrer systemløsningen.": "SOLUTION_EVALUATION_REQUIRED",
};
export function workflowError(error: unknown) {
  const text = error instanceof Error ? error.message : "";
  const code = LEGACY[text] ?? Object.keys(ERRORS).find(key =>
    new RegExp(`(?:^|\\b)${key}(?=$|[:\\s])`, "u").test(text));
  return code ? { code, ...ERRORS[code] } : null;
}
export function workflowErrorStatus(error: unknown) {
  return workflowError(error)?.status ?? 500;
}
