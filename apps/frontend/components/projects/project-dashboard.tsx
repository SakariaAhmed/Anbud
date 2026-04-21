"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowRight,
  BarChart3,
  FileText,
  FolderOpen,
  Plus,
  Search,
  Sparkles,
  UploadCloud,
} from "lucide-react";
import {
  useRef,
  useEffect,
  useState,
  type ChangeEvent,
  type DragEvent,
} from "react";

import {
  DECORATIVE_LOTTIES,
  DecorativeLottie,
} from "@/components/projects/decorative-lottie";
import type { ProjectSummary } from "@/lib/types";

type SpotlightUploadMode = "new_project" | "supporting_document";

function fileTitle(file: File) {
  return file.name.replace(/\.[^.]+$/, "");
}

async function uploadProjectDocument({
  projectId,
  file,
  role,
}: {
  projectId: string;
  file: File;
  role: "primary_customer_document" | "supporting_document";
}) {
  const formData = new FormData();
  formData.append("file", file);
  formData.append("title", fileTitle(file));
  formData.append("role", role);
  if (role === "supporting_document") {
    formData.append("supporting_subtype", "vedlegg");
  }

  const response = await fetch(`/api/projects/${projectId}/documents`, {
    method: "POST",
    body: formData,
  });
  const payload = (await response.json()) as { error?: string };
  if (!response.ok) {
    throw new Error(payload.error || "Kunne ikke laste opp dokumentet.");
  }
}

function statusColor(status: ProjectSummary["status"]) {
  switch (status) {
    case "Klar for sparring":
    case "Løsningsdokument lastet opp":
      return "text-blue-800 bg-blue-50 border-blue-200";
    case "Kundeanalyse klar":
      return "text-amber-800 bg-amber-50 border-amber-200";
    default:
      return "text-slate-600 bg-slate-50 border-slate-200";
  }
}

function statusDot(status: ProjectSummary["status"]) {
  switch (status) {
    case "Klar for sparring":
    case "Løsningsdokument lastet opp":
      return "bg-blue-500";
    case "Kundeanalyse klar":
      return "bg-amber-500";
    default:
      return "bg-slate-400";
  }
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("nb-NO", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function HomepageRefreshAnimation() {
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    const prefersReducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    const timeout = window.setTimeout(
      () => setVisible(false),
      prefersReducedMotion ? 550 : 1900,
    );

    return () => window.clearTimeout(timeout);
  }, []);

  if (!visible) return null;

  return (
    <div className="bidsite-refresh-loader" aria-hidden="true">
      <div className="bidsite-refresh-loader__grid" />
      <div className="bidsite-refresh-loader__mark">
        <span>b</span>
        <span>i</span>
        <span>d</span>
        <span>s</span>
        <span>i</span>
        <span>t</span>
        <span>e</span>
      </div>
      <div className="bidsite-refresh-loader__rule" />
    </div>
  );
}

export function ProjectDashboard({ projects }: { projects: ProjectSummary[] }) {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploadMode, setUploadMode] =
    useState<SpotlightUploadMode>("new_project");
  const [dragActive, setDragActive] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState("");
  const latestProject = projects[0] ?? null;

  const totals = {
    total: projects.length,
    analyses: projects.filter((p) => p.customer_analysis_generated).length,
    solutionDocs: projects.filter((p) => p.solution_document_uploaded).length,
    artifacts: projects.reduce((sum, p) => sum + p.artifact_count, 0),
  };

  const stats = [
    { label: "Totalt prosjekter", value: totals.total, icon: FolderOpen, accent: "border-t-blue-900" },
    { label: "Kundeanalyser", value: totals.analyses, icon: BarChart3, accent: "border-t-emerald-600" },
    { label: "Løsningsdokumenter", value: totals.solutionDocs, icon: FileText, accent: "border-t-amber-500" },
    { label: "Løsningsutkast", value: totals.artifacts, icon: Sparkles, accent: "border-t-violet-600" },
  ];

  async function handleSpotlightUpload(file: File | null) {
    if (!file || uploading) return;

    setUploadError("");
    setUploading(true);
    try {
      let projectId = latestProject?.id ?? "";

      if (uploadMode === "new_project" || !projectId) {
        const response = await fetch("/api/projects", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: fileTitle(file),
            customer_name: "",
            industry: "",
            description: "",
          }),
        });
        const payload = (await response.json()) as {
          id?: string;
          error?: string;
        };
        if (!response.ok || !payload.id) {
          throw new Error(payload.error || "Kunne ikke opprette prosjekt.");
        }
        projectId = payload.id;
        await uploadProjectDocument({
          projectId,
          file,
          role: "primary_customer_document",
        });
      } else {
        await uploadProjectDocument({
          projectId,
          file,
          role: "supporting_document",
        });
      }

      router.push(`/projects/${projectId}`);
    } catch (error) {
      setUploadError(
        error instanceof Error ? error.message : "Kunne ikke laste opp dokumentet.",
      );
      setUploading(false);
    }
  }

  function onDrop(event: DragEvent<HTMLButtonElement>) {
    event.preventDefault();
    setDragActive(false);
    void handleSpotlightUpload(event.dataTransfer.files?.[0] ?? null);
  }

  function onFileChange(event: ChangeEvent<HTMLInputElement>) {
    const selectedFile = event.target.files?.[0] ?? null;
    void handleSpotlightUpload(selectedFile);
    event.target.value = "";
  }

  return (
    <>
      <HomepageRefreshAnimation />
      <div className="mx-auto w-full max-w-6xl px-6 py-8 lg:px-8">
      {/* Page Header */}
      <section className="mb-8">
        <div className="flex items-end justify-between">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.15em] text-muted-foreground">
              Oversikt
            </p>
            <h1 className="mt-1 text-2xl font-bold tracking-tight text-foreground">
              Prosjektoversikt
            </h1>
            <p className="mt-1.5 max-w-xl text-sm text-muted-foreground">
              Administrer tilbudsprosjekter, kundeanalyser og løsningsutkast for teamet.
            </p>
          </div>
        </div>
      </section>

      {/* Creative Workbench Spotlight */}
      <section className="relative mb-8 overflow-hidden rounded-xl border border-blue-100/25 bg-slate-950/82 px-7 py-8 shadow-[0_24px_70px_rgba(15,23,42,0.22)] backdrop-blur-2xl">
        <div className="pointer-events-none absolute -left-16 -top-24 h-64 w-64 rounded-full bg-blue-500/18 blur-3xl" />
        <div className="pointer-events-none absolute left-[38%] top-[-6.5rem] h-56 w-56 rounded-full bg-slate-100/8 blur-3xl" />
        <div className="pointer-events-none absolute bottom-[-7rem] right-[-4rem] h-72 w-72 rounded-full bg-blue-950/42 blur-3xl" />
        <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(135deg,rgba(15,23,42,0.94)_0%,rgba(30,64,175,0.66)_54%,rgba(15,23,42,0.88)_100%)]" />
        <div className="pointer-events-none absolute inset-0 bg-white/[0.04] backdrop-blur-2xl" />
        <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(120deg,rgba(255,255,255,0.18),rgba(255,255,255,0.06)_30%,rgba(255,255,255,0.015)_62%,rgba(255,255,255,0.08))]" />
        <DecorativeLottie
          src={DECORATIVE_LOTTIES.dataOrbit}
          className="pointer-events-none absolute -bottom-8 left-[44%] hidden size-52 opacity-30 mix-blend-screen blur-[0.2px] lg:block"
        />
        <div className="pointer-events-none absolute inset-x-4 top-4 h-px bg-gradient-to-r from-transparent via-white/60 to-transparent" />
        <div className="pointer-events-none absolute inset-x-4 bottom-4 h-px bg-gradient-to-r from-transparent via-white/20 to-transparent" />
        <div className="relative grid gap-7 lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-end">
          <div className="max-w-3xl">
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-blue-100/80">
              Arbeidsflate
            </p>
            <h2 className="mt-3 text-3xl font-semibold tracking-tight text-slate-50 sm:text-4xl">
              <span className="text-slate-50">
                Tilbudsarbeidsflate
              </span>
            </h2>
            <p className="mt-4 max-w-2xl text-base leading-7 text-slate-100/90">
              Last opp kundedokumenter, analyser med AI, og generer profesjonelle
              løsningsutkast for teamet.
            </p>
            <div className="mt-7 flex flex-wrap items-center gap-3">
              <Link
                href="/projects/new"
                className="inline-flex h-10 items-center gap-2 rounded-md bg-white px-4 text-sm font-semibold text-slate-950 shadow-sm transition-transform hover:-translate-y-0.5 hover:bg-blue-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-200"
              >
                <Plus className="size-4" />
                Nytt prosjekt
              </Link>
              {latestProject ? (
                <Link
                  href={`/projects/${latestProject.id}`}
                  className="inline-flex h-10 items-center gap-2 rounded-md border border-white/20 bg-white/[0.08] px-4 text-sm font-semibold text-white backdrop-blur transition-colors hover:border-white/35 hover:bg-white/[0.13] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-200"
                >
                  Siste prosjekt
                  <ArrowRight className="size-4" />
                </Link>
              ) : null}
            </div>
          </div>

          <div className="relative overflow-hidden rounded-lg border border-white/20 bg-white/[0.08] p-3 shadow-sm backdrop-blur-md">
            <DecorativeLottie
              src={DECORATIVE_LOTTIES.documentFlight}
              className="pointer-events-none absolute -right-12 top-14 size-44 opacity-20 mix-blend-screen"
              speed={0.42}
            />
            <div className="mb-3 grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setUploadMode("new_project")}
                className={`h-8 rounded-md px-2 text-xs font-semibold transition-colors ${
                  uploadMode === "new_project"
                    ? "bg-white text-slate-950"
                    : "bg-white/[0.07] text-slate-100 hover:bg-white/[0.12]"
                }`}
              >
                Nytt prosjekt
              </button>
              <button
                type="button"
                disabled={!latestProject}
                onClick={() => setUploadMode("supporting_document")}
                className={`h-8 rounded-md px-2 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-45 ${
                  uploadMode === "supporting_document"
                    ? "bg-white text-slate-950"
                    : "bg-white/[0.07] text-slate-100 hover:bg-white/[0.12]"
                }`}
              >
                Støttedokument
              </button>
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept=".pdf,.docx,.txt,.md"
              className="sr-only"
              onChange={onFileChange}
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              onDragEnter={(event) => {
                event.preventDefault();
                setDragActive(true);
              }}
              onDragOver={(event) => {
                event.preventDefault();
                setDragActive(true);
              }}
              onDragLeave={() => setDragActive(false)}
              onDrop={onDrop}
              disabled={uploading}
              className={`relative z-10 flex min-h-36 w-full flex-col items-center justify-center rounded-lg border border-dashed px-4 py-5 text-center transition-colors disabled:cursor-wait ${
                dragActive
                  ? "border-white bg-white/[0.16]"
                  : "border-white/30 bg-slate-950/10 hover:bg-white/[0.10]"
              }`}
            >
              <UploadCloud className="size-7 text-blue-100" />
              <span className="mt-3 text-sm font-semibold text-white">
                {uploading ? "Laster opp ..." : "Slipp kundedokument her"}
              </span>
              <span className="mt-1 text-xs leading-5 text-slate-100/75">
                {uploadMode === "new_project"
                  ? "Oppretter prosjekt og lagrer som primært kundedokument."
                  : `Legges som støtte i ${latestProject?.name ?? "siste prosjekt"}.`}
              </span>
            </button>
            {uploadError ? (
              <p className="mt-3 rounded-md border border-red-200/40 bg-red-950/30 px-3 py-2 text-xs text-red-100">
                {uploadError}
              </p>
            ) : null}
          </div>
        </div>
      </section>

      {/* Stat Cards */}
      <section className="relative mb-8 grid grid-cols-2 gap-4 overflow-hidden sm:grid-cols-4">
        {stats.map((item) => (
          <div
            key={item.label}
            className={`relative rounded-md border border-border bg-card px-4 py-4 shadow-sm border-t-2 ${item.accent}`}
          >
            <div className="flex items-center justify-between">
              <item.icon className="size-4 text-muted-foreground" />
            </div>
            <p className="mt-3 text-2xl font-bold tabular-nums text-foreground">
              {item.value}
            </p>
            <p className="mt-0.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              {item.label}
            </p>
          </div>
        ))}
      </section>

      {/* Project Table */}
      <section className="overflow-hidden rounded-md border border-border bg-card shadow-sm">
        <div className="flex items-center justify-between border-b border-border bg-muted/50 px-5 py-3">
          <h2 className="text-[11px] font-bold uppercase tracking-[0.1em] text-foreground">
            Prosjekter
          </h2>
          <span className="text-xs text-muted-foreground">
            {projects.length} {projects.length === 1 ? "prosjekt" : "totalt"}
          </span>
        </div>

        {projects.length === 0 ? (
          <div className="py-16 text-center">
            <div className="mx-auto flex size-12 items-center justify-center rounded-md bg-muted">
              <Search className="size-5 text-muted-foreground" />
            </div>
            <p className="mt-4 text-sm font-semibold text-foreground">
              Ingen prosjekter ennå
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              Opprett et prosjekt og last opp kundedokumenter for å komme i gang.
            </p>
            <Link
              href="/projects/new"
              className="mt-5 inline-flex h-9 items-center gap-1.5 rounded-md bg-primary px-4 text-[13px] font-semibold text-primary-foreground shadow-sm transition-colors hover:bg-blue-800"
            >
              <Plus className="size-3.5" />
              Opprett prosjekt
            </Link>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead>
                <tr className="border-b-2 border-border bg-muted/30">
                  <th className="px-5 py-2.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                    Prosjekt
                  </th>
                  <th className="px-4 py-2.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                    Status
                  </th>
                  <th className="hidden px-4 py-2.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground sm:table-cell">
                    Dok.
                  </th>
                  <th className="hidden px-4 py-2.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground sm:table-cell">
                    Utkast
                  </th>
                  <th className="hidden px-4 py-2.5 text-right text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground md:table-cell">
                    Sist endret
                  </th>
                  <th className="px-4 py-2.5" />
                </tr>
              </thead>
              <tbody>
                {projects.map((project) => (
                  <tr
                    key={project.id}
                    className="group border-b border-border last:border-b-0 transition-colors hover:bg-slate-50"
                  >
                    <td className="px-5 py-3">
                      <Link href={`/projects/${project.id}`} className="block">
                        <p className="text-sm font-semibold text-foreground group-hover:text-primary">
                          {project.name}
                        </p>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          {project.customer_name || "Kunde ikke satt"}
                          {project.industry ? ` · ${project.industry}` : ""}
                        </p>
                      </Link>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center gap-1.5 rounded-sm border px-2 py-0.5 text-[11px] font-medium ${statusColor(project.status)}`}>
                        <span className={`inline-block size-1.5 rounded-full ${statusDot(project.status)}`} />
                        {project.status}
                      </span>
                    </td>
                    <td className="hidden px-4 py-3 text-sm tabular-nums text-muted-foreground sm:table-cell">
                      {project.document_count}
                    </td>
                    <td className="hidden px-4 py-3 text-sm tabular-nums text-muted-foreground sm:table-cell">
                      {project.artifact_count}
                    </td>
                    <td className="hidden px-4 py-3 text-right text-xs text-muted-foreground md:table-cell">
                      {formatDate(project.last_activity_at)}
                    </td>
                    <td className="px-4 py-3">
                      <Link
                        href={`/projects/${project.id}`}
                        className="text-xs font-medium text-primary opacity-0 transition-opacity group-hover:opacity-100"
                      >
                        Åpne <ArrowRight className="ml-1 inline size-3" />
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Workflow Steps */}
      <section className="mt-8 rounded-md border border-border bg-card p-6 shadow-sm">
        <h2 className="mb-4 text-[11px] font-bold uppercase tracking-[0.12em] text-muted-foreground">
          Arbeidsflyt
        </h2>
        <div className="flex items-start gap-4">
          {[
            { step: "1", title: "Last opp grunnlag", desc: "Primært kundedokument, løsningsdokument og støttekontekst." },
            { step: "2", title: "Analyser kunden", desc: "Generer kundeanalyse med krav, risiko og posisjonering." },
            { step: "3", title: "Generer utkast", desc: "Generer løsningsutkast basert på prosjektkonteksten." },
          ].map((item, i) => (
            <div key={item.step} className="flex flex-1 items-start gap-3">
              <div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground">
                {item.step}
              </div>
              <div className="min-w-0">
                <p className="text-sm font-semibold text-foreground">{item.title}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">{item.desc}</p>
              </div>
              {i < 2 ? <div className="mt-3.5 hidden h-px flex-1 bg-border lg:block" /> : null}
            </div>
          ))}
        </div>
      </section>
      </div>
    </>
  );
}
