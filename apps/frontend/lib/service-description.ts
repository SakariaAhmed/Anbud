import type { ProjectDocument, ProjectDocumentDetail } from "@/lib/types";

export const SERVICE_DESCRIPTION_TITLE = "Tjenestebeskrivelse";

export function isServiceDescriptionDocument(
  document: Pick<ProjectDocument, "title" | "file_name">,
) {
  const text = `${document.title} ${document.file_name}`.toLowerCase();
  return (
    text.includes("tjenestebeskrivelse") ||
    text.includes("tjeneste beskrivelse") ||
    text.includes("service description")
  );
}

export function splitServiceDescriptionDocuments<T extends ProjectDocument>(
  documents: T[],
) {
  const serviceDocuments = documents.filter(isServiceDescriptionDocument);
  const projectDocuments = documents.filter(
    (document) => !isServiceDescriptionDocument(document),
  );

  return {
    serviceDescriptionDocument: serviceDocuments[0] ?? null,
    serviceDescriptionDocuments: serviceDocuments,
    projectDocuments,
  };
}

export function splitServiceDescriptionDetails<
  T extends ProjectDocumentDetail,
>(documents: T[]) {
  const serviceDocuments = documents.filter(isServiceDescriptionDocument);
  const projectDocuments = documents.filter(
    (document) => !isServiceDescriptionDocument(document),
  );

  return {
    serviceDescriptionDocument: serviceDocuments[0] ?? null,
    serviceDescriptionDocuments: serviceDocuments,
    projectDocuments,
  };
}
