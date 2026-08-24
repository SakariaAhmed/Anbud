export const PROJECT_PAGE_LABELS = {
  documents: "Dokumenter",
  analysis: "Kundeanalyse",
  bilag1: "Bilag 1-utkast",
  "service-description": "Tjenestebeskrivelse",
  requirements: "Krav og svar",
  generator: "Tilbudsgenerator",
  evaluation: "Løsningsevaluering",
  delivery: "Gjennomføring og risiko",
  "executive-summary": "Lederoppsummering",
  chat: "Prosjektchat",
} as const;

export type ProjectPageKey = keyof typeof PROJECT_PAGE_LABELS;

export function isProjectPageKey(value: unknown): value is ProjectPageKey {
  return typeof value === "string" && value in PROJECT_PAGE_LABELS;
}
