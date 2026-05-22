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

export function GenerationProgress({
  message,
  progress,
}: {
  message: string;
  progress: number;
}) {
  const safeProgress = Math.min(100, Math.max(3, Math.round(progress)));

  return (
    <div
      className="min-w-0 rounded-lg border border-primary/20 bg-primary/5 px-3 py-3"
      aria-live="polite"
    >
      <div className="mb-2 flex items-center justify-between gap-3 text-xs font-semibold text-primary">
        <span className="min-w-0 truncate">{message}</span>
        <span className="shrink-0 tabular-nums">{safeProgress}%</span>
      </div>
      <div
        className="h-2 overflow-hidden rounded-full bg-primary/15"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={safeProgress}
      >
        <div
          className="relative h-full overflow-hidden rounded-full bg-primary transition-[width] duration-500 ease-out"
          style={{ width: `${safeProgress}%` }}
        >
          <span className="absolute inset-0 bg-gradient-to-r from-transparent via-white/30 to-transparent opacity-70 motion-safe:animate-pulse" />
        </div>
      </div>
    </div>
  );
}
