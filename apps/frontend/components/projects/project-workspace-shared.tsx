import type { ReactNode } from "react";

import type {
  GeneratedArtifactType,
  ProjectDetail,
  ProjectStatus,
  ValueCategory,
} from "@/lib/types";
import { MarkdownViewer } from "@/components/projects/markdown-viewer";

export const VALUE_LABELS: ValueCategory[] = [
  "Høyere produktivitet",
  "Lavere kostnader",
  "Redusert risiko",
  "Bedre brukeropplevelse",
];

export const ARTIFACT_TYPES: Array<{
  value: GeneratedArtifactType;
  label: string;
}> = [{ value: "losningsutkast", label: "Løsningsbeskrivelse" }];

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
  if (project.customer_analysis_generated) {
    return "Kundeanalyse klar";
  }
  if (project.customer_document_uploaded || project.solution_document_uploaded) {
    return "Dokument lastet opp";
  }
  return "Venter på dokument";
}

export function ValueTags({ values }: { values: ValueCategory[] }) {
  const value = values.find((item) => VALUE_LABELS.includes(item));
  if (!value) return null;

  return (
    <div>
      <span className="text-lg font-semibold text-emerald-700 dark:text-emerald-400">
        {value}
      </span>
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
          <li
            key={`${title}-${index}`}
            className="border-l-2 border-border pl-3"
          >
            <MarkdownViewer
              content={item}
              className="text-sm text-muted-foreground"
            />
          </li>
        ))}
      </ul>
    </div>
  );
}

export function AnalysisTabEmptyState({ children }: { children: ReactNode }) {
  return (
    <div className="py-12 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}
