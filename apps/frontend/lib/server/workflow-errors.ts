// Only fixed domain messages may cross the production error boundary.
const ERRORS = {
  AI_OUTPUT_CORRUPT: { status: 502, message: "Den genererte teksten var skadet og ble ikke lagret. Prøv å generere på nytt." },
  INVALID_PDF_DOCUMENT: { status: 400, message: "PDF-filen er ugyldig eller skadet. Åpne filen i en PDF-leser og lagre en ny kopi før du laster opp igjen." },
  PASSWORD_PROTECTED_PDF: { status: 400, message: "PDF-filen er passordbeskyttet. Last opp en ulåst kopi." },
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
} satisfies Record<string, { status: number; message: string }>;
export type WorkflowErrorCode = keyof typeof ERRORS;

/** A domain failure with a fixed user message and HTTP status. */
export class WorkflowError extends Error {
  readonly code: WorkflowErrorCode;

  constructor(code: WorkflowErrorCode, detail?: string, options?: ErrorOptions) {
    super(detail ? `${code}: ${detail}` : code, options);
    this.name = "WorkflowError";
    this.code = code;
  }
}

/** A precondition the user can fix; its message is written for them. */
export class WorkflowPreconditionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowPreconditionError";
  }
}

/**
 * A workflow that stopped for a reason the user must see, such as AI batches
 * that could not be completed. Only `publicMessage` crosses the production
 * boundary; it is built from counts and requirement references, never from
 * raw backend or model output. `detail` stays in the error message for logs.
 */
export class WorkflowIncompleteError extends Error {
  readonly publicMessage: string;

  constructor(publicMessage: string, detail?: string) {
    super(detail ?? publicMessage);
    this.name = "WorkflowIncompleteError";
    this.publicMessage = publicMessage;
  }
}

// PostgreSQL functions raise these codes as message text, so database
// failures are recognised by the code prefix rather than by class.
function codeFromMessage(message: string) {
  return (Object.keys(ERRORS) as WorkflowErrorCode[]).find((key) =>
    new RegExp(`(?:^|\\b)${key}(?=$|[:\\s])`, "u").test(message));
}

export function workflowError(error: unknown) {
  // Wrapping an error with `{ cause }` must not hide its domain code.
  let current = error;
  for (let depth = 0; current instanceof Error && depth < 5; depth += 1) {
    if (current instanceof WorkflowPreconditionError) {
      return { code: "WORKFLOW_PRECONDITION", status: 422, message: current.message };
    }
    if (current instanceof WorkflowIncompleteError) {
      return { code: "WORKFLOW_INCOMPLETE", status: 502, message: current.publicMessage };
    }
    const code =
      current instanceof WorkflowError ? current.code : codeFromMessage(current.message);
    if (code) return { code, ...ERRORS[code] };
    current = current.cause;
  }
  return null;
}
export function workflowErrorStatus(error: unknown) {
  return workflowError(error)?.status ?? 500;
}
