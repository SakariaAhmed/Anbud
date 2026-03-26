import type { ReactNode } from "react";

import type {
  CustomerAnalysisResult,
  GeneratedArtifactType,
  ProjectDetail,
  ProjectDocumentRole,
  ProjectStatus,
  SupportingDocumentSubtype,
  ValueCategory,
} from "@/lib/types";
import {
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/projects/primitives";
import { MarkdownViewer } from "@/components/projects/markdown-viewer";

export const VALUE_LABELS: ValueCategory[] = [
  "Høyere produktivitet",
  "Lavere kostnader",
  "Redusert risiko",
  "Bedre brukeropplevelse",
  "Fokus på kjernevirksomheten",
];

export const ARTIFACT_TYPES: Array<{ value: GeneratedArtifactType; label: string }> = [
  { value: "losningsutkast", label: "Løsningsutkast" },
  { value: "forbedret_kravsvar", label: "Forbedret kravsvar" },
  { value: "tilbudsstrategi", label: "Tilbudsstrategi" },
  { value: "verdiargumentasjon", label: "Verdiargumentasjon" },
  { value: "anbefalt_arkitektur", label: "Anbefalt arkitektur" },
  { value: "gjennomforing_og_risiko", label: "Gjennomføring og risiko" },
];

export const SUPPORTING_SUBTYPES: Array<{ value: SupportingDocumentSubtype; label: string }> = [
  { value: "rfp", label: "RFP" },
  { value: "kravdokument", label: "Kravdokument" },
  { value: "prosjektbeskrivelse", label: "Prosjektbeskrivelse" },
  { value: "notat", label: "Notat" },
  { value: "motenotat", label: "Møtenotat" },
  { value: "workshop", label: "Workshop" },
  { value: "vedlegg", label: "Vedlegg" },
  { value: "strategi", label: "Strategi" },
  { value: "utkast", label: "Utkast" },
  { value: "annet", label: "Annet" },
];

export function roleLabel(role: ProjectDocumentRole) {
  switch (role) {
    case "primary_customer_document":
      return "Primært kundedokument";
    case "primary_solution_document":
      return "Primært løsningsdokument";
    default:
      return "Støttedokument";
  }
}

export function supportingSubtypeLabel(subtype: SupportingDocumentSubtype | null) {
  const match = SUPPORTING_SUBTYPES.find((item) => item.value === subtype);
  return match?.label ?? "Støttedokument";
}

export function formatDate(value: string) {
  return new Intl.DateTimeFormat("nb-NO", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

export function deriveProjectStatus(project: Pick<ProjectDetail, "customer_document_uploaded" | "customer_analysis_generated" | "solution_document_uploaded" | "solution_evaluation_generated">): ProjectStatus {
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

export function ValueBadges({ values }: { values: ValueCategory[] }) {
  return (
    <div className="flex flex-wrap gap-2">
      {values.map((value) => (
        <Badge key={value} variant="outline" className="border-emerald-200 bg-emerald-50 text-emerald-700">
          {value}
        </Badge>
      ))}
    </div>
  );
}

export function SectionList({ title, items }: { title: string; items: string[] }) {
  if (!items.length) {
    return null;
  }

  return (
    <Card className="border border-slate-200/80 bg-white shadow-none">
      <CardHeader className="border-b border-slate-200/80 pb-4">
        <CardTitle className="text-xl font-semibold text-slate-950">{title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 pt-5">
        {items.map((item, index) => (
          <div key={`${title}-${index}`} className="rounded-2xl border border-slate-200 bg-slate-50/80 p-4">
            <MarkdownViewer content={item} className="text-base text-slate-700" />
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

export function AnalysisTabEmptyState({ children }: { children: ReactNode }) {
  return (
    <Card className="border border-dashed border-slate-300 bg-slate-50/70 shadow-none">
      <CardContent className="p-8 text-base leading-8 text-slate-600">{children}</CardContent>
    </Card>
  );
}
