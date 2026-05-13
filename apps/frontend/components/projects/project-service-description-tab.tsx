"use client";

import { useEffect, useMemo, useState, type DragEvent, type FormEvent } from "react";
import {
  CheckCircle2,
  FileText,
  Layers3,
  Lightbulb,
  LockKeyhole,
  Plus,
  Trash2,
  Upload,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Input } from "@/components/projects/primitives";
import { DeleteConfirmDialog } from "@/components/projects/delete-confirm-dialog";
import {
  clearClientCache,
  getClientCache,
  setClientCache,
} from "@/lib/client-cache";
import type { ProjectServiceDescription, ServiceInclusionMode } from "@/lib/types";

const projectServicesCacheKey = (projectId: string) =>
  `project-service-descriptions:${projectId}`;
const SERVICE_DESCRIPTIONS_CACHE_KEY = "service-descriptions";
const PROJECT_SERVICES_CACHE_TTL_MS = 2 * 60 * 1000;

function fileTitle(file: File) {
  return file.name.replace(/\.[^.]+$/, "");
}

function modeLabel(mode: ServiceInclusionMode) {
  return mode === "fixed" ? "Fast" : "Valgt";
}

export function ProjectServiceDescriptionTab({
  projectId,
}: {
  projectId: string;
}) {
  const [services, setServices] = useState<ProjectServiceDescription[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [serviceName, setServiceName] = useState("");
  const [description, setDescription] = useState("");
  const [mode, setMode] = useState<ServiceInclusionMode>("selected");
  const [targetServiceId, setTargetServiceId] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [fileInputKey, setFileInputKey] = useState(0);
  const [dragActive, setDragActive] = useState(false);
  const [savingSelectionIds, setSavingSelectionIds] = useState<Set<string>>(
    () => new Set(),
  );

  const selectedIds = useMemo(
    () =>
      services
        .filter((service) => service.inclusion_mode === "selected" && service.selected)
        .map((service) => service.id),
    [services],
  );
  const recommendedServices = services.filter((service) => service.recommended);

  async function loadServices() {
    const cacheKey = projectServicesCacheKey(projectId);
    const cached = getClientCache<ProjectServiceDescription[]>(cacheKey);
    if (cached) {
      setServices(cached);
      setLoading(false);
      setError("");
      return;
    }

    setLoading(true);
    setError("");
    try {
      const response = await fetch(`/api/projects/${projectId}/service-descriptions`, {
        cache: "no-store",
      });
      const payload = (await response.json()) as {
        services?: ProjectServiceDescription[];
        error?: string;
      };
      if (!response.ok || !payload.services) {
        throw new Error(payload.error || "Kunne ikke hente tjenestebeskrivelser.");
      }
      setServices(payload.services);
      setClientCache(cacheKey, payload.services, PROJECT_SERVICES_CACHE_TTL_MS);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Kunne ikke hente tjenestebeskrivelser.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadServices();
  }, [projectId]);

  async function saveSelections(
    nextIds: string[],
    optimisticServices: ProjectServiceDescription[],
    changedServiceId: string,
  ) {
    setSavingSelectionIds((current) => new Set(current).add(changedServiceId));
    setError("");
    try {
      const response = await fetch(`/api/projects/${projectId}/service-descriptions`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ selected_service_ids: nextIds }),
      });
      const payload = (await response.json()) as {
        services?: ProjectServiceDescription[];
        error?: string;
      };
      if (!response.ok || !payload.services) {
        throw new Error(payload.error || "Kunne ikke lagre tjenestevalg.");
      }
      setServices(payload.services);
      setClientCache(
        projectServicesCacheKey(projectId),
        payload.services,
        PROJECT_SERVICES_CACHE_TTL_MS,
      );
      window.dispatchEvent(new CustomEvent("project-services-updated"));
    } catch (err) {
      setServices(optimisticServices);
      setClientCache(
        projectServicesCacheKey(projectId),
        optimisticServices,
        PROJECT_SERVICES_CACHE_TTL_MS,
      );
      setError(err instanceof Error ? err.message : "Kunne ikke lagre tjenestevalg.");
    } finally {
      setSavingSelectionIds((current) => {
        const next = new Set(current);
        next.delete(changedServiceId);
        return next;
      });
    }
  }

  async function toggleSelected(service: ProjectServiceDescription) {
    if (service.inclusion_mode === "fixed") return;
    const previousServices = services;
    const optimisticServices = services.map((item) =>
      item.id === service.id ? { ...item, selected: !service.selected } : item,
    );
    const nextIds = optimisticServices
      .filter((item) => item.inclusion_mode === "selected" && item.selected)
      .map((item) => item.id);

    setServices(optimisticServices);
    setClientCache(
      projectServicesCacheKey(projectId),
      optimisticServices,
      PROJECT_SERVICES_CACHE_TTL_MS,
    );
    window.dispatchEvent(new CustomEvent("project-services-updated"));
    await saveSelections(nextIds, previousServices, service.id);
  }

  async function updateMode(service: ProjectServiceDescription, nextMode: ServiceInclusionMode) {
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
      clearClientCache(projectServicesCacheKey(projectId));
      await loadServices();
      window.dispatchEvent(new CustomEvent("project-services-updated"));
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
      clearClientCache(projectServicesCacheKey(projectId));
      await loadServices();
      window.dispatchEvent(new CustomEvent("project-services-updated"));
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
      clearClientCache(projectServicesCacheKey(projectId));
      setServiceName("");
      setDescription("");
      setTargetServiceId("");
      setFile(null);
      setFileInputKey((current) => current + 1);
      await loadServices();
      window.dispatchEvent(new CustomEvent("project-services-updated"));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Kunne ikke lagre tjenestebeskrivelsen.");
    } finally {
      setBusy("");
    }
  }

  function onDrop(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    setDragActive(false);
    setFile(event.dataTransfer.files?.[0] ?? null);
  }

  if (loading) {
    return (
      <div className="rounded-xl border border-border/70 bg-card px-5 py-6 text-sm text-muted-foreground">
        Laster tjenestekatalog ...
      </div>
    );
  }

  return (
    <div className="grid min-w-0 gap-6 xl:grid-cols-[minmax(20rem,24rem)_minmax(0,1fr)]">
      <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="border-b border-slate-200 bg-slate-50 px-5 py-5">
          <div className="flex items-start gap-3">
            <span className="flex size-11 shrink-0 items-center justify-center rounded-lg bg-slate-950 text-white">
              <Layers3 className="size-5" />
            </span>
            <div className="min-w-0">
              <p className="text-xs font-bold uppercase tracking-[0.14em] text-slate-500">
                Global tjenestekatalog
              </p>
              <h2 className="mt-1 text-xl font-bold text-slate-950">
                Tjenestebeskrivelser
              </h2>
              <p className="mt-2 text-sm leading-6 text-slate-600">
                En tjeneste kan ha flere dokumenter. Faste tjenester er alltid i
                AI-kontekst, mens valgte tjenester må hukes av per prosjekt.
              </p>
            </div>
          </div>
        </div>

        <form onSubmit={onSubmit} className="space-y-4 p-5">
          <div className="space-y-2">
            <p className="text-sm font-medium text-slate-700">Tjenestegruppe</p>
            <select
              value={targetServiceId}
              onChange={(event) => {
                const value = event.target.value;
                setTargetServiceId(value);
                const service = services.find((item) => item.id === value);
                if (service) {
                  setServiceName(service.name);
                  setDescription(service.description);
                  setMode(service.inclusion_mode);
                }
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
          </div>

          <div className="space-y-2">
            <p className="text-sm font-medium text-slate-700">Navn</p>
            <Input
              value={serviceName}
              onChange={(event) => setServiceName(event.target.value)}
              placeholder="For eksempel Azure drift, sikkerhet, nettverk"
            />
          </div>

          <div className="grid grid-cols-2 gap-2">
            {(["fixed", "selected"] as const).map((item) => (
              <button
                key={item}
                type="button"
                onClick={() => setMode(item)}
                className={`rounded-lg border px-3 py-2 text-sm font-semibold ${
                  mode === item
                    ? "border-slate-950 bg-slate-950 text-white"
                    : "border-slate-200 bg-white text-slate-600"
                }`}
              >
                {modeLabel(item)}
              </button>
            ))}
          </div>

          <label
            htmlFor="service-file"
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
            onDrop={onDrop}
            className={`flex cursor-pointer flex-col items-center justify-center rounded-xl border border-dashed px-4 py-7 text-center transition-colors ${
              dragActive
                ? "border-slate-950 bg-slate-100"
                : "border-slate-300 bg-slate-50 hover:border-primary/60 hover:bg-primary/5"
            }`}
          >
            <Upload className="mb-3 size-5 text-primary" />
            <span className="text-sm font-semibold text-slate-950">
              Legg til dokument under tjenesten
            </span>
            <span className="mt-1 text-xs text-slate-500">
              PDF, DOCX, Excel, TXT eller MD.
            </span>
            {file ? (
              <span className="mt-3 max-w-full truncate rounded-lg bg-primary/10 px-3 py-2 text-xs font-semibold text-primary">
                {file.name}
              </span>
            ) : null}
          </label>
          <Input
            key={fileInputKey}
            id="service-file"
            type="file"
            accept=".pdf,.docx,.xlsx,.xls,.txt,.md"
            className="sr-only"
            onChange={(event) => setFile(event.target.files?.[0] ?? null)}
          />

          <Button
            type="submit"
            className="h-11 w-full rounded-lg"
            disabled={busy === "upload" || (!file && !serviceName.trim())}
          >
            {busy === "upload" ? <Spinner className="size-4" /> : <Plus data-icon="inline-start" />}
            Lagre tjeneste
          </Button>
        </form>
      </section>

      <section className="min-w-0 space-y-4">
        {error ? (
          <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
            {error}
          </div>
        ) : null}

        {recommendedServices.length ? (
          <div className="rounded-xl border border-amber-200 bg-amber-50 px-5 py-4">
            <div className="flex items-center gap-2 text-sm font-bold text-amber-950">
              <Lightbulb className="size-4" />
              Svært relevante tjenester for dette prosjektet
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              {recommendedServices.map((service) => (
                <button
                  key={service.id}
                  type="button"
                  onClick={() => void toggleSelected(service)}
                  className="rounded-full border border-amber-300 bg-white px-3 py-1.5 text-sm font-semibold text-amber-950 shadow-sm"
                >
                  {service.name} · {service.recommendation_score}%
                </button>
              ))}
            </div>
          </div>
        ) : null}

        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
          <div className="border-b border-slate-200 bg-slate-50 px-5 py-4">
            <h3 className="text-sm font-bold text-slate-950">Tjenester</h3>
            <p className="mt-1 text-sm text-slate-500">
              Huk av valgte tjenester som skal være med i dette prosjektet.
            </p>
          </div>

          {services.length ? (
            <div className="divide-y divide-slate-200">
              {services.map((service) => (
                <div key={service.id} className="px-5 py-4">
                  <div className="flex min-w-0 items-start justify-between gap-4">
                    <button
                      type="button"
                      onClick={() => void toggleSelected(service)}
                      disabled={service.inclusion_mode === "fixed"}
                      aria-busy={savingSelectionIds.has(service.id)}
                      className="group flex min-w-0 flex-1 items-start gap-3 text-left transition-opacity disabled:cursor-not-allowed disabled:opacity-70"
                    >
                      <span
                        className={`mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-md border transition-colors ${
                          service.selected
                            ? "border-slate-950 bg-slate-950 text-white"
                            : "border-slate-300 bg-white group-hover:border-slate-500"
                        }`}
                      >
                        {savingSelectionIds.has(service.id) ? (
                          <Spinner className="size-3 text-current" />
                        ) : service.selected ? (
                          <CheckCircle2 className="size-3.5" />
                        ) : null}
                      </span>
                      <span className="min-w-0">
                        <span className="flex flex-wrap items-center gap-2">
                          <span className="text-sm font-bold text-slate-950">{service.name}</span>
                          <span className="rounded-full border border-slate-200 px-2 py-0.5 text-[0.68rem] font-bold uppercase tracking-[0.12em] text-slate-500">
                            {modeLabel(service.inclusion_mode)}
                          </span>
                          {service.inclusion_mode === "fixed" ? (
                            <LockKeyhole className="size-3.5 text-slate-500" />
                          ) : null}
                          {service.recommended ? (
                            <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-bold text-amber-900">
                              Anbefalt
                            </span>
                          ) : null}
                          {savingSelectionIds.has(service.id) ? (
                            <span className="rounded-full bg-blue-50 px-2 py-0.5 text-xs font-bold text-blue-700">
                              Lagrer
                            </span>
                          ) : null}
                        </span>
                        <span className="mt-1 block text-sm text-slate-500">
                          {service.recommendation_reason}
                        </span>
                      </span>
                    </button>

                    <select
                      value={service.inclusion_mode}
                      disabled={busy === `mode-${service.id}`}
                      onChange={(event) =>
                        void updateMode(service, event.target.value as ServiceInclusionMode)
                      }
                      className="h-8 rounded-md border border-slate-200 bg-white px-2 text-xs font-semibold"
                    >
                      <option value="fixed">Fast</option>
                      <option value="selected">Valgt</option>
                    </select>
                  </div>

                  <div className="mt-3 ml-8 space-y-2">
                    {service.documents.map((document) => (
                      <div
                        key={document.id}
                        className="flex items-center justify-between gap-3 rounded-lg bg-slate-50 px-3 py-2"
                      >
                        <div className="flex min-w-0 items-start gap-2">
                          <FileText className="size-4 shrink-0 text-teal-700" />
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
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="px-5 py-12 text-center">
              <FileText className="mx-auto size-8 text-slate-400" />
              <p className="mt-4 text-sm font-semibold text-slate-950">
                Ingen tjenestebeskrivelser ennå
              </p>
              <p className="mt-1 text-sm text-slate-500">
                Opprett første tjeneste og legg ett eller flere dokumenter under den.
              </p>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
