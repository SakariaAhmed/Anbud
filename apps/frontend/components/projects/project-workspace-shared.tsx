import type { ReactNode } from "react";

import type {
  GeneratedArtifactType,
  ProjectDetail,
  ProjectDocumentRole,
  ProjectStatus,
  SupportingDocumentSubtype,
  ValueCategory,
} from "@/lib/types";
import { MarkdownViewer } from "@/components/projects/markdown-viewer";

export const VALUE_LABELS: ValueCategory[] = [
  "Høyere produktivitet",
  "Lavere kostnader",
  "Redusert risiko",
  "Bedre brukeropplevelse",
  "Fokus på kjernevirksomheten",
];

export const ARTIFACT_TYPES: Array<{
  value: GeneratedArtifactType;
  label: string;
}> = [
  { value: "losningsutkast", label: "Losningsutkast" },
  { value: "forbedret_kravsvar", label: "Forbedret kravsvar" },
  { value: "tilbudsstrategi", label: "Tilbudsstrategi" },
  { value: "verdiargumentasjon", label: "Verdiargumentasjon" },
  { value: "anbefalt_arkitektur", label: "Anbefalt arkitektur" },
  { value: "gjennomforing_og_risiko", label: "Gjennomforing og risiko" },
];

export const SUPPORTING_SUBTYPES: Array<{
  value: SupportingDocumentSubtype;
  label: string;
}> = [
  { value: "rfp", label: "RFP" },
  { value: "kravdokument", label: "Kravdokument" },
  { value: "prosjektbeskrivelse", label: "Prosjektbeskrivelse" },
  { value: "notat", label: "Notat" },
  { value: "motenotat", label: "Motenotat" },
  { value: "workshop", label: "Workshop" },
  { value: "vedlegg", label: "Vedlegg" },
  { value: "strategi", label: "Strategi" },
  { value: "utkast", label: "Utkast" },
  { value: "annet", label: "Annet" },
];

export function roleLabel(role: ProjectDocumentRole) {
  switch (role) {
    case "primary_customer_document":
      return "Primert kundedokument";
    case "primary_solution_document":
      return "Primert losningsdokument";
    default:
      return "Stottedokument";
  }
}

export function supportingSubtypeLabel(
  subtype: SupportingDocumentSubtype | null,
) {
  const match = SUPPORTING_SUBTYPES.find((item) => item.value === subtype);
  return match?.label ?? "Stottedokument";
}

export function formatDate(value: string) {
  return new Intl.DateTimeFormat("nb-NO", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

export function deriveProjectStatus(
  project: Pick<
    ProjectDetail,
    | "customer_document_uploaded"
    | "customer_analysis_generated"
    | "solution_document_uploaded"
    | "solution_evaluation_generated"
  >,
): ProjectStatus {
  if (project.solution_evaluation_generated) {
    return "Klar for sparring";
  }
  if (project.solution_document_uploaded) {
    return "Løsningsdokument lastet opp";
  }
  if (project.customer_analysis_generated) {
    return "Kundeanalyse klar";
  }
  if (project.customer_document_uploaded) {
    return "Kundedokument lastet opp";
  }
  return "Venter på dokument";
}

export function ValueTags({ values }: { values: ValueCategory[] }) {
  if (!values.length) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {values.map((value) => (
        <span
          key={value}
          className="text-xs text-emerald-700 dark:text-emerald-400"
        >
          {value}
        </span>
      ))}
    </div>
  );
}

export function SectionList({
  title,
  items,
}: {
  title: string;
  items: string[];
}) {
  if (!items.length) return null;

  return (
    <div>
      <h3 className="mb-3 text-sm font-medium text-foreground">{title}</h3>
      <ul className="space-y-2">
        {items.map((item, index) => (
          <li key={`${title}-${index}`} className="border-l-2 border-border pl-3">
            <MarkdownViewer content={item} className="text-sm text-muted-foreground" />
          </li>
        ))}
      </ul>
    </div>
  );
}

export function AnalysisTabEmptyState({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <div className="py-12 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}
