"use client";

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createPortal } from "react-dom";
import {
  ArrowRight,
  CheckCircle2,
  FileText,
  Layers3,
  LockKeyhole,
  Plus,
  Search,
  SlidersHorizontal,
  Trash2,
  Upload,
  UploadCloud,
} from "lucide-react";
import {
  useRef,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  type ChangeEvent,
  type DragEvent,
  type FormEvent,
} from "react";

import { DeleteConfirmDialog } from "@/components/projects/delete-confirm-dialog";
import { consumeNextHomeNavigationWithoutAnimation } from "@/components/layout/app-header-logo";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import {
  clearClientCache,
  getClientCache,
  setClientCache,
} from "@/lib/client-cache";
import type {
  ProjectSummary,
  ServiceDescription,
  ServiceInclusionMode,
} from "@/lib/types";

function fileTitle(file: File) {
  return file.name.replace(/\.[^.]+$/, "");
}

const SERVICE_DESCRIPTIONS_CACHE_KEY = "service-descriptions";
const SERVICE_DESCRIPTIONS_CACHE_TTL_MS = 5 * 60 * 1000;
const HOME_INTRO_SEEN_KEY = "bidsite-home-intro-seen";
const PROJECT_PREFETCH_LIMIT = 12;
type ProjectStatusFilter = ProjectSummary["status"] | "Alle";
type ProjectSort = "recent" | "name" | "documents" | "artifacts";

async function uploadProjectDocument({
  projectId,
  file,
}: {
  projectId: string;
  file: File;
}) {
  const formData = new FormData();
  formData.append("file", file);
  formData.append("title", fileTitle(file));

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
    case "Dokument lastet opp":
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
    case "Dokument lastet opp":
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

function serviceModeLabel(mode: ServiceInclusionMode) {
  return mode === "fixed" ? "Fast for alle" : "Velges per prosjekt";
}

function nextProjectAction(project: ProjectSummary) {
  if (!project.customer_document_uploaded && project.document_count === 0) {
    return {
      label: "Last opp grunnlag",
      detail: "Kundedokument eller konkurransegrunnlag mangler.",
      tab: "documents",
    };
  }
  if (!project.customer_analysis_generated) {
    return {
      label: "Generer kundeanalyse",
      detail: "Bruk dokumentgrunnlaget til å finne krav og risiko.",
      tab: "analysis",
    };
  }
  if (!project.solution_document_uploaded) {
    return {
      label: "Lag løsningsbeskrivelse",
      detail: "Prosjektet er klart for utkast og videre bearbeiding.",
      tab: "generator",
    };
  }
  if (!project.solution_evaluation_generated) {
    return {
      label: "Vurder løsning",
      detail: "Sjekk treff mot kundebehov før leveranse.",
      tab: "evaluation",
    };
  }
  return {
    label: "Klargjør leveranse",
    detail: "Samle vurdering, fremdriftsplan og lederoppsummering.",
    tab: "delivery",
  };
}

function projectActionHref(project: ProjectSummary) {
  const action = nextProjectAction(project);
  return action.tab === "analysis"
    ? `/projects/${project.id}`
    : `/projects/${project.id}?tab=${action.tab}`;
}

function normalizeSearch(value: string) {
  return value.trim().toLocaleLowerCase("nb-NO");
}

export function GlobalServiceDescriptionsPanel() {
  const [services, setServices] = useState<ServiceDescription[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [targetServiceId, setTargetServiceId] = useState("");
  const [serviceName, setServiceName] = useState("");
  const [description, setDescription] = useState("");
  const [mode, setMode] = useState<ServiceInclusionMode>("selected");
  const [file, setFile] = useState<File | null>(null);
  const [fileInputKey, setFileInputKey] = useState(0);
  const [dragActive, setDragActive] = useState(false);

  async function loadServices() {
    const cached = getClientCache<ServiceDescription[]>(
      SERVICE_DESCRIPTIONS_CACHE_KEY,
    );
    if (cached) {
      setServices(cached);
      setLoading(false);
      setError("");
      return;
    }

    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/service-descriptions");
      const payload = (await response.json()) as {
        services?: ServiceDescription[];
        error?: string;
      };
      if (!response.ok || !payload.services) {
        throw new Error(payload.error || "Kunne ikke hente tjenestebeskrivelser.");
      }
      setServices(payload.services);
      setClientCache(
        SERVICE_DESCRIPTIONS_CACHE_KEY,
        payload.services,
        SERVICE_DESCRIPTIONS_CACHE_TTL_MS,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Kunne ikke hente tjenestebeskrivelser.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadServices();
  }, []);

  async function updateMode(service: ServiceDescription, nextMode: ServiceInclusionMode) {
    setBusy(`mode-${service.id}`);
    setError("");
    try {
      const response = await fetch(`/api/service-descriptions/${service.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ inclusion_mode: nextMode }),
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(payload.error || "Kunne ikke oppdatere tjenesten.");
      }
      clearClientCache(SERVICE_DESCRIPTIONS_CACHE_KEY);
      await loadServices();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Kunne ikke oppdatere tjenesten.");
    } finally {
      setBusy("");
    }
  }

  async function deleteDocument(serviceId: string, documentId: string) {
    setBusy(`delete-document-${documentId}`);
    setError("");
    try {
      const response = await fetch(
        `/api/service-descriptions/${serviceId}/documents/${documentId}`,
        { method: "DELETE" },
      );
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(payload.error || "Kunne ikke slette dokumentet.");
      }
      clearClientCache(SERVICE_DESCRIPTIONS_CACHE_KEY);
      await loadServices();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Kunne ikke slette dokumentet.");
    } finally {
      setBusy("");
    }
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!file && !serviceName.trim()) return;

    setBusy("upload");
    setError("");
    try {
      const formData = new FormData();
      if (file) {
        formData.append("file", file);
        formData.append("title", fileTitle(file));
      }
      formData.append("service_id", targetServiceId);
      formData.append(
        "name",
        targetServiceId
          ? services.find((service) => service.id === targetServiceId)?.name ?? serviceName
          : serviceName,
      );
      formData.append("description", description);
      formData.append("inclusion_mode", mode);

      const response = await fetch("/api/service-descriptions", {
        method: "POST",
        body: formData,
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(payload.error || "Kunne ikke lagre tjenestebeskrivelsen.");
      }
      clearClientCache(SERVICE_DESCRIPTIONS_CACHE_KEY);
      setTargetServiceId("");
      setServiceName("");
      setDescription("");
      setMode("selected");
      setFile(null);
      setFileInputKey((current) => current + 1);
      await loadServices();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Kunne ikke lagre tjenestebeskrivelsen.");
    } finally {
      setBusy("");
    }
  }

  return (
    <section className="mt-8 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-[0_18px_55px_rgba(15,23,42,0.08)]">
      <div className="grid gap-0 lg:grid-cols-[23rem_minmax(0,1fr)]">
        <div className="border-b border-slate-200 bg-slate-50/80 p-6 lg:border-b-0 lg:border-r">
          <div className="flex items-start gap-3">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-slate-950 text-white">
              <Layers3 className="size-5" />
            </span>
            <div>
              <p className="text-[10.5px] font-bold uppercase tracking-[0.16em] text-slate-500">
                Tjenestebeskrivelser
              </p>
              <h2 className="mt-1 text-lg font-bold text-slate-950">
                Global tjenestekatalog
              </h2>
              <p className="mt-2 text-sm leading-6 text-slate-600">
                Dokumenter her brukes som firmaets tjenestegrunnlag. Faste tjenester
                følger alle prosjekter, mens valgte tjenester må hukes av før de blir
                del av prosjektkonteksten.
              </p>
            </div>
          </div>

          <form onSubmit={onSubmit} className="mt-5 space-y-3">
            <select
              value={targetServiceId}
              onChange={(event) => {
                const value = event.target.value;
                setTargetServiceId(value);
                const service = services.find((item) => item.id === value);
                setServiceName(service?.name ?? "");
                setDescription(service?.description ?? "");
                setMode(service?.inclusion_mode ?? "selected");
              }}
              className="h-9 w-full rounded-md border border-slate-300 bg-white px-3 text-sm"
            >
              <option value="">Ny tjeneste</option>
              {services.map((service) => (
                <option key={service.id} value={service.id}>
                  {service.name}
                </option>
              ))}
            </select>

            <input
              value={serviceName}
              onChange={(event) => setServiceName(event.target.value)}
              placeholder="Tjenestenavn"
              className="h-9 w-full rounded-md border border-slate-300 bg-white px-3 text-sm"
            />
            <textarea
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="Kort beskrivelse av når tjenesten er relevant"
              rows={3}
              className="w-full resize-none rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
            />

            <div className="grid grid-cols-2 gap-2">
              {(["fixed", "selected"] as const).map((item) => (
                <button
                  key={item}
                  type="button"
                  onClick={() => setMode(item)}
                  className={`rounded-lg border px-3 py-2 text-xs font-bold ${
                    mode === item
                      ? "border-slate-950 bg-slate-950 text-white"
                      : "border-slate-200 bg-white text-slate-600"
                  }`}
                >
                  {serviceModeLabel(item)}
                </button>
              ))}
            </div>

            <label
              htmlFor="home-service-file"
              onDragEnter={(event) => {
                event.preventDefault();
                setDragActive(true);
              }}
              onDragOver={(event) => {
                event.preventDefault();
                event.dataTransfer.dropEffect = "copy";
                setDragActive(true);
              }}
              onDragLeave={() => setDragActive(false)}
              onDrop={(event) => {
                event.preventDefault();
                setDragActive(false);
                setFile(event.dataTransfer.files?.[0] ?? null);
              }}
              className={`flex cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed px-4 py-5 text-center ${
                dragActive
                  ? "border-slate-950 bg-slate-100"
                  : "border-slate-300 bg-white hover:border-blue-300 hover:bg-blue-50/40"
              }`}
            >
              <Upload className="size-5 text-blue-800" />
              <span className="mt-2 text-sm font-semibold text-slate-950">
                Legg til dokument
              </span>
              <span className="mt-1 max-w-full truncate text-xs text-slate-500">
                {file ? file.name : "PDF, DOCX, Excel, TXT eller MD"}
              </span>
            </label>
            <input
              key={fileInputKey}
              id="home-service-file"
              type="file"
              accept=".pdf,.docx,.xlsx,.xls,.txt,.md"
              className="sr-only"
              onChange={(event) => setFile(event.target.files?.[0] ?? null)}
            />

            <Button
              type="submit"
              className="h-10 w-full rounded-lg"
              disabled={busy === "upload" || (!file && !serviceName.trim())}
            >
              {busy === "upload" ? <Spinner className="size-4" /> : <Plus data-icon="inline-start" />}
              Lagre tjeneste
            </Button>
          </form>
        </div>

        <div className="min-w-0 p-6">
          {error ? (
            <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
              {error}
            </div>
          ) : null}

          <div className="mb-4 flex items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-bold text-slate-950">Alle tjenestedokumenter</h3>
              <p className="mt-1 text-sm text-slate-500">
                Prosjektsiden kan anbefale relevante valgbare tjenester uten å legge dem i kontekst før de er valgt.
              </p>
            </div>
            <div className="shrink-0 text-right">
              <p className="text-xl font-bold leading-none tracking-[-0.02em] text-slate-950">
                {services.reduce((sum, service) => sum + service.documents.length, 0)}
              </p>
              <p className="mt-1 text-[11px] font-bold uppercase tracking-[0.14em] text-slate-500">
                dokument
              </p>
            </div>
          </div>

          {loading ? (
            <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-5 text-sm text-slate-500">
              Laster tjenestekatalog ...
            </div>
          ) : services.length ? (
            <div className="divide-y divide-slate-200 rounded-lg border border-slate-200">
              {services.map((service) => (
                <div key={service.id} className="p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <h4 className="text-sm font-bold text-slate-950">{service.name}</h4>
                        <span className="inline-flex items-center gap-1 rounded-full border border-slate-200 px-2 py-0.5 text-[0.68rem] font-bold uppercase tracking-[0.12em] text-slate-500">
                          {service.inclusion_mode === "fixed" ? (
                            <LockKeyhole className="size-3" />
                          ) : (
                            <CheckCircle2 className="size-3" />
                          )}
                          {serviceModeLabel(service.inclusion_mode)}
                        </span>
                      </div>
                      {service.description ? (
                        <p className="mt-1 text-sm leading-6 text-slate-500">
                          {service.description}
                        </p>
                      ) : null}
                    </div>
                    <select
                      value={service.inclusion_mode}
                      disabled={busy === `mode-${service.id}`}
                      onChange={(event) =>
                        void updateMode(service, event.target.value as ServiceInclusionMode)
                      }
                      className="h-8 rounded-md border border-slate-200 bg-white px-2 text-xs font-semibold"
                    >
                      <option value="fixed">Fast for alle</option>
                      <option value="selected">Velges per prosjekt</option>
                    </select>
                  </div>

                  <div className="mt-3 grid gap-2">
                    {service.documents.length ? (
                      service.documents.map((document) => (
                        <div
                          key={document.id}
                          className="flex items-center justify-between gap-3 rounded-lg bg-slate-50 px-3 py-2"
                        >
                          <div className="flex min-w-0 items-start gap-2">
                            <FileText className="size-4 shrink-0 text-blue-800" />
                            <span className="break-words text-sm font-medium leading-5 text-slate-700">
                              {document.title}
                            </span>
                          </div>
                          <DeleteConfirmDialog
                            title="Slett tjenestedokument?"
                            description={`Dette fjerner "${document.title}" fra tjenestebeskrivelsen. Handlingen kan ikke angres.`}
                            confirmLabel="Slett dokument"
                            onConfirm={() => deleteDocument(service.id, document.id)}
                          >
                            <Button
                              variant="ghost"
                              size="icon-xs"
                              disabled={busy === `delete-document-${document.id}`}
                            >
                              {busy === `delete-document-${document.id}` ? (
                                <Spinner className="size-3.5" />
                              ) : (
                                <Trash2 className="size-3.5" />
                              )}
                            </Button>
                          </DeleteConfirmDialog>
                        </div>
                      ))
                    ) : (
                      <p className="rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-500">
                        Ingen dokumenter lagt til ennå.
                      </p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 px-4 py-10 text-center">
              <FileText className="mx-auto size-8 text-slate-400" />
              <p className="mt-3 text-sm font-semibold text-slate-950">
                Ingen tjenestebeskrivelser ennå
              </p>
              <p className="mt-1 text-sm text-slate-500">
                Opprett første tjeneste og legg dokumentene under den.
              </p>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

const refreshEase = [0.76, 0, 0.24, 1] as const;

function HomepageRefreshAnimation() {
  const reduceMotion = useReducedMotion();
  const skipAnimationRef = useRef(false);
  const markRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(true);
  const [completed, setCompleted] = useState(false);
  const [phase, setPhase] = useState<"intro" | "reveal" | "move" | "settled">(
    "intro",
  );
  const [metricsReady, setMetricsReady] = useState(false);
  const [markMetrics, setMarkMetrics] = useState({
    startCollapsedX: 0,
    startX: 0,
    startY: 0,
    targetX: 0,
    targetY: 0,
    startCollapsedWidth: 0,
    startWidth: 0,
    targetWidth: 0,
    startFontSize: 88,
    targetFontSize: 21,
    startLineHeight: 82,
    targetLineHeight: 20,
    startLetterSpacing: -5.2,
    targetLetterSpacing: -1.2,
    startGap: 33,
    targetGap: 8.8,
    startIconWidth: 70,
    targetIconWidth: 16.32,
  });

  useLayoutEffect(() => {
    let hasSeenIntro = false;
    try {
      hasSeenIntro = window.sessionStorage.getItem(HOME_INTRO_SEEN_KEY) === "1";
      window.sessionStorage.setItem(HOME_INTRO_SEEN_KEY, "1");
    } catch {
      hasSeenIntro = false;
    }

    if (hasSeenIntro || consumeNextHomeNavigationWithoutAnimation()) {
      skipAnimationRef.current = true;
      setVisible(false);
      setCompleted(true);
      setPhase("settled");
      setMetricsReady(true);
    }
  }, []);

  useLayoutEffect(() => {
    if (skipAnimationRef.current) {
      document.body.dataset.homeLoader = "done";
      return () => {
        delete document.body.dataset.homeLoader;
      };
    }

    const phaseValue = completed
      ? "done"
      : visible
        ? metricsReady
          ? phase
          : "boot"
        : "settled";

    document.body.dataset.homeLoader = phaseValue;

    return () => {
      delete document.body.dataset.homeLoader;
    };
  }, [completed, metricsReady, phase, visible]);

  useLayoutEffect(() => {
    if (skipAnimationRef.current || !visible) return;

    const updateHandoffTransform = () => {
      const anchor = document.querySelector<HTMLElement>("[data-brand-anchor='true']");
      if (!anchor) return;
      const anchorIcon = anchor.querySelector<HTMLElement>(".brand-logo__mark");
      const anchorWord = anchor.querySelector<HTMLElement>(".brand-logo__wordmark");

      const anchorRect = anchor.getBoundingClientRect();
      const anchorStyle = window.getComputedStyle(anchor);
      const widthBuffer = 6;
      const targetWidth = Math.max(anchorRect.width, anchor.scrollWidth) + widthBuffer;
      const targetFontSize = Number.parseFloat(anchorStyle.fontSize) || 21;
      const targetGapRaw = Number.parseFloat(anchorStyle.gap);
      const iconRect = anchorIcon?.getBoundingClientRect();
      const wordRect = anchorWord?.getBoundingClientRect();
      const measuredGap =
        iconRect && wordRect ? Math.max(0, wordRect.left - iconRect.right) : Number.NaN;
      const targetGap = Number.isFinite(measuredGap)
        ? measuredGap
        : Number.isFinite(targetGapRaw)
          ? targetGapRaw
          : 8.8;
      const targetLetterSpacing =
        Number.parseFloat(anchorStyle.letterSpacing) || targetFontSize * -0.06;
      const targetLineHeightRaw = Number.parseFloat(anchorStyle.lineHeight);
      const targetLineHeight = Number.isFinite(targetLineHeightRaw)
        ? targetLineHeightRaw
        : targetFontSize * 0.92;
      const targetIconWidth = anchorIcon?.getBoundingClientRect().width || 16.32;

      const startFontSize = reduceMotion
        ? targetFontSize
        : Math.max(targetFontSize * 3.8, Math.min(window.innerWidth * 0.108, 112));
      const scaleRatio = startFontSize / targetFontSize;
      const startLineHeight = targetLineHeight * scaleRatio;
      const startLetterSpacing = targetLetterSpacing * scaleRatio;
      const startGap = targetGap * scaleRatio;
      const startIconWidth = targetIconWidth * scaleRatio;
      const startWidth = targetWidth * scaleRatio;
      const startCollapsedWidth = Math.max(startFontSize * 0.84, 58);
      const startCollapsedX = window.innerWidth / 2 - startCollapsedWidth / 2;
      const startX = window.innerWidth / 2 - startWidth / 2;
      const startY = window.innerHeight / 2 - startLineHeight / 2;
      const targetX = anchorRect.left;
      const targetY = anchorRect.top + (anchorRect.height - targetLineHeight) / 2;

      setMarkMetrics({
        startCollapsedX,
        startX,
        startY,
        targetX,
        targetY,
        startCollapsedWidth,
        startWidth,
        targetWidth,
        startFontSize,
        targetFontSize,
        startLineHeight,
        targetLineHeight,
        startLetterSpacing,
        targetLetterSpacing,
        startGap,
        targetGap,
        startIconWidth,
        targetIconWidth,
      });
      setMetricsReady(true);
    };

    updateHandoffTransform();
    window.addEventListener("resize", updateHandoffTransform);

    return () => {
      window.removeEventListener("resize", updateHandoffTransform);
    };
  }, [reduceMotion, visible]);

  useEffect(() => {
    if (skipAnimationRef.current || !visible) return;

    setCompleted(false);

    const revealTimeout = window.setTimeout(
      () => setPhase("reveal"),
      reduceMotion ? 120 : 620,
    );
    const moveTimeout = window.setTimeout(
      () => setPhase("move"),
      reduceMotion ? 240 : 1260,
    );
    const settledTimeout = window.setTimeout(
      () => setPhase("settled"),
      reduceMotion ? 500 : 2280,
    );
    const hideTimeout = window.setTimeout(
      () => setVisible(false),
      reduceMotion ? 620 : 2390,
    );

    return () => {
      window.clearTimeout(revealTimeout);
      window.clearTimeout(moveTimeout);
      window.clearTimeout(settledTimeout);
      window.clearTimeout(hideTimeout);
    };
  }, [reduceMotion, visible]);

  if (typeof document === "undefined") {
    return null;
  }

  return createPortal(
    <AnimatePresence onExitComplete={() => setCompleted(true)}>
      {visible && metricsReady ? (
        <motion.div
          aria-hidden="true"
          className="bidsite-refresh-loader"
          initial={{ opacity: 1 }}
          animate={{ opacity: 1 }}
          exit={{
            opacity: 0,
            transition: {
              delay: 0,
              duration: reduceMotion ? 0.1 : 0.16,
              ease: "easeOut",
            },
          }}
        >
          <motion.div
            className="bidsite-refresh-loader__halo"
            initial={{ opacity: 0, scale: reduceMotion ? 1 : 0.82 }}
            animate={
              phase === "intro"
                ? {
                    opacity: 1,
                    scale: 1,
                    transition: {
                      duration: reduceMotion ? 0.2 : 0.78,
                      ease: [0.16, 1, 0.3, 1],
                    },
                  }
                : {
                    opacity: 0,
                    scale: reduceMotion ? 1 : 1.18,
                    transition: {
                      duration: reduceMotion ? 0.14 : 0.52,
                      ease: [0.7, 0, 0.84, 0],
                    },
                  }
            }
          />
          <motion.div
            className="bidsite-refresh-loader__sheet bidsite-refresh-loader__sheet--base"
            initial={{ scale: reduceMotion ? 1 : 1.06 }}
            animate={{
              scale: 1,
              transition: {
                duration: reduceMotion ? 0.18 : 0.86,
                ease: [0.16, 1, 0.3, 1],
              },
            }}
          />
          <motion.div
            className="bidsite-refresh-loader__sheet bidsite-refresh-loader__sheet--wash"
            initial={{ opacity: 0.88 }}
            animate={{
              opacity: phase === "intro" ? 1 : phase === "move" ? 0.96 : 0.92,
              transition: {
                duration: reduceMotion ? 0.14 : 0.42,
                ease: [0.16, 1, 0.3, 1],
              },
            }}
          />
          {/* Glowing orbs — matching hero section ambient light */}
          <motion.div
            className="bidsite-refresh-loader__orb"
            style={{
              left: "30%",
              top: "25%",
              width: "min(26rem, 58vw)",
              height: "min(26rem, 58vw)",
              background:
                "radial-gradient(circle, rgba(59,130,246,0.22) 0%, transparent 70%)",
            }}
            initial={{ opacity: 0, scale: reduceMotion ? 1 : 2.2 }}
            animate={
              phase === "intro"
                ? {
                    opacity: reduceMotion ? 0.4 : 0.85,
                    scale: reduceMotion ? 1 : 1.4,
                    transition: {
                      duration: reduceMotion ? 0.2 : 0.9,
                      delay: 0.05,
                      ease: [0.16, 1, 0.3, 1],
                    },
                  }
                : phase === "move"
                  ? {
                      opacity: reduceMotion ? 0.2 : 0.5,
                      scale: 1,
                      x: reduceMotion ? 0 : -90,
                      y: reduceMotion ? 0 : -50,
                      transition: {
                        duration: reduceMotion ? 0.16 : 0.85,
                        ease: refreshEase,
                      },
                    }
                  : {
                      opacity: reduceMotion ? 0.08 : 0.18,
                      scale: 0.9,
                      transition: {
                        duration: reduceMotion ? 0.12 : 0.4,
                      },
                    }
            }
          />
          <motion.div
            className="bidsite-refresh-loader__orb"
            style={{
              left: "52%",
              top: "18%",
              width: "min(20rem, 44vw)",
              height: "min(20rem, 44vw)",
              background:
                "radial-gradient(circle, rgba(241,245,249,0.09) 0%, transparent 70%)",
            }}
            initial={{ opacity: 0, scale: reduceMotion ? 1 : 1.8 }}
            animate={
              phase === "intro"
                ? {
                    opacity: reduceMotion ? 0.3 : 0.65,
                    scale: reduceMotion ? 1 : 1.2,
                    transition: {
                      duration: reduceMotion ? 0.18 : 0.85,
                      delay: 0.1,
                      ease: [0.16, 1, 0.3, 1],
                    },
                  }
                : phase === "move"
                  ? {
                      opacity: reduceMotion ? 0.15 : 0.35,
                      scale: 1,
                      x: reduceMotion ? 0 : 30,
                      y: reduceMotion ? 0 : -40,
                      transition: {
                        duration: reduceMotion ? 0.14 : 0.8,
                        ease: refreshEase,
                      },
                    }
                  : {
                      opacity: reduceMotion ? 0.04 : 0.08,
                      transition: {
                        duration: reduceMotion ? 0.1 : 0.4,
                      },
                    }
            }
          />
          <motion.div
            className="bidsite-refresh-loader__orb"
            style={{
              right: "8%",
              bottom: "12%",
              width: "min(22rem, 50vw)",
              height: "min(22rem, 50vw)",
              background:
                "radial-gradient(circle, rgba(30,58,138,0.38) 0%, transparent 70%)",
            }}
            initial={{ opacity: 0, scale: reduceMotion ? 1 : 1.6 }}
            animate={
              phase === "intro"
                ? {
                    opacity: reduceMotion ? 0.3 : 0.7,
                    scale: reduceMotion ? 1 : 1.3,
                    transition: {
                      duration: reduceMotion ? 0.2 : 0.92,
                      delay: 0.08,
                      ease: [0.16, 1, 0.3, 1],
                    },
                  }
                : phase === "move"
                  ? {
                      opacity: reduceMotion ? 0.15 : 0.4,
                      scale: 1,
                      x: reduceMotion ? 0 : 50,
                      y: reduceMotion ? 0 : 30,
                      transition: {
                        duration: reduceMotion ? 0.14 : 0.85,
                        ease: refreshEase,
                      },
                    }
                  : {
                      opacity: reduceMotion ? 0.1 : 0.25,
                      transition: {
                        duration: reduceMotion ? 0.1 : 0.4,
                      },
                    }
            }
          />

          {/* Vector — Document stack (filled, matching hero) */}
          <motion.div
            className="bidsite-refresh-loader__vector"
            style={{ right: "14%", top: "18%" }}
            initial={{
              opacity: 0,
              scale: reduceMotion ? 1 : 0.6,
              rotate: reduceMotion ? 0 : -12,
            }}
            animate={
              phase === "intro"
                ? {
                    opacity: reduceMotion ? 0.3 : 0.72,
                    scale: 1,
                    rotate: -3,
                    transition: {
                      duration: reduceMotion ? 0.2 : 0.95,
                      delay: 0.14,
                      ease: [0.16, 1, 0.3, 1],
                    },
                  }
                : phase === "move"
                  ? {
                      opacity: reduceMotion ? 0.18 : 0.4,
                      scale: reduceMotion ? 1 : 0.8,
                      rotate: -1,
                      y: reduceMotion ? 0 : -40,
                      x: reduceMotion ? 0 : 25,
                      transition: {
                        duration: reduceMotion ? 0.14 : 0.85,
                        ease: refreshEase,
                      },
                    }
                  : {
                      opacity: reduceMotion ? 0.12 : 0.2,
                      scale: reduceMotion ? 1 : 0.78,
                      rotate: 0,
                      transition: {
                        duration: reduceMotion ? 0.1 : 0.4,
                      },
                    }
            }
          >
            <svg
              width="110"
              height="120"
              viewBox="0 0 110 120"
              fill="none"
            >
              {/* Back page — rotated */}
              <rect
                x="32"
                y="8"
                width="56"
                height="72"
                rx="4"
                fill="rgba(59,130,246,0.12)"
                stroke="rgba(147,197,253,0.45)"
                strokeWidth="1.2"
                transform="rotate(6 60 44)"
              />
              {/* Front page */}
              <rect
                x="18"
                y="16"
                width="56"
                height="72"
                rx="4"
                fill="rgba(59,130,246,0.22)"
                stroke="rgba(147,197,253,0.7)"
                strokeWidth="1.4"
              />
              {/* Folded corner */}
              <path
                d="M58 16v14a2 2 0 002 2h14"
                stroke="rgba(147,197,253,0.55)"
                strokeWidth="1.2"
              />
              <path
                d="M58 16l16 16"
                stroke="rgba(147,197,253,0.15)"
                strokeWidth="1"
              />
              {/* Text lines */}
              <line
                x1="28"
                y1="44"
                x2="62"
                y2="44"
                stroke="rgba(147,197,253,0.5)"
                strokeWidth="1.2"
                strokeLinecap="round"
              />
              <line
                x1="28"
                y1="54"
                x2="56"
                y2="54"
                stroke="rgba(147,197,253,0.4)"
                strokeWidth="1.2"
                strokeLinecap="round"
              />
              <line
                x1="28"
                y1="64"
                x2="58"
                y2="64"
                stroke="rgba(147,197,253,0.35)"
                strokeWidth="1.2"
                strokeLinecap="round"
              />
              <line
                x1="28"
                y1="74"
                x2="44"
                y2="74"
                stroke="rgba(147,197,253,0.25)"
                strokeWidth="1.2"
                strokeLinecap="round"
              />
            </svg>
          </motion.div>

          {/* Vector — Data orbit (bolder rings + nodes) */}
          <motion.div
            className="bidsite-refresh-loader__vector"
            style={{ left: "8%", bottom: "14%" }}
            initial={{
              opacity: 0,
              scale: reduceMotion ? 1 : 0.5,
              rotate: reduceMotion ? 0 : 15,
            }}
            animate={
              phase === "intro"
                ? {
                    opacity: reduceMotion ? 0.2 : 0.55,
                    scale: 1,
                    rotate: 0,
                    transition: {
                      duration: reduceMotion ? 0.2 : 1,
                      delay: 0.18,
                      ease: [0.16, 1, 0.3, 1],
                    },
                  }
                : phase === "move"
                  ? {
                      opacity: reduceMotion ? 0.12 : 0.3,
                      scale: reduceMotion ? 1 : 0.85,
                      y: reduceMotion ? 0 : -30,
                      x: reduceMotion ? 0 : -10,
                      transition: {
                        duration: reduceMotion ? 0.14 : 0.85,
                        ease: refreshEase,
                      },
                    }
                  : {
                      opacity: reduceMotion ? 0.08 : 0.18,
                      transition: {
                        duration: reduceMotion ? 0.1 : 0.4,
                      },
                    }
            }
          >
            <svg
              width="180"
              height="180"
              viewBox="0 0 200 200"
              fill="none"
            >
              {/* Inner ring */}
              <circle
                cx="100"
                cy="100"
                r="42"
                stroke="rgba(147,197,253,0.4)"
                strokeWidth="1.2"
              />
              {/* Middle ring — dashed */}
              <circle
                cx="100"
                cy="100"
                r="70"
                stroke="rgba(147,197,253,0.3)"
                strokeWidth="1"
                strokeDasharray="4 4"
              />
              {/* Outer ring — dotted */}
              <circle
                cx="100"
                cy="100"
                r="92"
                stroke="rgba(147,197,253,0.18)"
                strokeWidth="0.8"
                strokeDasharray="2 6"
              />
              {/* Orbital nodes */}
              <circle
                cx="142"
                cy="100"
                r="5"
                fill="rgba(96,165,250,0.55)"
                stroke="rgba(147,197,253,0.6)"
                strokeWidth="1"
              />
              <circle
                cx="100"
                cy="58"
                r="3.5"
                fill="rgba(96,165,250,0.45)"
                stroke="rgba(147,197,253,0.5)"
                strokeWidth="0.8"
              />
              <circle
                cx="38"
                cy="128"
                r="3"
                fill="rgba(96,165,250,0.35)"
                stroke="rgba(147,197,253,0.4)"
                strokeWidth="0.8"
              />
              {/* Center dot */}
              <circle
                cx="100"
                cy="100"
                r="3"
                fill="rgba(147,197,253,0.5)"
              />
              {/* Outer ring node */}
              <circle
                cx="172"
                cy="118"
                r="2.5"
                fill="rgba(96,165,250,0.3)"
                stroke="rgba(147,197,253,0.35)"
                strokeWidth="0.7"
              />
            </svg>
          </motion.div>

          {/* Vector — Cloud upload (filled, matching hero card) */}
          <motion.div
            className="bidsite-refresh-loader__vector"
            style={{ right: "12%", bottom: "22%" }}
            initial={{
              opacity: 0,
              scale: reduceMotion ? 1 : 0.65,
              y: reduceMotion ? 0 : 24,
            }}
            animate={
              phase === "intro"
                ? {
                    opacity: reduceMotion ? 0.2 : 0.55,
                    scale: 1,
                    y: 0,
                    transition: {
                      duration: reduceMotion ? 0.18 : 0.92,
                      delay: 0.22,
                      ease: [0.16, 1, 0.3, 1],
                    },
                  }
                : phase === "move"
                  ? {
                      opacity: reduceMotion ? 0.1 : 0.3,
                      scale: reduceMotion ? 1 : 0.88,
                      y: reduceMotion ? 0 : -25,
                      x: reduceMotion ? 0 : 18,
                      transition: {
                        duration: reduceMotion ? 0.14 : 0.8,
                        ease: refreshEase,
                      },
                    }
                  : {
                      opacity: reduceMotion ? 0.06 : 0.15,
                      transition: {
                        duration: reduceMotion ? 0.1 : 0.35,
                      },
                    }
            }
          >
            <svg
              width="96"
              height="82"
              viewBox="0 0 96 82"
              fill="none"
            >
              {/* Cloud body */}
              <path
                d="M24 58c-8.3 0-15-6.7-15-15 0-6.8 4.6-12.6 10.9-14.3C22 19.5 30.6 12 41 12c12.5 0 22.7 9.4 23.8 21.5h1.2C74.3 33.5 81 40.2 81 48.5S74.3 63.5 66 63.5H24z"
                fill="rgba(59,130,246,0.16)"
                stroke="rgba(147,197,253,0.65)"
                strokeWidth="1.4"
              />
              {/* Upload arrow */}
              <path
                d="M48 36v18M40 44l8-8 8 8"
                stroke="rgba(191,219,254,0.8)"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </motion.div>

          {/* Floating particles */}
          {[
            { left: "22%", top: "40%", s: 3.5, d: 0.2 },
            { left: "72%", top: "30%", s: 3, d: 0.26 },
            { left: "44%", top: "72%", s: 2.5, d: 0.3 },
            { left: "82%", top: "52%", s: 3, d: 0.24 },
            { left: "12%", top: "58%", s: 2, d: 0.32 },
            { left: "56%", top: "62%", s: 2, d: 0.28 },
          ].map((p, i) => (
            <motion.div
              key={i}
              className="bidsite-refresh-loader__particle"
              style={{
                left: p.left,
                top: p.top,
                width: p.s,
                height: p.s,
              }}
              initial={{ opacity: 0, scale: 0 }}
              animate={
                phase === "intro"
                  ? {
                      opacity: reduceMotion ? 0.25 : 0.6,
                      scale: 1,
                      transition: {
                        duration: reduceMotion ? 0.14 : 0.5,
                        delay: p.d,
                      },
                    }
                  : phase === "move"
                    ? {
                        opacity: reduceMotion ? 0.12 : 0.32,
                        scale: 0.7,
                        transition: {
                          duration: reduceMotion ? 0.12 : 0.6,
                          ease: refreshEase,
                        },
                      }
                    : {
                        opacity: reduceMotion ? 0.05 : 0.12,
                        scale: 0.5,
                        transition: {
                          duration: reduceMotion ? 0.08 : 0.3,
                        },
                      }
              }
            />
          ))}

          {/* Top edge highlight */}
          <motion.div
            className="bidsite-refresh-loader__edge-line"
            initial={{ opacity: 0, scaleX: 0.2 }}
            animate={
              phase === "intro"
                ? {
                    opacity: reduceMotion ? 0.35 : 0.75,
                    scaleX: 1,
                    transition: {
                      duration: reduceMotion ? 0.18 : 0.82,
                      delay: 0.12,
                      ease: [0.16, 1, 0.3, 1],
                    },
                  }
                : phase === "move"
                  ? {
                      opacity: reduceMotion ? 0.2 : 0.45,
                      scaleX: 0.5,
                      transition: {
                        duration: reduceMotion ? 0.14 : 0.65,
                        ease: refreshEase,
                      },
                    }
                  : {
                      opacity: reduceMotion ? 0.08 : 0.18,
                      scaleX: 0.35,
                      transition: {
                        duration: reduceMotion ? 0.1 : 0.35,
                      },
                    }
            }
          />
          <div className="bidsite-refresh-loader__center">
            <motion.div
              ref={markRef}
              className="bidsite-refresh-loader__mark"
              initial={{
                opacity: 0,
                left: markMetrics.startCollapsedX,
                top: markMetrics.startY + (reduceMotion ? 0 : 26),
                width: markMetrics.startCollapsedWidth,
                fontSize: `${markMetrics.startFontSize}px`,
                lineHeight: `${markMetrics.startLineHeight}px`,
                letterSpacing: `${markMetrics.startLetterSpacing}px`,
                filter: reduceMotion ? "none" : "blur(12px)",
              }}
              animate={
                phase === "intro"
                  ? {
                      opacity: 1,
                      left: markMetrics.startCollapsedX,
                      top: markMetrics.startY,
                      width: markMetrics.startCollapsedWidth,
                      fontSize: `${markMetrics.startFontSize}px`,
                      lineHeight: `${markMetrics.startLineHeight}px`,
                      letterSpacing: `${markMetrics.startLetterSpacing}px`,
                      filter: "blur(0px)",
                      transition: {
                        duration: reduceMotion ? 0.22 : 0.82,
                        delay: 0.08,
                        ease: [0.16, 1, 0.3, 1],
                      },
                    }
                  : phase === "reveal"
                    ? {
                        opacity: 1,
                        left: markMetrics.startX,
                        top: markMetrics.startY,
                        width: markMetrics.startWidth,
                        fontSize: `${markMetrics.startFontSize}px`,
                        lineHeight: `${markMetrics.startLineHeight}px`,
                        letterSpacing: `${markMetrics.startLetterSpacing}px`,
                        filter: "blur(0px)",
                        transition: {
                          duration: reduceMotion ? 0.18 : 0.56,
                          ease: [0.16, 1, 0.3, 1],
                        },
                      }
                  : phase === "move"
                    ? {
                        opacity: 1,
                        left: markMetrics.targetX,
                        top: markMetrics.targetY,
                        width: markMetrics.targetWidth,
                        fontSize: `${markMetrics.targetFontSize}px`,
                        lineHeight: `${markMetrics.targetLineHeight}px`,
                        letterSpacing: `${markMetrics.targetLetterSpacing}px`,
                        filter: "blur(0px)",
                        transition: {
                          duration: reduceMotion ? 0.2 : 0.9,
                          delay: reduceMotion ? 0.02 : 0.08,
                          ease: refreshEase,
                        },
                      }
                    : {
                      opacity: 1,
                      left: markMetrics.targetX,
                      top: markMetrics.targetY,
                      width: markMetrics.targetWidth,
                      fontSize: `${markMetrics.targetFontSize}px`,
                      lineHeight: `${markMetrics.targetLineHeight}px`,
                      letterSpacing: `${markMetrics.targetLetterSpacing}px`,
                      filter: "blur(0px)",
                      transition: {
                        left: {
                          duration: 0,
                        },
                        top: {
                          duration: 0,
                        },
                        width: {
                          duration: 0,
                        },
                        fontSize: {
                          duration: 0,
                        },
                        lineHeight: {
                          duration: 0,
                        },
                        letterSpacing: {
                          duration: 0,
                        },
                        filter: {
                          duration: 0,
                        },
                      },
                    }
              }
              exit={{
                opacity: 0,
                transition: {
                  duration: 0,
                  },
              }}
            >
              <motion.span
                className="bidsite-refresh-loader__mark-shell"
                initial={false}
              >
                <motion.img
                  src="/bidsite-logo.png"
                  alt=""
                  aria-hidden="true"
                  className="bidsite-refresh-loader__mark-icon"
                  initial={{
                    opacity: 0,
                    scale: reduceMotion ? 1 : 0.74,
                    rotate: reduceMotion ? 0 : -10,
                  }}
                  animate={
                    phase === "intro"
                      ? {
                          opacity: 1,
                          scale: 1,
                          rotate: 0,
                          width: markMetrics.startIconWidth,
                          transition: {
                            duration: reduceMotion ? 0.18 : 0.52,
                            delay: reduceMotion ? 0 : 0.04,
                            ease: [0.16, 1, 0.3, 1],
                          },
                        }
                      : phase === "reveal"
                        ? {
                            opacity: 1,
                            scale: 1,
                            rotate: 0,
                            width: markMetrics.startIconWidth,
                            transition: {
                              duration: reduceMotion ? 0.14 : 0.32,
                              ease: [0.16, 1, 0.3, 1],
                            },
                          }
                        : {
                            opacity: 1,
                            scale: 1,
                            rotate: 0,
                            width: markMetrics.targetIconWidth,
                            transition: {
                              duration:
                                phase === "move"
                                  ? reduceMotion
                                    ? 0.2
                                    : 0.9
                                  : reduceMotion
                                    ? 0.12
                                    : 0.24,
                              delay: phase === "move" ? (reduceMotion ? 0.02 : 0.08) : 0,
                              ease: refreshEase,
                            },
                          }
                  }
                />
                <motion.span
                  className="bidsite-refresh-loader__word-reveal"
                  initial={false}
                  animate={{
                    marginLeft:
                      phase === "intro" || phase === "reveal"
                        ? markMetrics.startGap
                        : markMetrics.targetGap,
                  }}
                  transition={
                    phase === "move"
                      ? {
                          duration: reduceMotion ? 0.2 : 0.9,
                          delay: reduceMotion ? 0.02 : 0.08,
                          ease: refreshEase,
                        }
                      : phase === "settled"
                        ? {
                            duration: reduceMotion ? 0.12 : 0.2,
                            ease: [0.16, 1, 0.3, 1],
                          }
                        : {
                            duration: reduceMotion ? 0.18 : 0.56,
                            ease: [0.16, 1, 0.3, 1],
                          }
                  }
                >
                  <motion.span
                    className="bidsite-refresh-loader__wordmark"
                    initial={{
                      x: "-106%",
                      opacity: 0,
                    }}
                    animate={
                      phase === "intro"
                        ? {
                            x: "-106%",
                            opacity: 0,
                            transition: {
                              duration: 0.12,
                            },
                          }
                        : phase === "reveal"
                          ? {
                              x: "0%",
                              opacity: 1,
                              transition: {
                                duration: reduceMotion ? 0.2 : 0.62,
                                delay: reduceMotion ? 0 : 0.04,
                                ease: [0.16, 1, 0.3, 1],
                              },
                            }
                          : {
                              x: "0%",
                              opacity: 1,
                              transition: {
                                duration: reduceMotion ? 0.14 : 0.24,
                                ease: refreshEase,
                              },
                            }
                    }
                  >
                    bidsite
                  </motion.span>
                </motion.span>
              </motion.span>
            </motion.div>
            <motion.div
              className="bidsite-refresh-loader__rule"
              initial={{ opacity: 0, scaleX: 0.2 }}
              animate={
                phase === "intro"
                  ? {
                      opacity: 1,
                      scaleX: 1,
                      transition: {
                        duration: reduceMotion ? 0.18 : 0.72,
                        delay: reduceMotion ? 0.06 : 0.22,
                        ease: [0.16, 1, 0.3, 1],
                      },
                    }
                  : {
                      opacity: 0,
                      scaleX: 0.4,
                      transition: { duration: reduceMotion ? 0.08 : 0.24 },
                    }
              }
            />
          </div>
        </motion.div>
      ) : null}
    </AnimatePresence>,
    document.body,
  );
}

export function ProjectDashboard({ projects }: { projects: ProjectSummary[] }) {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragActive, setDragActive] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState("");
  const [deletingProjectId, setDeletingProjectId] = useState("");
  const [deleteError, setDeleteError] = useState("");
  const latestProject = projects[0] ?? null;
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<ProjectStatusFilter>("Alle");
  const [sortBy, setSortBy] = useState<ProjectSort>("recent");
  const statusOptions = useMemo<ProjectStatusFilter[]>(
    () => [
      "Alle",
      ...Array.from(new Set(projects.map((project) => project.status))),
    ],
    [projects],
  );
  const filteredProjects = useMemo(() => {
    const query = normalizeSearch(searchQuery);
    const result = projects.filter((project) => {
      const matchesStatus =
        statusFilter === "Alle" || project.status === statusFilter;
      const searchable = [
        project.name,
        project.customer_name ?? "",
        project.industry ?? "",
        project.description ?? "",
        project.status,
      ]
        .join(" ")
        .toLocaleLowerCase("nb-NO");
      return matchesStatus && (!query || searchable.includes(query));
    });

    return result.sort((a, b) => {
      if (sortBy === "name") {
        return a.name.localeCompare(b.name, "nb-NO");
      }
      if (sortBy === "documents") {
        return b.document_count - a.document_count;
      }
      if (sortBy === "artifacts") {
        return b.artifact_count - a.artifact_count;
      }
      return (
        new Date(b.last_activity_at).getTime() -
        new Date(a.last_activity_at).getTime()
      );
    });
  }, [projects, searchQuery, sortBy, statusFilter]);
  const activeProjectCount = projects.filter(
    (project) => project.status !== "Venter på dokument",
  ).length;
  const readyForActionCount = projects.filter(
    (project) => !project.customer_analysis_generated || project.artifact_count === 0,
  ).length;

  const prefetchProject = useCallback(
    (projectId: string) => {
      router.prefetch(`/projects/${projectId}`);
    },
    [router],
  );

  useEffect(() => {
    if (!projects.length) return;

    const prefetchVisibleProjects = () => {
      for (const project of projects.slice(0, PROJECT_PREFETCH_LIMIT)) {
        router.prefetch(`/projects/${project.id}`);
      }
      void import("@/components/projects/project-analysis-tab");
    };

    if (typeof window.requestIdleCallback === "function") {
      const idleId = window.requestIdleCallback(prefetchVisibleProjects, {
        timeout: 1500,
      });
      return () => window.cancelIdleCallback(idleId);
    }

    const timeoutId = setTimeout(prefetchVisibleProjects, 300);
    return () => clearTimeout(timeoutId);
  }, [projects, router]);

  async function handleSpotlightUpload(file: File | null) {
    if (!file || uploading) return;

    setUploadError("");
    setUploading(true);
    try {
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
      const projectId = payload.id;
      await uploadProjectDocument({ projectId, file });

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

  async function handleDeleteProject(project: ProjectSummary) {
    if (deletingProjectId) return;
    setDeleteError("");
    setDeletingProjectId(project.id);
    try {
      const response = await fetch(`/api/projects/${project.id}`, {
        method: "DELETE",
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(payload.error || "Kunne ikke slette prosjektet.");
      }
      router.refresh();
    } catch (error) {
      setDeleteError(
        error instanceof Error ? error.message : "Kunne ikke slette prosjektet.",
      );
    } finally {
      setDeletingProjectId("");
    }
  }

  return (
    <>
      <div className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
      <section className="mb-5 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div className="min-w-0">
          <p className="text-[0.72rem] font-bold uppercase tracking-[0.16em] text-slate-500">
            Prosjektoversikt
          </p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-950">
            Aktiv anbudsflate
          </h1>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
            Finn prosjektet, se hva som stopper fremdriften, og start neste
            handling uten å åpne unødvendige steg.
          </p>
        </div>
        <div className="grid grid-cols-3 gap-2 sm:min-w-[24rem]">
          {[
            { label: "Totalt", value: projects.length },
            { label: "Aktive", value: activeProjectCount },
            { label: "Neste steg", value: readyForActionCount },
          ].map((metric) => (
            <div
              key={metric.label}
              className="rounded-lg border border-slate-200 bg-white px-3 py-2 shadow-sm"
            >
              <p className="text-xl font-semibold tabular-nums text-slate-950">
                {metric.value}
              </p>
              <p className="mt-1 text-[0.68rem] font-bold uppercase tracking-[0.12em] text-slate-500">
                {metric.label}
              </p>
            </div>
          ))}
        </div>
      </section>

      <section className="mb-6 grid gap-4 rounded-xl border border-slate-200 bg-white p-4 shadow-sm lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-stretch">
          <div className="min-w-0 rounded-lg border border-slate-200 bg-slate-50 px-4 py-4">
            <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
              <div>
                <p className="text-sm font-semibold text-slate-950">
                  Start nytt arbeid
                </p>
                <p className="mt-1 text-sm leading-6 text-slate-600">
                  Last opp anbudsgrunnlag direkte, eller opprett prosjekt med
                  mer metadata først.
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Link
                  href="/projects/new"
                  className="inline-flex h-10 items-center gap-2 rounded-md bg-slate-950 px-4 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400"
                >
                  <Plus className="size-4" />
                  Nytt prosjekt
                </Link>
                {latestProject ? (
                  <Link
                    href={projectActionHref(latestProject)}
                    prefetch
                    onFocus={() => prefetchProject(latestProject.id)}
                    onPointerEnter={() => prefetchProject(latestProject.id)}
                    className="inline-flex h-10 items-center gap-2 rounded-md border border-slate-200 bg-white px-4 text-sm font-semibold text-slate-800 shadow-sm transition-colors hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-300"
                  >
                    Åpne siste steg
                    <ArrowRight className="size-4" />
                  </Link>
                ) : null}
              </div>
            </div>
          </div>

          <div className="relative overflow-hidden rounded-lg border border-slate-200 bg-slate-950 p-3 shadow-sm">
            <input
              ref={fileInputRef}
              type="file"
              accept=".pdf,.docx,.xlsx,.xls,.txt,.md"
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
                  : "border-white/30 bg-white/[0.06] hover:bg-white/[0.10]"
              }`}
            >
              <UploadCloud className="size-7 text-blue-100" />
              <span className="mt-3 text-sm font-semibold text-white">
                {uploading ? "Laster opp ..." : "Slipp dokument her"}
              </span>
              <span className="mt-1 text-xs leading-5 text-slate-100/75">
                Oppretter prosjekt og lagrer filen i dokumenter.
              </span>
            </button>
            {uploadError ? (
              <p className="mt-3 rounded-md border border-red-200/40 bg-red-950/30 px-3 py-2 text-xs text-red-100">
                {uploadError}
              </p>
            ) : null}
          </div>
      </section>

      {/* Project Table */}
      <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-[0_18px_55px_rgba(15,23,42,0.08)]">
        <div className="flex flex-col gap-4 border-b border-slate-200 bg-slate-50/80 px-4 py-4 lg:px-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-bold uppercase tracking-[0.16em] text-slate-900">
                Prosjekter
              </h2>
              <p className="mt-1 text-sm text-slate-500">
                Sorter etter aktivitet, filtrer på status, og åpne anbefalt neste steg.
              </p>
            </div>
          <span className="rounded-full border border-slate-200 bg-white px-3 py-1 text-sm font-semibold text-slate-600 shadow-sm">
              {filteredProjects.length} av {projects.length}
          </span>
          </div>
          <div className="grid gap-3 lg:grid-cols-[minmax(14rem,1fr)_13rem_13rem]">
            <label className="relative">
              <span className="sr-only">Søk i prosjekter</span>
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" />
              <input
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder="Søk etter prosjekt, kunde, bransje eller status"
                className="h-10 w-full rounded-lg border border-slate-200 bg-white pl-10 pr-3 text-sm font-medium text-slate-950 outline-none transition-colors placeholder:text-slate-400 focus:border-slate-400"
              />
            </label>
            <label className="relative">
              <span className="sr-only">Filtrer status</span>
              <SlidersHorizontal className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" />
              <select
                value={statusFilter}
                onChange={(event) =>
                  setStatusFilter(event.target.value as ProjectStatusFilter)
                }
                className="h-10 w-full appearance-none rounded-lg border border-slate-200 bg-white pl-10 pr-3 text-sm font-semibold text-slate-800 outline-none focus:border-slate-400"
              >
                {statusOptions.map((status) => (
                  <option key={status} value={status}>
                    {status === "Alle" ? "Alle statuser" : status}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span className="sr-only">Sorter prosjekter</span>
              <select
                value={sortBy}
                onChange={(event) => setSortBy(event.target.value as ProjectSort)}
                className="h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-800 outline-none focus:border-slate-400"
              >
                <option value="recent">Sist endret</option>
                <option value="name">Navn A-Å</option>
                <option value="documents">Flest dokumenter</option>
                <option value="artifacts">Flest utkast</option>
              </select>
            </label>
          </div>
        </div>
        {deleteError ? (
          <div className="border-b border-red-100 bg-red-50 px-7 py-3 text-sm font-medium text-red-700">
            {deleteError}
          </div>
        ) : null}

        {projects.length === 0 ? (
          <div className="py-16 text-center">
            <div className="mx-auto flex size-12 items-center justify-center rounded-md bg-muted">
              <Search className="size-5 text-muted-foreground" />
            </div>
            <p className="mt-4 text-sm font-semibold text-foreground">
              Ingen prosjekter ennå
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              Opprett et prosjekt og last opp dokumenter for å komme i gang.
            </p>
            <Link
              href="/projects/new"
              className="mt-5 inline-flex h-9 items-center gap-1.5 rounded-md bg-primary px-4 text-[13px] font-semibold text-primary-foreground shadow-sm transition-colors hover:bg-blue-800"
            >
              <Plus className="size-3.5" />
              Opprett prosjekt
            </Link>
          </div>
        ) : filteredProjects.length === 0 ? (
          <div className="px-6 py-14 text-center">
            <div className="mx-auto flex size-12 items-center justify-center rounded-md bg-slate-100">
              <Search className="size-5 text-slate-500" />
            </div>
            <p className="mt-4 text-sm font-semibold text-slate-950">
              Ingen prosjekter matcher filtrene
            </p>
            <p className="mt-1 text-sm text-slate-500">
              Juster søk, statusfilter eller sortering for å se flere prosjekter.
            </p>
          </div>
        ) : (
          <>
          <div className="hidden overflow-x-auto md:block">
            <table className="w-full text-left">
              <thead>
                <tr className="border-b border-slate-200 bg-white">
                  <th className="px-7 py-4 text-xs font-bold uppercase tracking-[0.16em] text-slate-400">
                    Prosjekt
                  </th>
                  <th className="px-5 py-4 text-xs font-bold uppercase tracking-[0.16em] text-slate-400">
                    Status
                  </th>
                  <th className="hidden px-5 py-4 text-xs font-bold uppercase tracking-[0.16em] text-slate-400 sm:table-cell">
                    Dok.
                  </th>
                  <th className="hidden px-5 py-4 text-xs font-bold uppercase tracking-[0.16em] text-slate-400 sm:table-cell">
                    Utkast
                  </th>
                  <th className="hidden px-5 py-4 text-left text-xs font-bold uppercase tracking-[0.16em] text-slate-400 md:table-cell">
                    Sist endret
                  </th>
                  <th className="px-7 py-4" />
                </tr>
              </thead>
              <tbody>
                {filteredProjects.map((project) => {
                  const action = nextProjectAction(project);
                  return (
                  <tr
                    key={project.id}
                    className="group border-b border-slate-200/80 transition-colors last:border-b-0 hover:bg-blue-50/35"
                  >
                    <td className="px-7 py-5">
                      <Link
                        href={projectActionHref(project)}
                        prefetch
                        onFocus={() => prefetchProject(project.id)}
                        onPointerEnter={() => prefetchProject(project.id)}
                        className="block"
                      >
                        <p className="text-lg font-bold tracking-[-0.02em] text-slate-950 transition-colors group-hover:text-blue-800">
                          {project.name}
                        </p>
                        <p className="mt-1 text-base leading-6 text-slate-500">
                          {project.customer_name || "Kunde ikke satt"}
                          {project.industry ? ` · ${project.industry}` : ""}
                        </p>
                        <p className="mt-2 text-sm font-semibold text-slate-700">
                          {action.label}
                          <span className="font-normal text-slate-400"> · </span>
                          <span className="ml-2 font-normal text-slate-500">
                            {action.detail}
                          </span>
                        </p>
                      </Link>
                    </td>
                    <td className="px-5 py-5">
                      <span className={`inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm font-semibold shadow-sm ${statusColor(project.status)}`}>
                        <span className={`inline-block size-2 rounded-full ${statusDot(project.status)}`} />
                        {project.status}
                      </span>
                    </td>
                    <td className="hidden px-5 py-5 text-lg font-semibold tabular-nums text-slate-600 sm:table-cell">
                      {project.document_count}
                    </td>
                    <td className="hidden px-5 py-5 text-lg font-semibold tabular-nums text-slate-600 sm:table-cell">
                      {project.artifact_count}
                    </td>
                    <td className="hidden px-5 py-5 text-base text-slate-500 md:table-cell">
                      {formatDate(project.last_activity_at)}
                    </td>
                    <td className="px-7 py-5 text-right">
                      <div className="flex justify-end gap-2">
                        <DeleteConfirmDialog
                          title="Slett prosjekt?"
                          description={`Dette sletter "${project.name}" med dokumenter, analyser, chat og genererte utkast. Handlingen kan ikke angres.`}
                          confirmLabel="Slett prosjekt"
                          onConfirm={() => handleDeleteProject(project)}
                        >
                          <button
                            type="button"
                            disabled={Boolean(deletingProjectId)}
                            aria-label={`Slett ${project.name}`}
                            className="inline-flex size-9 items-center justify-center rounded-md border border-red-100 bg-white text-red-700 shadow-sm transition-colors hover:border-red-200 hover:bg-red-50 disabled:cursor-wait disabled:opacity-60"
                          >
                            {deletingProjectId === project.id ? (
                              <Spinner className="size-4" />
                            ) : (
                              <Trash2 className="size-4" />
                            )}
                          </button>
                        </DeleteConfirmDialog>
                        <Link
                          href={projectActionHref(project)}
                          prefetch
                          onFocus={() => prefetchProject(project.id)}
                          onPointerEnter={() => prefetchProject(project.id)}
                          className="inline-flex h-9 items-center gap-2 rounded-md border border-blue-100 bg-white px-3 text-sm font-semibold text-blue-800 shadow-sm transition-colors hover:border-blue-200 hover:bg-blue-50"
                        >
                          {action.label} <ArrowRight className="size-4" />
                        </Link>
                      </div>
                    </td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="grid gap-3 p-4 md:hidden">
            {filteredProjects.map((project) => {
              const action = nextProjectAction(project);
              return (
                <article
                  key={project.id}
                  className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <Link
                        href={projectActionHref(project)}
                        className="block text-base font-bold text-slate-950"
                      >
                        {project.name}
                      </Link>
                      <p className="mt-1 text-sm text-slate-500">
                        {project.customer_name || "Kunde ikke satt"}
                        {project.industry ? ` · ${project.industry}` : ""}
                      </p>
                    </div>
                    <span className={`inline-flex shrink-0 items-center gap-1.5 rounded-md border px-2 py-1 text-xs font-semibold ${statusColor(project.status)}`}>
                      <span className={`inline-block size-1.5 rounded-full ${statusDot(project.status)}`} />
                      {project.status}
                    </span>
                  </div>
                  <div className="mt-4 grid grid-cols-3 gap-2 text-center">
                    <div className="rounded-md bg-slate-50 px-2 py-2">
                      <p className="font-semibold tabular-nums text-slate-950">
                        {project.document_count}
                      </p>
                      <p className="text-[0.68rem] font-bold uppercase tracking-[0.1em] text-slate-500">
                        Dok.
                      </p>
                    </div>
                    <div className="rounded-md bg-slate-50 px-2 py-2">
                      <p className="font-semibold tabular-nums text-slate-950">
                        {project.artifact_count}
                      </p>
                      <p className="text-[0.68rem] font-bold uppercase tracking-[0.1em] text-slate-500">
                        Utkast
                      </p>
                    </div>
                    <div className="rounded-md bg-slate-50 px-2 py-2">
                      <p className="truncate text-sm font-semibold text-slate-950">
                        {formatDate(project.last_activity_at)}
                      </p>
                      <p className="text-[0.68rem] font-bold uppercase tracking-[0.1em] text-slate-500">
                        Endret
                      </p>
                    </div>
                  </div>
                  <p className="mt-4 text-sm font-semibold text-slate-950">
                    {action.label}
                  </p>
                  <p className="mt-1 text-sm leading-5 text-slate-500">
                    {action.detail}
                  </p>
                  <div className="mt-4 flex justify-between gap-2">
                    <DeleteConfirmDialog
                      title="Slett prosjekt?"
                      description={`Dette sletter "${project.name}" med dokumenter, analyser, chat og genererte utkast. Handlingen kan ikke angres.`}
                      confirmLabel="Slett prosjekt"
                      onConfirm={() => handleDeleteProject(project)}
                    >
                      <button
                        type="button"
                        disabled={Boolean(deletingProjectId)}
                        aria-label={`Slett ${project.name}`}
                        className="inline-flex size-9 items-center justify-center rounded-md border border-red-100 bg-white text-red-700 shadow-sm transition-colors hover:border-red-200 hover:bg-red-50 disabled:cursor-wait disabled:opacity-60"
                      >
                        {deletingProjectId === project.id ? (
                          <Spinner className="size-4" />
                        ) : (
                          <Trash2 className="size-4" />
                        )}
                      </button>
                    </DeleteConfirmDialog>
                    <Link
                      href={projectActionHref(project)}
                      className="inline-flex h-9 flex-1 items-center justify-center gap-2 rounded-md bg-slate-950 px-3 text-sm font-semibold text-white shadow-sm"
                    >
                      {action.label}
                      <ArrowRight className="size-4" />
                    </Link>
                  </div>
                </article>
              );
            })}
          </div>
          </>
        )}
      </section>

      {/* Workflow Steps */}
      <section className="mt-8 rounded-md border border-border bg-card p-6 shadow-sm">
        <h2 className="mb-5 text-[10.5px] font-bold uppercase tracking-[0.16em] text-muted-foreground/75">
          Arbeidsflyt
        </h2>
        <div className="grid gap-4 lg:grid-cols-3">
          {[
            { step: "1", title: "Last opp grunnlag", desc: "Samle alle dokumenter i samme dokumentbank." },
            { step: "2", title: "Analyser kunden", desc: "Generer kundeanalyse med krav, risiko og posisjonering." },
            { step: "3", title: "Generer beskrivelse", desc: "Generer løsningsbeskrivelse basert på prosjektkonteksten." },
          ].map((item, i) => (
            <div key={item.step} className="flex min-w-0 items-start gap-3">
              <div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground">
                {item.step}
              </div>
              <div className="min-w-0">
                <p className="text-[13.5px] font-semibold tracking-[-0.01em] text-foreground">{item.title}</p>
                <p className="mt-0.5 text-[12px] leading-relaxed text-muted-foreground">{item.desc}</p>
              </div>
            </div>
          ))}
        </div>
      </section>
      </div>
    </>
  );
}
