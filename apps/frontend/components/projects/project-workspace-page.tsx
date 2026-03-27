"use client";

import dynamic from "next/dynamic";
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
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  SUPPORTING_SUBTYPES,
  deriveProjectStatus,
  formatDate,
  roleLabel,
  supportingSubtypeLabel,
} from "@/components/projects/project-workspace-shared";
import type {
  ChatMessage,
  CustomerAnalysisResult,
  GeneratedArtifact,
  GeneratedArtifactType,
  ProjectDetail,
  ProjectDocument,
  ProjectDocumentRole,
  ProjectJobRecord,
  ProjectStatus,
  SolutionEvaluationResult,
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

const ProjectAnalysisTab = dynamic(
  () =>
    import("@/components/projects/project-analysis-tab").then(
      (module) => module.ProjectAnalysisTab,
    ),
  { loading: () => <TabLoadingState label="Laster kundeanalyse" /> },
);

const ProjectEvaluationTab = dynamic(
  () =>
    import("@/components/projects/project-evaluation-tab").then(
      (module) => module.ProjectEvaluationTab,
    ),
  { loading: () => <TabLoadingState label="Laster losningsvurdering" /> },
);

const ProjectGeneratorTab = dynamic(
  () =>
    import("@/components/projects/project-generator-tab").then(
      (module) => module.ProjectGeneratorTab,
    ),
  { loading: () => <TabLoadingState label="Laster generator" /> },
);

const ProjectChatTab = dynamic(
  () =>
    import("@/components/projects/project-chat-tab").then(
      (module) => module.ProjectChatTab,
    ),
  { loading: () => <TabLoadingState label="Laster chat" /> },
);

function TabLoadingState({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
      <Spinner className="size-4" />
      <span>{label} ...</span>
    </div>
  );
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
    preserveHasChat?: boolean;
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
    has_chat: options?.preserveHasChat
      ? project.has_chat
      : project.chat_messages.length > 0,
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

async function readErrorResponse(response: Response, fallback: string) {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    try {
      const payload = (await response.json()) as { error?: string };
      return payload.error || fallback;
    } catch {
      return fallback;
    }
  }
  const text = (await response.text()).trim();
  if (!text || text.startsWith("<!DOCTYPE") || text.startsWith("<html")) {
    return fallback;
  }
  return text;
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
  const [artifactType, setArtifactType] =
    useState<GeneratedArtifactType>("tilbudsstrategi");
  const [artifactInstructions, setArtifactInstructions] = useState("");
  const [chatInput, setChatInput] = useState("");
  const [streamingMessage, setStreamingMessage] = useState("");
  const [activeTab, setActiveTab] = useState("documents");
  const [artifactsLoaded, setArtifactsLoaded] = useState(
    initialData.generated_artifacts.length > 0 ||
      initialData.artifact_count === 0,
  );
  const [chatLoaded, setChatLoaded] = useState(
    initialData.chat_messages.length > 0 || !initialData.has_chat,
  );
  const [uploadOpen, setUploadOpen] = useState(false);
  const chatContainerRef = useRef<HTMLDivElement | null>(null);
  const progressIntervalRef = useRef<number | null>(null);

  const summary = useMemo(
    () => [
      {
        label: "Kundedokument",
        value: project.customer_document_uploaded ? "Pa plass" : "Mangler",
        done: project.customer_document_uploaded,
      },
      {
        label: "Kundeanalyse",
        value: project.customer_analysis_generated ? "Generert" : "Ikke kjort",
        done: project.customer_analysis_generated,
      },
      {
        label: "Losningsdokument",
        value: project.solution_document_uploaded ? "Pa plass" : "Mangler",
        done: project.solution_document_uploaded,
      },
      {
        label: "Losningsvurdering",
        value: project.solution_evaluation_generated
          ? "Generert"
          : "Ikke kjort",
        done: project.solution_evaluation_generated,
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

  useEffect(() => {
    if (activeTab !== "chat" || chatLoaded || !project.has_chat) return;
    let cancelled = false;
    fetch(`/api/projects/${project.id}/chat`, { cache: "no-store" })
      .then(async (response) => {
        const payload = (await response.json()) as {
          error?: string;
          messages?: ChatMessage[];
        };
        if (!response.ok || !payload.messages) {
          throw new Error(payload.error || "Kunne ikke hente chatten.");
        }
        if (!cancelled) {
          setProject((current) =>
            normalizeProjectState({
              ...current,
              chat_messages: payload.messages ?? [],
            }),
          );
          setChatLoaded(true);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(
            err instanceof Error
              ? err.message
              : "Kunne ikke hente chatten.",
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [activeTab, chatLoaded, project.has_chat, project.id]);

  async function onUploadDocument(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!file) {
      setError("Velg en fil forst.");
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
            preserveHasChat: !chatLoaded,
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
          preserveHasChat: !chatLoaded,
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
            preserveHasChat: !chatLoaded,
          },
        ),
      );
    });
  }

  async function onGenerateSolutionEvaluation() {
    if (!project.solution_document_uploaded) {
      const confirmed = window.confirm(
        "Primert losningsdokument mangler. Vil du at systemet skal generere et internt losningsutkast og bruke det som grunnlag for losningsvurderingen?",
      );
      if (!confirmed) return;
    }
    await runAction(
      "evaluation",
      async () => {
        const response = await fetch(`/api/projects/${project.id}/jobs`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            kind: "solution_evaluation",
            allow_generated_solution: !project.solution_document_uploaded,
          }),
        });
        const payload = (await response.json()) as {
          error?: string;
          job?: ProjectJobRecord;
        };
        if (!response.ok || !payload.job) {
          throw new Error(
            payload.error || "Kunne ikke starte losningsvurderingen.",
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
              statusPayload.job.error || "Losningsvurderingen feilet.",
            );
          }
          if (
            statusPayload.job.status !== "completed" ||
            !statusPayload.job.result
          )
            continue;

          const result = statusPayload.job.result as {
            evaluation: SolutionEvaluationResult;
            project: ProjectSnapshotPayload;
            artifact?: GeneratedArtifact | null;
            used_generated_solution?: boolean;
          };
          setProject((current) =>
            normalizeProjectState(
              patchProjectWithSnapshot(
                {
                  ...current,
                  solution_evaluation: result.evaluation,
                  generated_artifacts: result.artifact
                    ? [
                        result.artifact,
                        ...current.generated_artifacts.filter(
                          (a) => a.id !== result.artifact?.id,
                        ),
                      ]
                    : current.generated_artifacts,
                  artifact_count: result.artifact
                    ? current.artifact_count + 1
                    : current.artifact_count,
                },
                result.project,
              ),
              {
                preserveArtifactCount: !artifactsLoaded,
                preserveHasChat: !chatLoaded,
              },
            ),
          );
          if (result.artifact) setArtifactsLoaded(true);
          if (result.used_generated_solution) {
            setNotice(
              "Systemet genererte et internt losningsutkast og brukte det som grunnlag for losningsvurderingen.",
            );
          }
          break;
        }
      },
      project.solution_document_uploaded
        ? ["Starter losningsvurdering ..."]
        : ["Starter systemgenerert losningsvurdering ..."],
    );
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
            artifact_type: artifactType,
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
              { preserveHasChat: !chatLoaded },
            ),
          );
          break;
        }
      },
      ["Starter generatorjobben ..."],
    );
  }

  async function onSendChat(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const message = chatInput.trim();
    if (!message) {
      setError("Skriv en melding forst.");
      return;
    }
    await runAction("chat", async () => {
      const response = await fetch(`/api/projects/${project.id}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message }),
      });
      if (!response.ok) {
        throw new Error(
          await readErrorResponse(response, "Kunne ikke sende chatmelding."),
        );
      }
      setChatInput("");
      setStreamingMessage("");
      const reader = response.body?.getReader();
      const decoder = new TextDecoder();
      let aggregate = "";
      if (reader) {
        let done = false;
        while (!done) {
          const chunk = await reader.read();
          done = chunk.done;
          if (chunk.value) {
            aggregate += decoder.decode(chunk.value, { stream: !done });
            setStreamingMessage(aggregate);
            chatContainerRef.current?.scrollTo({
              top: chatContainerRef.current.scrollHeight,
              behavior: "smooth",
            });
          }
        }
      }
      const createdAt = new Date().toISOString();
      setProject((current) =>
        normalizeProjectState(
          {
            ...current,
            last_activity_at: createdAt,
            chat_messages: current.chat_messages.concat([
              {
                id: `temp-user-${createdAt}`,
                project_id: current.id,
                role: "user",
                content: message,
                context_snapshot: {},
                created_at: createdAt,
              },
              {
                id: `temp-assistant-${createdAt}`,
                project_id: current.id,
                role: "assistant",
                content: aggregate,
                context_snapshot: {},
                created_at: createdAt,
              },
            ]),
          },
          { preserveArtifactCount: !artifactsLoaded },
        ),
      );
      setChatLoaded(true);
      setStreamingMessage("");
    });
  }

  const customerAnalysis =
    project.customer_analysis as CustomerAnalysisResult | null;
  const solutionEvaluation =
    project.solution_evaluation as SolutionEvaluationResult | null;

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
      <div className="mb-6 grid grid-cols-2 gap-px overflow-hidden rounded-lg border bg-border shadow-sm sm:grid-cols-4">
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
      {busyMessage && (busy === "evaluation" || busy === "artifact") ? (
        <div className="mb-3 flex items-center gap-2 rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-sm text-primary">
          <Spinner className="size-3.5" />
          <span>{busyMessage}</span>
        </div>
      ) : null}

      {/* Tabs */}
      <Tabs value={activeTab} onValueChange={setActiveTab} defaultValue="documents">
        <TabsList variant="line" className="mb-4 w-full gap-4 border-b">
          <TabsTrigger value="documents">Dokumenter</TabsTrigger>
          <TabsTrigger value="analysis">Kundeanalyse</TabsTrigger>
          <TabsTrigger value="evaluation">Løsningsvurdering</TabsTrigger>
          <TabsTrigger value="generator">Generator</TabsTrigger>
          <TabsTrigger value="chat">Chat</TabsTrigger>
        </TabsList>

        {/* Documents tab */}
        <TabsContent value="documents">
          <div className="grid gap-6 lg:grid-cols-[320px_minmax(0,1fr)]">
            {/* Upload form */}
            <div className="overflow-hidden rounded-lg border shadow-sm">
              <Collapsible open={uploadOpen} onOpenChange={setUploadOpen}>
                <CollapsibleTrigger
                  className="flex w-full items-center justify-between bg-muted px-4 py-3 text-sm font-semibold text-foreground hover:text-primary"
                >
                  <span className="flex items-center gap-2">
                    <Upload className="size-4" />
                    Last opp dokument
                  </span>
                  <ChevronDown
                    className={`size-4 text-muted-foreground transition-transform ${uploadOpen ? "rotate-180" : ""}`}
                  />
                </CollapsibleTrigger>
                <CollapsibleContent>
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
                      <Select
                        value={docRole}
                        onValueChange={(v) =>
                          setDocRole(v as ProjectDocumentRole)
                        }
                      >
                        <SelectTrigger id="docRole">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="primary_customer_document">
                            Primert kundedokument
                          </SelectItem>
                          <SelectItem value="primary_solution_document">
                            Primert losningsdokument
                          </SelectItem>
                          <SelectItem value="supporting_document">
                            Stottedokument
                          </SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    {docRole === "supporting_document" ? (
                      <div className="space-y-1.5">
                        <Label htmlFor="supportingSubtype" className="font-medium">Undertype</Label>
                        <Select
                          value={supportingSubtype}
                          onValueChange={(v) =>
                            setSupportingSubtype(
                              v as SupportingDocumentSubtype,
                            )
                          }
                        >
                          <SelectTrigger id="supportingSubtype">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {SUPPORTING_SUBTYPES.map((item) => (
                              <SelectItem key={item.value} value={item.value}>
                                {item.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
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
                </CollapsibleContent>
              </Collapsible>
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
        </TabsContent>

        <TabsContent value="analysis">
          <ProjectAnalysisTab
            customerAnalysis={customerAnalysis}
            busy={busy === "analysis"}
            onGenerate={onGenerateCustomerAnalysis}
          />
        </TabsContent>

        <TabsContent value="evaluation">
          <ProjectEvaluationTab
            solutionEvaluation={solutionEvaluation}
            hasSolutionDocument={project.solution_document_uploaded}
            busy={busy === "evaluation"}
            busyMessage={busy === "evaluation" ? busyMessage : ""}
            onGenerate={onGenerateSolutionEvaluation}
          />
        </TabsContent>

        <TabsContent value="generator">
          <ProjectGeneratorTab
            artifacts={project.generated_artifacts}
            artifactType={artifactType}
            artifactInstructions={artifactInstructions}
            busy={busy === "artifact"}
            busyMessage={busy === "artifact" ? busyMessage : ""}
            onArtifactTypeChange={setArtifactType}
            onArtifactInstructionsChange={setArtifactInstructions}
            onSubmit={onGenerateArtifact}
          />
        </TabsContent>

        <TabsContent value="chat">
          <ProjectChatTab
            chatMessages={project.chat_messages as ChatMessage[]}
            chatInput={chatInput}
            streamingMessage={streamingMessage}
            busy={busy === "chat"}
            chatContainerRef={chatContainerRef}
            onChatInputChange={setChatInput}
            onSubmit={onSendChat}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
