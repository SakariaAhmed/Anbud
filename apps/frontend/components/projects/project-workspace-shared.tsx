import type { ReactNode } from "react";
import { FileText, UploadCloud } from "lucide-react";

import type {
  GeneratedArtifactType,
  ProjectDetail,
  ProjectDocument,
  ProjectStatus,
  ValueCategory,
} from "@/lib/types";
import { MarkdownViewer } from "@/components/projects/markdown-viewer";
import { Spinner } from "@/components/ui/spinner";

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
    timeZone: "Europe/Oslo",
  }).format(new Date(value));
}

export function compactFileSize(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "Ukjent størrelse";
  }

  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
  }

  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function documentDropzoneClass(input: {
  active?: boolean;
  disabled?: boolean;
}) {
  const base =
    "group relative flex min-h-[6rem] w-full flex-col items-center justify-center overflow-hidden rounded-lg border border-dashed px-3 py-3 text-center transition-colors md:min-h-[6.25rem]";

  if (input.disabled) {
    return `${base} cursor-not-allowed border-slate-200 bg-slate-50 text-slate-400`;
  }

  if (input.active) {
    return `${base} cursor-pointer border-blue-400 bg-blue-50`;
  }

  return `${base} cursor-pointer border-blue-300 bg-slate-50/70 hover:border-blue-400 hover:bg-blue-50/35`;
}

export function DocumentSourceMeta({
  document,
  label,
}: {
  document: ProjectDocument | null;
  label: string;
}) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-500">
      <FileText className="size-3.5 shrink-0 text-teal-700" />
      <span className="font-black uppercase tracking-[0.16em] text-slate-500">
        {label}
      </span>
      <span className="min-w-0 truncate font-semibold text-slate-700">
        {document?.title ?? "Ukjent dokumentgrunnlag"}
      </span>
      {document ? (
        <span className="shrink-0 text-slate-500">
          {document.file_format.toUpperCase()} ·{" "}
          {compactFileSize(document.file_size_bytes)}
        </span>
      ) : null}
    </div>
  );
}

export function DocumentUploadDropzoneContent({
  busy,
  busyLabel,
  selectedFileName,
  selectedFileDescription,
}: {
  busy: boolean;
  busyLabel: string;
  selectedFileName?: string;
  selectedFileDescription?: string;
}) {
  return (
    <>
      <span className="flex size-8 shrink-0 items-center justify-center rounded-md border border-slate-100 bg-white text-blue-800 shadow-sm transition-colors group-hover:text-blue-700">
        {busy ? <Spinner className="size-3.5" /> : <UploadCloud className="size-3.5" />}
      </span>
      <span className="mt-2 text-xs font-black text-slate-950">
        {busy ? busyLabel : "Dra og slipp dokumentet her"}
      </span>
      <span className="mt-0.5 text-[0.7rem] leading-4 text-slate-500">
        eller klikk for å velge PDF, DOCX, Excel, TXT eller MD.
      </span>
      {selectedFileName ? (
        <span className="mt-2 flex max-w-full flex-col items-center gap-0.5 rounded-md bg-blue-50 px-2.5 py-1.5 text-xs font-semibold text-blue-900">
          <span className="max-w-full truncate">{selectedFileName}</span>
          {selectedFileDescription ? (
            <span className="font-medium text-blue-800/70">
              {selectedFileDescription}
            </span>
          ) : null}
        </span>
      ) : null}
    </>
  );
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
