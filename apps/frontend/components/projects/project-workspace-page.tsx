"use client";

import Link from "next/link";
import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDownToLine,
  ArrowLeft,
  ChevronDown,
  FileText,
  Trash2,
  Upload,
} from "lucide-react";

import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsList, TabsTrigger } from "@/components/projects/project-tabs";
import { Input, Label, NativeSelect, NativeSelectOption } from "@/components/projects/primitives";
import {
  SUPPORTING_SUBTYPES,
  deriveProjectStatus,
  formatDate,
  roleLabel,
  supportingSubtypeLabel,
} from "@/components/projects/project-workspace-shared";
import { ProjectAnalysisTab } from "@/components/projects/project-analysis-tab";
import { ProjectGeneratorTab } from "@/components/projects/project-generator-tab";
import type {
  CustomerAnalysisResult,
  GeneratedArtifact,
  ProjectDetail,
  ProjectDocument,
  ProjectDocumentRole,
  ProjectJobRecord,
  ProjectStatus,
  SupportingDocumentSubtype,
} from "@/lib/types";

interface ProjectSnapshotPayload {
  name: string;
  customer_name: string | null;
  description: string | null;
  industry: string | null;
  status: ProjectStatus;
  customer_document_uploaded: boolean;
  customer_analysis_generated: boolean;
  solution_document_uploaded: boolean;
  solution_evaluation_generated: boolean;
  last_activity_at: string;
}

function patchProjectWithSnapshot(
  project: ProjectDetail,
  snapshot: ProjectSnapshotPayload,
): ProjectDetail {
  return { ...project, ...snapshot };
}

function normalizeProjectState(
  project: ProjectDetail,
  options?: {
    preserveArtifactCount?: boolean;
  },
): ProjectDetail {
  return {
    ...project,
    status: deriveProjectStatus(project),
    document_count: project.documents.length,
    supporting_document_count: project.documents.filter(
      (d) => d.role === "supporting_document",
    ).length,
    artifact_count: options?.preserveArtifactCount
      ? project.artifact_count
      : project.generated_artifacts.length,
  };
}

function dedupeDocuments(documents: ProjectDocument[]) {
  const seen = new Set<string>();
  return documents.filter((d) => {
    if (seen.has(d.id)) return false;
    seen.add(d.id);
    return true;
  });
}

function sleep(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

export function ProjectWorkspacePage({
  initialData,
}: {
  initialData: ProjectDetail;
}) {
  const [project, setProject] = useState(initialData);
  const [busy, setBusy] = useState<string | null>(null);
  const [busyMessage, setBusyMessage] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [docTitle, setDocTitle] = useState("");
  const [docRole, setDocRole] =
    useState<ProjectDocumentRole>("primary_customer_document");
  const [supportingSubtype, setSupportingSubtype] =
    useState<SupportingDocumentSubtype>("rfp");
  const [file, setFile] = useState<File | null>(null);
  const [artifactInstructions, setArtifactInstructions] = useState("");
  const [activeTab, setActiveTab] = useState("documents");
  const [artifactsLoaded, setArtifactsLoaded] = useState(
    initialData.generated_artifacts.length > 0 ||
      initialData.artifact_count === 0,
  );
  const [uploadOpen, setUploadOpen] = useState(false);
  const progressIntervalRef = useRef<number | null>(null);

  const summary = useMemo(
    () => [
      {
        label: "Kundedokument",
        value: project.customer_document_uploaded ? "På plass" : "Mangler",
        done: project.customer_document_uploaded,
      },
      {
        label: "Kundeanalyse",
        value: project.customer_analysis_generated ? "Generert" : "Ikke kjørt",
        done: project.customer_analysis_generated,
      },
      {
        label: "Løsningsdokument",
        value: project.solution_document_uploaded ? "På plass" : "Mangler",
        done: project.solution_document_uploaded,
      },
    ],
    [project],
  );

  function stopProgressTicker() {
    if (progressIntervalRef.current) {
      window.clearInterval(progressIntervalRef.current);
      progressIntervalRef.current = null;
    }
    setBusyMessage("");
  }

  function startProgressTicker(messages: string[]) {
    stopProgressTicker();
    if (!messages.length) return;
    setBusyMessage(messages[0] ?? "");
    if (messages.length < 2) return;
    let index = 0;
    progressIntervalRef.current = window.setInterval(() => {
      index = Math.min(index + 1, messages.length - 1);
      setBusyMessage(messages[index] ?? "");
    }, 3200);
  }

  useEffect(() => stopProgressTicker, []);

  async function runAction(
    label: string,
    action: () => Promise<void>,
    progressMessages?: string[],
  ) {
    setBusy(label);
    setError("");
    setNotice("");
    startProgressTicker(progressMessages ?? []);
    try {
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Noe gikk galt.");
    } finally {
      stopProgressTicker();
      setBusy(null);
    }
  }

  useEffect(() => {
    if (
      activeTab !== "generator" ||
      artifactsLoaded ||
      project.artifact_count === 0
    )
      return;
    let cancelled = false;
    fetch(`/api/projects/${project.id}/generate`, { cache: "no-store" })
      .then(async (response) => {
        const payload = (await response.json()) as {
          error?: string;
          artifacts?: GeneratedArtifact[];
        };
        if (!response.ok || !payload.artifacts) {
          throw new Error(
            payload.error || "Kunne ikke hente generatorresultatene.",
          );
        }
        if (!cancelled) {
          setProject((current) =>
            normalizeProjectState({
              ...current,
              generated_artifacts: payload.artifacts ?? [],
            }),
          );
          setArtifactsLoaded(true);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(
            err instanceof Error
              ? err.message
              : "Kunne ikke hente generatorresultatene.",
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [activeTab, artifactsLoaded, project.artifact_count, project.id]);

  async function onUploadDocument(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!file) {
      setError("Velg en fil først.");
      return;
    }
    await runAction("upload", async () => {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("title", docTitle);
      formData.append("role", docRole);
      if (docRole === "supporting_document") {
        formData.append("supporting_subtype", supportingSubtype);
      }
      const response = await fetch(
        `/api/projects/${project.id}/documents`,
        { method: "POST", body: formData },
      );
      const payload = (await response.json()) as {
        error?: string;
        document?: ProjectDocument;
        project?: ProjectSnapshotPayload;
      };
      if (!response.ok || !payload.document || !payload.project) {
        throw new Error(payload.error || "Kunne ikke laste opp dokumentet.");
      }
      setDocTitle("");
      setFile(null);
      setProject((current) =>
        normalizeProjectState(
          patchProjectWithSnapshot(
            {
              ...current,
              documents: dedupeDocuments([
                payload.document!,
                ...current.documents,
              ]),
            },
            payload.project!,
          ),
          {
            preserveArtifactCount: !artifactsLoaded,
          },
        ),
      );
      setArtifactsLoaded(true);
    });
  }

  async function onDeleteDocument(document: ProjectDocument) {
    await runAction(`delete-${document.id}`, async () => {
      const response = await fetch(
        `/api/projects/${project.id}/documents/${document.id}`,
        { method: "DELETE" },
      );
      const payload = (await response.json()) as {
        error?: string;
        project?: ProjectSnapshotPayload;
      };
      if (!response.ok || !payload.project) {
        throw new Error(payload.error || "Kunne ikke slette dokumentet.");
      }
      setProject((current) => {
        const next = patchProjectWithSnapshot(
          {
            ...current,
            documents: current.documents.filter((item) => item.id !== document.id),
            customer_analysis:
              document.role === "primary_customer_document" &&
              !payload.project?.customer_analysis_generated
                ? null
                : current.customer_analysis,
            solution_evaluation:
              document.role === "primary_solution_document" &&
              !payload.project?.solution_evaluation_generated
                ? null
                : current.solution_evaluation,
          },
          payload.project!,
        );
        return normalizeProjectState(next, {
          preserveArtifactCount: !artifactsLoaded,
        });
      });
    });
  }

  async function onGenerateCustomerAnalysis() {
    await runAction("analysis", async () => {
      const response = await fetch(
        `/api/projects/${project.id}/customer-analysis`,
        { method: "POST" },
      );
      const payload = (await response.json()) as {
        error?: string;
        analysis?: CustomerAnalysisResult;
        project?: ProjectSnapshotPayload;
      };
      if (!response.ok || !payload.analysis || !payload.project) {
        throw new Error(
          payload.error || "Kunne ikke generere kundeanalyse.",
        );
      }
      setProject((current) =>
        normalizeProjectState(
          patchProjectWithSnapshot(
            { ...current, customer_analysis: payload.analysis! },
            payload.project!,
          ),
          {
            preserveArtifactCount: !artifactsLoaded,
          },
        ),
      );
    });
  }

  async function onGenerateHighLevelDesign() {
    await runAction(
      "high-level-design",
      async () => {
        const response = await fetch(`/api/projects/${project.id}/jobs`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            kind: "high_level_design",
          }),
        });
        const payload = (await response.json()) as {
          error?: string;
          job?: ProjectJobRecord;
        };
        if (!response.ok || !payload.job) {
          throw new Error(
            payload.error || "Kunne ikke starte jobben for overordnet løsningsdesign.",
          );
        }
        setBusyMessage(payload.job.message);
        while (true) {
          await sleep(1500);
          const statusResponse = await fetch(
            `/api/projects/${project.id}/jobs/${payload.job.id}`,
            { cache: "no-store" },
          );
          const statusPayload = (await statusResponse.json()) as {
            error?: string;
            job?: ProjectJobRecord;
          };
          if (!statusResponse.ok || !statusPayload.job) {
            throw new Error(
              statusPayload.error || "Kunne ikke hente jobbstatus.",
            );
          }
          setBusyMessage(statusPayload.job.message);
          if (statusPayload.job.status === "failed") {
            throw new Error(
              statusPayload.job.error || "Jobben for overordnet løsningsdesign feilet.",
            );
          }
          if (
            statusPayload.job.status !== "completed" ||
            !statusPayload.job.result
          ) {
            continue;
          }

          const result = statusPayload.job.result as {
            analysis: CustomerAnalysisResult;
            project: ProjectSnapshotPayload;
          };
          setProject((current) =>
            normalizeProjectState(
              patchProjectWithSnapshot(
                { ...current, customer_analysis: result.analysis },
                result.project,
              ),
              {
                preserveArtifactCount: !artifactsLoaded,
              },
            ),
          );
          setNotice(
            "Overordnet løsningsdesign og arkitekturdiagram er oppdatert uten å regenerere hele kundeanalysen.",
          );
          break;
        }
      },
      ["Starter generering av overordnet løsningsdesign ..."],
    );
  }

  async function onSaveAnalysis(value: string) {
    await runAction("save-analysis", async () => {
      const response = await fetch(
        `/api/projects/${project.id}/customer-analysis`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ analysis_text: value }),
        },
      );
      const payload = (await response.json()) as {
        error?: string;
        analysis?: CustomerAnalysisResult;
        project?: ProjectSnapshotPayload;
      };
      if (!response.ok || !payload.analysis || !payload.project) {
        throw new Error(payload.error || "Kunne ikke lagre analysen.");
      }
      setProject((current) =>
        normalizeProjectState(
          patchProjectWithSnapshot(
            { ...current, customer_analysis: payload.analysis! },
            payload.project!,
          ),
          {
            preserveArtifactCount: !artifactsLoaded,
          },
        ),
      );
      setNotice("Analysen er oppdatert og lagret i prosjektet.");
    });
  }

  async function onGenerateArtifact(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await runAction(
      "artifact",
      async () => {
        const response = await fetch(`/api/projects/${project.id}/jobs`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            kind: "artifact_generation",
            artifact_type: "losningsutkast",
            instructions: artifactInstructions,
          }),
        });
        const payload = (await response.json()) as {
          error?: string;
          job?: ProjectJobRecord;
        };
        if (!response.ok || !payload.job) {
          throw new Error(
            payload.error || "Kunne ikke starte generatorjobben.",
          );
        }
        setBusyMessage(payload.job.message);
        while (true) {
          await sleep(1500);
          const statusResponse = await fetch(
            `/api/projects/${project.id}/jobs/${payload.job.id}`,
            { cache: "no-store" },
          );
          const statusPayload = (await statusResponse.json()) as {
            error?: string;
            job?: ProjectJobRecord;
          };
          if (!statusResponse.ok || !statusPayload.job) {
            throw new Error(
              statusPayload.error || "Kunne ikke hente jobbstatus.",
            );
          }
          setBusyMessage(statusPayload.job.message);
          if (statusPayload.job.status === "failed") {
            throw new Error(
              statusPayload.job.error || "Generatorjobben feilet.",
            );
          }
          if (
            statusPayload.job.status !== "completed" ||
            !statusPayload.job.result
          )
            continue;

          const result = statusPayload.job.result as {
            artifact: GeneratedArtifact;
            project: ProjectSnapshotPayload;
          };
          setProject((current) =>
            normalizeProjectState(
              patchProjectWithSnapshot(
                {
                  ...current,
                  generated_artifacts: [
                    result.artifact,
                    ...current.generated_artifacts,
                  ],
                  artifact_count: current.artifact_count + 1,
                },
                result.project,
              ),
            ),
          );
          break;
        }
      },
      ["Starter generatorjobben ..."],
    );
  }

  const customerAnalysis =
    project.customer_analysis as CustomerAnalysisResult | null;

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-8 lg:px-0">
      {/* Back link */}
      <Link
        href="/"
        className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "mb-4 -ml-2 gap-1.5 text-muted-foreground")}
      >
        <ArrowLeft className="size-3.5" />
        Tilbake
      </Link>

      {/* Project header */}
      <section className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight text-foreground">
          {project.name}
        </h1>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-sm text-muted-foreground">
          {project.customer_name ? (
            <span className="font-medium">{project.customer_name}</span>
          ) : null}
          {project.industry ? (
            <>
              <span className="text-border">·</span>
              <span>{project.industry}</span>
            </>
          ) : null}
          <span className="text-border">·</span>
          <span>Oppdatert {formatDate(project.last_activity_at)}</span>
        </div>
        {project.description ? (
          <p className="mt-1.5 max-w-3xl text-sm text-foreground/70">
            {project.description}
          </p>
        ) : null}
      </section>

      {/* Status indicators */}
      <div className="mb-6 grid grid-cols-1 gap-px overflow-hidden rounded-lg border bg-border shadow-sm sm:grid-cols-3">
        {summary.map((item) => (
          <div
            key={item.label}
            className="bg-background px-4 py-3"
          >
            <p className="text-xs font-medium text-muted-foreground">{item.label}</p>
            <p
              className={cn(
                "mt-0.5 text-sm font-semibold",
                item.done ? "text-foreground" : "text-muted-foreground/70",
              )}
            >
              {item.done ? (
                <span className="mr-1.5 inline-block size-2 rounded-full bg-emerald-500 align-middle" />
              ) : null}
              {item.value}
            </p>
          </div>
        ))}
      </div>

      {/* Notices */}
      {error ? (
        <div className="mb-3 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      ) : null}
      {!error && notice ? (
        <div className="mb-3 rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-sm text-primary">
          {notice}
        </div>
      ) : null}
      {busyMessage && busy === "artifact" ? (
        <div className="mb-3 flex items-center gap-2 rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-sm text-primary">
          <Spinner className="size-3.5" />
          <span>{busyMessage}</span>
        </div>
      ) : null}

      {/* Tabs */}
      <Tabs value={activeTab} onValueChange={setActiveTab} defaultValue="documents">
        <TabsList className="mb-4 flex w-full gap-6 border-b border-border">
          <TabsTrigger value="documents" className="pb-2 text-sm">
            Dokumenter
          </TabsTrigger>
          <TabsTrigger value="analysis" className="pb-2 text-sm">
            Kundeanalyse
          </TabsTrigger>
          <TabsTrigger value="generator" className="pb-2 text-sm">
            Løsningsutkast
          </TabsTrigger>
        </TabsList>

        {/* Documents tab */}
        {activeTab === "documents" ? (
          <div className="grid gap-6 lg:grid-cols-[320px_minmax(0,1fr)]">
            {/* Upload form */}
            <div className="overflow-hidden rounded-lg border shadow-sm">
              <div>
                <button
                  type="button"
                  onClick={() => setUploadOpen((open) => !open)}
                  className="flex w-full items-center justify-between bg-muted px-4 py-3 text-sm font-semibold text-foreground hover:text-primary"
                >
                  <span className="flex items-center gap-2">
                    <Upload className="size-4" />
                    Last opp dokument
                  </span>
                  <ChevronDown
                    className={`size-4 text-muted-foreground transition-transform ${uploadOpen ? "rotate-180" : ""}`}
                  />
                </button>
                {uploadOpen ? (
                  <form
                    onSubmit={onUploadDocument}
                    className="space-y-3 p-4"
                  >
                    <div className="space-y-1.5">
                      <Label htmlFor="docTitle" className="font-medium">Tittel</Label>
                      <Input
                        id="docTitle"
                        value={docTitle}
                        onChange={(e) => setDocTitle(e.target.value)}
                        placeholder="Visningsnavn i prosjektet"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="docRole" className="font-medium">Dokumentrolle</Label>
                      <NativeSelect
                        id="docRole"
                        value={docRole}
                        onChange={(event) =>
                          setDocRole(event.target.value as ProjectDocumentRole)
                        }
                      >
                        <NativeSelectOption value="primary_customer_document">
                          Primært kundedokument
                        </NativeSelectOption>
                        <NativeSelectOption value="primary_solution_document">
                          Primært løsningsdokument
                        </NativeSelectOption>
                        <NativeSelectOption value="supporting_document">
                          Støttedokument
                        </NativeSelectOption>
                      </NativeSelect>
                    </div>
                    {docRole === "supporting_document" ? (
                      <div className="space-y-1.5">
                        <Label htmlFor="supportingSubtype" className="font-medium">Undertype</Label>
                        <NativeSelect
                          id="supportingSubtype"
                          value={supportingSubtype}
                          onChange={(event) =>
                            setSupportingSubtype(
                              event.target.value as SupportingDocumentSubtype,
                            )
                          }
                        >
                          {SUPPORTING_SUBTYPES.map((item) => (
                            <NativeSelectOption key={item.value} value={item.value}>
                              {item.label}
                            </NativeSelectOption>
                          ))}
                        </NativeSelect>
                      </div>
                    ) : null}
                    <div className="space-y-1.5">
                      <Label htmlFor="file" className="font-medium">Fil</Label>
                      <Input
                        id="file"
                        type="file"
                        accept=".pdf,.docx,.txt,.md"
                        onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                      />
                    </div>
                    <Button
                      type="submit"
                      className="w-full"
                      disabled={busy === "upload"}
                    >
                      {busy === "upload" ? (
                        <Spinner className="size-4" />
                      ) : (
                        <Upload data-icon="inline-start" />
                      )}
                      Last opp
                    </Button>
                  </form>
                ) : null}
              </div>
            </div>

            {/* Document list */}
            <div className="overflow-hidden rounded-lg border shadow-sm">
              <div className="bg-muted px-4 py-3">
                <h3 className="text-sm font-bold text-foreground">
                  Dokumenter i prosjektet
                </h3>
              </div>
              {project.documents.length === 0 ? (
                <p className="bg-background py-8 text-center text-sm text-muted-foreground">
                  Ingen dokumenter lastet opp ennå.
                </p>
              ) : (
                <div>
                  {project.documents.map((document) => (
                    <div
                      key={document.id}
                      className="flex items-start justify-between gap-3 border-t bg-background px-4 py-3"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <FileText className="size-4 shrink-0 text-primary" />
                          <span className="truncate text-sm font-semibold text-foreground">
                            {document.title}
                          </span>
                        </div>
                        <p className="mt-0.5 pl-6 text-xs text-muted-foreground">
                          {roleLabel(document.role)}
                          {document.role === "supporting_document"
                            ? ` · ${supportingSubtypeLabel(document.supporting_subtype)}`
                            : ""}
                          {" · "}
                          {document.file_format.toUpperCase()}{" "}
                          {Math.round(document.file_size_bytes / 1024)} KB
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        <a
                          href={`/api/projects/${project.id}/documents/${document.id}`}
                          className={cn(buttonVariants({ variant: "ghost", size: "icon-xs" }))}
                        >
                          <ArrowDownToLine className="size-3.5" />
                        </a>
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          onClick={() => onDeleteDocument(document)}
                          disabled={busy === `delete-${document.id}`}
                          className="text-destructive hover:text-destructive"
                        >
                          {busy === `delete-${document.id}` ? (
                            <Spinner className="size-3.5" />
                          ) : (
                            <Trash2 className="size-3.5" />
                          )}
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        ) : null}

        {activeTab === "analysis" ? (
          <ProjectAnalysisTab
            customerAnalysis={customerAnalysis}
            busy={busy === "analysis"}
            saveBusy={busy === "save-analysis"}
            highLevelBusy={busy === "high-level-design"}
            busyMessage={busy === "high-level-design" ? busyMessage : ""}
            onGenerate={onGenerateCustomerAnalysis}
            onGenerateHighLevel={onGenerateHighLevelDesign}
            onSaveAnalysis={onSaveAnalysis}
          />
        ) : null}

        {activeTab === "generator" ? (
          <ProjectGeneratorTab
            artifacts={project.generated_artifacts}
            artifactInstructions={artifactInstructions}
            busy={busy === "artifact"}
            busyMessage={busy === "artifact" ? busyMessage : ""}
            onArtifactInstructionsChange={setArtifactInstructions}
            onSubmit={onGenerateArtifact}
          />
        ) : null}
      </Tabs>
    </div>
  );
}
