import { BidDocument, DocumentRole } from "@/lib/types";

export function roleLabel(role: DocumentRole) {
  return role === "bilag1" ? "Bilag 1" : "Bilag 2";
}

export function statusTone(status: string) {
  if (status === "Besvart") return "bg-emerald-100 text-emerald-900";
  if (status === "Delvis besvart") return "bg-amber-100 text-amber-900";
  return "bg-rose-100 text-rose-900";
}

export function latestDocument(documents: BidDocument[], role: DocumentRole) {
  return documents.find((document) => document.document_role === role) ?? null;
}

export function inferDocumentRole(fileName: string): DocumentRole | null {
  const value = fileName.toLowerCase();

  if (
    value.includes("bilag1") ||
    value.includes("bilag 1") ||
    value.includes("kravspes") ||
    value.includes("kravspesifikasjon") ||
    value.includes("requirement")
  ) {
    return "bilag1";
  }

  if (
    value.includes("bilag2") ||
    value.includes("bilag 2") ||
    value.includes("svar") ||
    value.includes("besvarelse") ||
    value.includes("response")
  ) {
    return "bilag2";
  }

  return null;
}

export function requirementSourceLabel() {
  return "Bilag 1";
}

export function compactExcerpt(value: string, maxLength = 140) {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "";
  }
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength).trim()}...`;
}
