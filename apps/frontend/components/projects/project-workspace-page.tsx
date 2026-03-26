"use client";

import dynamic from "next/dynamic";
import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { ArrowDownToLine, LoaderCircle, Trash2, Upload } from "lucide-react";

import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
  NativeSelect,
  NativeSelectOption,
} from "@/components/projects/primitives";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/projects/project-tabs";
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
  ProjectJobRecord,
  ProjectDocumentRole,
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
  () => import("@/components/projects/project-analysis-tab").then((module) => module.ProjectAnalysisTab),
  {
    loading: () => <TabLoadingState label="Laster kundeanalyse" />,
  },
);

const ProjectEvaluationTab = dynamic(
  () => import("@/components/projects/project-evaluation-tab").then((module) => module.ProjectEvaluationTab),
  {
    loading: () => <TabLoadingState label="Laster løsningsvurdering" />,
  },
);

const ProjectGeneratorTab = dynamic(
  () => import("@/components/projects/project-generator-tab").then((module) => module.ProjectGeneratorTab),
  {
    loading: () => <TabLoadingState label="Laster generator" />,
  },
);

const ProjectChatTab = dynamic(
  () => import("@/components/projects/project-chat-tab").then((module) => module.ProjectChatTab),
  {
    loading: () => <TabLoadingState label="Laster chat" />,
  },
);

function TabLoadingState({ label }: { label: string }) {
  return (
    <Card className="border border-slate-200/80 bg-white shadow-none">
      <CardContent className="flex items-center gap-3 p-8 text-slate-600">
        <LoaderCircle className="size-5 animate-spin" />
        <span>{label} ...</span>
      </CardContent>
    </Card>
  );
}

function patchProjectWithSnapshot(project: ProjectDetail, snapshot: ProjectSnapshotPayload): ProjectDetail {
  return {
    ...project,
    ...snapshot,
  };
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
    supporting_document_count: project.documents.filter((document) => document.role === "supporting_document").length,
    artifact_count: options?.preserveArtifactCount ? project.artifact_count : project.generated_artifacts.length,
    has_chat: options?.preserveHasChat ? project.has_chat : project.chat_messages.length > 0,
  };
}

function dedupeDocuments(documents: ProjectDocument[]) {
  const seen = new Set<string>();
  return documents.filter((document) => {
    if (seen.has(document.id)) {
      return false;
    }
    seen.add(document.id);
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
  if (!text) {
    return fallback;
  }

  if (text.startsWith("<!DOCTYPE") || text.startsWith("<html")) {
    return fallback;
  }

  return text;
}

export function ProjectWorkspacePage({ initialData }: { initialData: ProjectDetail }) {
  const [project, setProject] = useState(initialData);
  const [busy, setBusy] = useState<string | null>(null);
  const [busyMessage, setBusyMessage] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [docTitle, setDocTitle] = useState("");
  const [docRole, setDocRole] = useState<ProjectDocumentRole>("primary_customer_document");
  const [supportingSubtype, setSupportingSubtype] = useState<SupportingDocumentSubtype>("rfp");
  const [file, setFile] = useState<File | null>(null);
  const [artifactType, setArtifactType] = useState<GeneratedArtifactType>("tilbudsstrategi");
  const [artifactInstructions, setArtifactInstructions] = useState("");
  const [chatInput, setChatInput] = useState("");
  const [streamingMessage, setStreamingMessage] = useState("");
  const [activeTab, setActiveTab] = useState("documents");
  const [artifactsLoaded, setArtifactsLoaded] = useState(initialData.generated_artifacts.length > 0 || initialData.artifact_count === 0);
  const [chatLoaded, setChatLoaded] = useState(initialData.chat_messages.length > 0 || !initialData.has_chat);
  const chatContainerRef = useRef<HTMLDivElement | null>(null);
  const progressIntervalRef = useRef<number | null>(null);

  const summary = useMemo(
    () => [
      { label: "Kundedokument", value: project.customer_document_uploaded ? "På plass" : "Mangler" },
      { label: "Kundeanalyse", value: project.customer_analysis_generated ? "Generert" : "Ikke kjørt" },
      { label: "Løsningsdokument", value: project.solution_document_uploaded ? "På plass" : "Mangler" },
      { label: "Løsningsvurdering", value: project.solution_evaluation_generated ? "Generert" : "Ikke kjørt" },
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
    if (!messages.length) {
      return;
    }

    setBusyMessage(messages[0] ?? "");
    if (messages.length < 2) {
      return;
    }

    let index = 0;
    progressIntervalRef.current = window.setInterval(() => {
      index = Math.min(index + 1, messages.length - 1);
      setBusyMessage(messages[index] ?? "");
    }, 3200);
  }

  useEffect(() => stopProgressTicker, []);

  async function runAction(label: string, action: () => Promise<void>, progressMessages?: string[]) {
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
    if (activeTab !== "generator" || artifactsLoaded || project.artifact_count === 0) {
      return;
    }

    let cancelled = false;

    fetch(`/api/projects/${project.id}/generate`, { cache: "no-store" })
      .then(async (response) => {
        const payload = (await response.json()) as { error?: string; artifacts?: GeneratedArtifact[] };
        if (!response.ok || !payload.artifacts) {
          throw new Error(payload.error || "Kunne ikke hente generatorresultatene.");
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
          setError(err instanceof Error ? err.message : "Kunne ikke hente generatorresultatene.");
        }
      });

    return () => {
      cancelled = true;
    };
  }, [activeTab, artifactsLoaded, project.artifact_count, project.id]);

  useEffect(() => {
    if (activeTab !== "chat" || chatLoaded || !project.has_chat) {
      return;
    }

    let cancelled = false;

    fetch(`/api/projects/${project.id}/chat`, { cache: "no-store" })
      .then(async (response) => {
        const payload = (await response.json()) as { error?: string; messages?: ChatMessage[] };
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
          setError(err instanceof Error ? err.message : "Kunne ikke hente chatten.");
        }
      });

    return () => {
      cancelled = true;
    };
  }, [activeTab, chatLoaded, project.has_chat, project.id]);

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

      const response = await fetch(`/api/projects/${project.id}/documents`, {
        method: "POST",
        body: formData,
      });
      const payload = (await response.json()) as { error?: string; document?: ProjectDocument; project?: ProjectSnapshotPayload };
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
              documents: dedupeDocuments([payload.document!, ...current.documents]),
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
      const response = await fetch(`/api/projects/${project.id}/documents/${document.id}`, {
        method: "DELETE",
      });
      const payload = (await response.json()) as { error?: string; project?: ProjectSnapshotPayload };
      if (!response.ok || !payload.project) {
        throw new Error(payload.error || "Kunne ikke slette dokumentet.");
      }

      setProject((current) => {
        const next = patchProjectWithSnapshot(
          {
            ...current,
            documents: current.documents.filter((item) => item.id !== document.id),
            customer_analysis:
              document.role === "primary_customer_document" && !payload.project?.customer_analysis_generated
                ? null
                : current.customer_analysis,
            solution_evaluation:
              document.role === "primary_solution_document" && !payload.project?.solution_evaluation_generated
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
      const response = await fetch(`/api/projects/${project.id}/customer-analysis`, { method: "POST" });
      const payload = (await response.json()) as {
        error?: string;
        analysis?: CustomerAnalysisResult;
        project?: ProjectSnapshotPayload;
      };

      if (!response.ok || !payload.analysis || !payload.project) {
        throw new Error(payload.error || "Kunne ikke generere kundeanalyse.");
      }

      setProject((current) =>
        normalizeProjectState(
          patchProjectWithSnapshot(
            {
              ...current,
              customer_analysis: payload.analysis!,
            },
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
        "Primært løsningsdokument mangler. Vil du at systemet skal generere et internt løsningsutkast og bruke det som grunnlag for løsningsvurderingen?",
      );

      if (!confirmed) {
        return;
      }
    }

    await runAction("evaluation", async () => {
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
        throw new Error(payload.error || "Kunne ikke starte løsningsvurderingen.");
      }

      setBusyMessage(payload.job.message);

      while (true) {
        await sleep(1500);

        const statusResponse = await fetch(`/api/projects/${project.id}/jobs/${payload.job.id}`, {
          cache: "no-store",
        });
        const statusPayload = (await statusResponse.json()) as {
          error?: string;
          job?: ProjectJobRecord;
        };

        if (!statusResponse.ok || !statusPayload.job) {
          throw new Error(statusPayload.error || "Kunne ikke hente jobbstatus.");
        }

        setBusyMessage(statusPayload.job.message);

        if (statusPayload.job.status === "failed") {
          throw new Error(statusPayload.job.error || "Løsningsvurderingen feilet.");
        }

        if (statusPayload.job.status !== "completed" || !statusPayload.job.result) {
          continue;
        }

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
                  ? [result.artifact, ...current.generated_artifacts.filter((artifact) => artifact.id !== result.artifact?.id)]
                  : current.generated_artifacts,
                artifact_count: result.artifact ? current.artifact_count + 1 : current.artifact_count,
              },
              result.project,
            ),
            {
              preserveArtifactCount: !artifactsLoaded,
              preserveHasChat: !chatLoaded,
            },
          ),
        );
        if (result.artifact) {
          setArtifactsLoaded(true);
        }
        if (result.used_generated_solution) {
          setNotice("Systemet genererte et internt løsningsutkast og brukte det som grunnlag for løsningsvurderingen.");
        }
        break;
      }
    }, project.solution_document_uploaded
      ? [
          "Starter løsningsvurdering ...",
        ]
      : [
          "Starter systemgenerert løsningsvurdering ...",
        ]);
  }

  async function onGenerateArtifact(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    await runAction("artifact", async () => {
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
        throw new Error(payload.error || "Kunne ikke starte generatorjobben.");
      }

      setBusyMessage(payload.job.message);

      while (true) {
        await sleep(1500);

        const statusResponse = await fetch(`/api/projects/${project.id}/jobs/${payload.job.id}`, {
          cache: "no-store",
        });
        const statusPayload = (await statusResponse.json()) as {
          error?: string;
          job?: ProjectJobRecord;
        };

        if (!statusResponse.ok || !statusPayload.job) {
          throw new Error(statusPayload.error || "Kunne ikke hente jobbstatus.");
        }

        setBusyMessage(statusPayload.job.message);

        if (statusPayload.job.status === "failed") {
          throw new Error(statusPayload.job.error || "Generatorjobben feilet.");
        }

        if (statusPayload.job.status !== "completed" || !statusPayload.job.result) {
          continue;
        }

        const result = statusPayload.job.result as {
          artifact: GeneratedArtifact;
          project: ProjectSnapshotPayload;
        };

        setProject((current) =>
          normalizeProjectState(
            patchProjectWithSnapshot(
              {
                ...current,
                generated_artifacts: [result.artifact, ...current.generated_artifacts],
                artifact_count: current.artifact_count + 1,
              },
              result.project,
            ),
            {
              preserveHasChat: !chatLoaded,
            },
          ),
        );
        break;
      }
    }, ["Starter generatorjobben ..."]);
  }

  async function onSendChat(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const message = chatInput.trim();
    if (!message) {
      setError("Skriv en melding først.");
      return;
    }

    await runAction("chat", async () => {
      const response = await fetch(`/api/projects/${project.id}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message }),
      });

      if (!response.ok) {
        throw new Error(await readErrorResponse(response, "Kunne ikke sende chatmelding."));
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
        normalizeProjectState({
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
        }, {
          preserveArtifactCount: !artifactsLoaded,
        }),
      );
      setChatLoaded(true);
      setStreamingMessage("");
    });
  }

  const customerAnalysis = project.customer_analysis as CustomerAnalysisResult | null;
  const solutionEvaluation = project.solution_evaluation as SolutionEvaluationResult | null;

  return (
    <div className="min-h-[calc(100vh-3.5rem)] bg-[linear-gradient(180deg,_#f7fbff_0%,_#f4f7fb_100%)]">
      <div className="mx-auto flex w-full max-w-[1440px] flex-col gap-6 px-4 py-6 md:px-6 md:py-8">
        <section className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
          <Card className="border border-slate-200/80 bg-white/92 shadow-none">
            <CardHeader className="gap-4 border-b border-slate-200/80 pb-5">
              <div className="flex flex-wrap items-center gap-3">
                <Badge variant="outline" className="border-sky-200 bg-sky-50 text-sky-700">
                  {project.status}
                </Badge>
                {project.customer_name ? <Badge variant="outline">{project.customer_name}</Badge> : null}
                {project.industry ? <Badge variant="outline">{project.industry}</Badge> : null}
              </div>
              <div className="space-y-3">
                <CardTitle className="text-3xl font-semibold tracking-tight text-slate-950 md:text-5xl">
                  {project.name}
                </CardTitle>
                {project.description ? (
                  <CardDescription className="max-w-4xl text-base leading-8 text-slate-600 md:text-lg">
                    {project.description}
                  </CardDescription>
                ) : null}
              </div>
            </CardHeader>
            <CardContent className="grid gap-4 pt-5 md:grid-cols-2 xl:grid-cols-4">
              {summary.map((item) => (
                <div key={item.label} className="rounded-2xl border border-slate-200 bg-slate-50/80 p-4">
                  <p className="text-xs uppercase tracking-[0.18em] text-slate-500">{item.label}</p>
                  <p className="mt-3 text-lg font-semibold text-slate-950">{item.value}</p>
                </div>
              ))}
            </CardContent>
          </Card>

          <Card className="border border-slate-200/80 bg-[#0c172b] text-white shadow-none">
            <CardHeader className="border-b border-white/10 pb-4">
              <CardTitle className="text-xl font-semibold">Analyseoppsummering</CardTitle>
              <CardDescription className="text-sm leading-7 text-slate-300">
                Sist oppdatert {formatDate(project.last_activity_at)}. Dokumenter, analyser og generatorresultater holdes samlet her.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4 pt-5">
              <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
                <p className="text-sm text-slate-300">{project.documents.length} dokumenter lastet opp</p>
                <p className="mt-2 text-2xl font-semibold">{project.artifact_count} generatorutkast</p>
              </div>
              <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
                <p className="text-sm text-slate-300">{project.has_chat ? "Chatlogg tilgjengelig" : "Ingen chat ennå"}</p>
                <p className="mt-2 text-2xl font-semibold">{solutionEvaluation ? "Løsningsvurdering klar" : "Venter på vurdering"}</p>
              </div>
            </CardContent>
          </Card>
        </section>

        {error ? (
          <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
        ) : null}
        {!error && notice ? (
          <div className="rounded-2xl border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-800">{notice}</div>
        ) : null}
        {busyMessage && (busy === "evaluation" || busy === "artifact") ? (
          <div className="flex items-center gap-3 rounded-2xl border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-900">
            <LoaderCircle className="size-4 animate-spin text-sky-700" />
            <span>{busyMessage}</span>
          </div>
        ) : null}

        <Tabs defaultValue="documents" value={activeTab} onValueChange={setActiveTab} className="gap-5">
          <TabsList className="flex w-full flex-wrap justify-start gap-2 rounded-none border-b border-slate-200 bg-transparent p-0">
            <TabsTrigger value="documents" className="rounded-none px-0 py-3 text-base">
              Dokumenter
            </TabsTrigger>
            <TabsTrigger value="analysis" className="rounded-none px-0 py-3 text-base">
              Kundeanalyse
            </TabsTrigger>
            <TabsTrigger value="evaluation" className="rounded-none px-0 py-3 text-base">
              Løsningsvurdering
            </TabsTrigger>
            <TabsTrigger value="generator" className="rounded-none px-0 py-3 text-base">
              Generator
            </TabsTrigger>
            <TabsTrigger value="chat" className="rounded-none px-0 py-3 text-base">
              Chat
            </TabsTrigger>
          </TabsList>

          <TabsContent value="documents">
            <div className="grid gap-5 xl:grid-cols-[380px_minmax(0,1fr)]">
              <Card className="border border-slate-200/80 bg-white shadow-none">
                <CardHeader className="border-b border-slate-200/80 pb-4">
                  <CardTitle className="text-2xl font-semibold text-slate-950">Last opp dokument</CardTitle>
                  <CardDescription className="text-base leading-7 text-slate-600">
                    Velg alltid dokumentrolle eksplisitt. Kundedokument og løsningsdokument brukes i hver sin analyseflyt.
                  </CardDescription>
                </CardHeader>
                <CardContent className="pt-5">
                  <form onSubmit={onUploadDocument} className="grid gap-4">
                    <div className="grid gap-2">
                      <Label htmlFor="docTitle">Tittel</Label>
                      <Input
                        id="docTitle"
                        value={docTitle}
                        onChange={(event) => setDocTitle(event.target.value)}
                        placeholder="Visningsnavn i prosjektet"
                      />
                    </div>
                    <div className="grid gap-2">
                      <Label htmlFor="docRole">Dokumentrolle</Label>
                      <NativeSelect id="docRole" value={docRole} onChange={(event) => setDocRole(event.target.value as ProjectDocumentRole)}>
                        <NativeSelectOption value="primary_customer_document">Primært kundedokument</NativeSelectOption>
                        <NativeSelectOption value="primary_solution_document">Primært løsningsdokument</NativeSelectOption>
                        <NativeSelectOption value="supporting_document">Støttedokument</NativeSelectOption>
                      </NativeSelect>
                    </div>
                    {docRole === "supporting_document" ? (
                      <div className="grid gap-2">
                        <Label htmlFor="supportingSubtype">Undertype</Label>
                        <NativeSelect
                          id="supportingSubtype"
                          value={supportingSubtype}
                          onChange={(event) => setSupportingSubtype(event.target.value as SupportingDocumentSubtype)}
                        >
                          {SUPPORTING_SUBTYPES.map((item) => (
                            <NativeSelectOption key={item.value} value={item.value}>
                              {item.label}
                            </NativeSelectOption>
                          ))}
                        </NativeSelect>
                      </div>
                    ) : null}
                    <div className="grid gap-2">
                      <Label htmlFor="file">Fil</Label>
                      <Input
                        id="file"
                        type="file"
                        accept=".pdf,.docx,.txt,.md"
                        onChange={(event) => setFile(event.target.files?.[0] ?? null)}
                      />
                    </div>
                    <Button type="submit" size="lg" disabled={busy === "upload"}>
                      {busy === "upload" ? <LoaderCircle className="animate-spin" /> : <Upload />}
                      Last opp dokument
                    </Button>
                  </form>
                </CardContent>
              </Card>

              <Card className="border border-slate-200/80 bg-white shadow-none">
                <CardHeader className="border-b border-slate-200/80 pb-4">
                  <CardTitle className="text-2xl font-semibold text-slate-950">Dokumenter i prosjektet</CardTitle>
                  <CardDescription className="text-base leading-7 text-slate-600">
                    Hele prosjektminnet bygges av dokumentene her. Kundedokument og løsningsdokument holdes eksplisitt adskilt.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4 pt-5">
                  {project.documents.map((document) => (
                    <div key={document.id} className="rounded-2xl border border-slate-200 bg-slate-50/70 p-4">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="space-y-2">
                          <div className="flex flex-wrap items-center gap-2">
                            <h3 className="text-lg font-semibold text-slate-950">{document.title}</h3>
                            <Badge variant="outline">{roleLabel(document.role)}</Badge>
                            {document.role === "supporting_document" ? (
                              <Badge variant="outline">{supportingSubtypeLabel(document.supporting_subtype)}</Badge>
                            ) : null}
                          </div>
                          <p className="text-sm text-slate-500">
                            {document.file_name} · {document.file_format.toUpperCase()} · {Math.round(document.file_size_bytes / 1024)} KB
                          </p>
                          <p className="text-sm text-slate-500">Lastet opp {formatDate(document.created_at)}</p>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          <Button variant="outline" size="sm" render={<a href={`/api/projects/${project.id}/documents/${document.id}`} />}>
                            <ArrowDownToLine />
                            Last ned
                          </Button>
                          <Button
                            variant="destructive"
                            size="sm"
                            onClick={() => onDeleteDocument(document)}
                            disabled={busy === `delete-${document.id}`}
                          >
                            {busy === `delete-${document.id}` ? <LoaderCircle className="animate-spin" /> : <Trash2 />}
                            Slett
                          </Button>
                        </div>
                      </div>
                    </div>
                  ))}
                  {project.documents.length === 0 ? (
                    <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50/70 p-8 text-slate-600">
                      Ingen dokumenter lastet opp ennå.
                    </div>
                  ) : null}
                </CardContent>
              </Card>
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
    </div>
  );
}
