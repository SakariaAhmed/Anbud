"use client";

import { useEffect, useState, type DragEvent, type FormEvent } from "react";
import {
  CheckCircle2,
  FileText,
  Layers3,
  Lightbulb,
  Plus,
  Trash2,
  Upload,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { Input } from "@/components/projects/primitives";
import { DeleteConfirmDialog } from "@/components/projects/delete-confirm-dialog";
import {
  clearClientCache,
  getClientCache,
  PROJECT_SERVICES_CACHE_TTL_MS,
  projectServicesCacheKey,
  setClientCache,
} from "@/lib/client-cache";
import type { ProjectServiceDescription } from "@/lib/types";

const SERVICE_DESCRIPTIONS_CACHE_KEY = "service-descriptions";

function fileTitle(file: File) {
  return file.name.replace(/\.[^.]+$/, "");
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
  const [uploadError, setUploadError] = useState("");
  const [serviceName, setServiceName] = useState("");
  const [targetServiceId, setTargetServiceId] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [fileInputKey, setFileInputKey] = useState(0);
  const [uploadDialogOpen, setUploadDialogOpen] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [savingSelectionIds, setSavingSelectionIds] = useState<Set<string>>(
    () => new Set(),
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
      const response = await fetch(`/api/projects/${projectId}/service-descriptions`);
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
    const previousServices = services;
    const optimisticServices = services.map((item) =>
      item.id === service.id ? { ...item, selected: !service.selected } : item,
    );
    const nextIds = optimisticServices
      .filter((item) => item.selected)
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

  function resetUploadDraft() {
    setServiceName("");
    setTargetServiceId("");
    setFile(null);
    setUploadError("");
    setFileInputKey((current) => current + 1);
  }

  function openUploadDialog(nextFile: File | null | undefined) {
    if (!nextFile) return;
    setFile(nextFile);
    setTargetServiceId("");
    setServiceName("");
    setUploadError("");
    setUploadDialogOpen(true);
  }

  function closeUploadDialog() {
    if (busy === "upload") return;
    setUploadDialogOpen(false);
    resetUploadDraft();
  }

  function selectTargetService(value: string) {
    setTargetServiceId(value);
    const service = services.find((item) => item.id === value);
    setServiceName(service?.name ?? "");
    setUploadError("");
  }

  async function onUploadSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!file) {
      setUploadError("Velg et dokument først.");
      return;
    }

    const selectedService = targetServiceId
      ? services.find((service) => service.id === targetServiceId)
      : null;
    const nextName = targetServiceId
      ? selectedService?.name ?? ""
      : serviceName.trim();

    if (!nextName) {
      setUploadError("Velg en tjeneste eller skriv navn på ny tjeneste.");
      return;
    }

    setBusy("upload");
    setError("");
    setUploadError("");
    try {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("title", fileTitle(file));
      formData.append("service_id", targetServiceId);
      formData.append("name", nextName);
      formData.append("description", "");

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
      setUploadDialogOpen(false);
      resetUploadDraft();
      await loadServices();
      window.dispatchEvent(new CustomEvent("project-services-updated"));
    } catch (err) {
      setUploadError(
        err instanceof Error
          ? err.message
          : "Kunne ikke lagre tjenestebeskrivelsen.",
      );
    } finally {
      setBusy("");
    }
  }

  function onDrop(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    setDragActive(false);
    openUploadDialog(event.dataTransfer.files?.[0]);
  }

  if (loading) {
    return (
      <div className="rounded-xl border border-border/70 bg-card px-5 py-6 text-sm text-muted-foreground">
        Laster tjenestekatalog ...
      </div>
    );
  }

  return (
    <div className="min-w-0 space-y-6">
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
                Tjenester og dokumenter lagres globalt på tvers av prosjekter.
                Huk av hvilke tjenester som skal brukes i dette prosjektet.
              </p>
            </div>
          </div>
        </div>

        <div className="p-5">
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
              Slipp dokument her
            </span>
            <span className="mt-1 text-xs text-slate-500">
              Velg tjeneste og navn i neste steg.
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
            onChange={(event) => openUploadDialog(event.target.files?.[0])}
          />
        </div>
      </section>

      <Dialog
        open={uploadDialogOpen}
        onOpenChange={(open) => {
          if (open) {
            setUploadDialogOpen(true);
          } else {
            closeUploadDialog();
          }
        }}
      >
        <DialogContent className="max-w-lg">
          <form onSubmit={onUploadSubmit} className="space-y-5">
            <DialogHeader>
              <DialogTitle>Knytt dokument til tjeneste</DialogTitle>
              <DialogDescription>
                Velg eksisterende tjenestegruppe, eller opprett en ny før
                dokumentet lagres i den globale katalogen.
              </DialogDescription>
            </DialogHeader>

            {file ? (
              <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
                <p className="text-xs font-bold uppercase tracking-[0.12em] text-slate-500">
                  Dokument
                </p>
                <p className="mt-1 truncate text-sm font-semibold text-slate-950">
                  {file.name}
                </p>
              </div>
            ) : null}

            <div className="space-y-2">
              <label
                htmlFor="service-group-modal"
                className="text-sm font-medium text-slate-700"
              >
                Tjenestegruppe
              </label>
              <select
                id="service-group-modal"
                value={targetServiceId}
                onChange={(event) => selectTargetService(event.target.value)}
                className="h-10 w-full rounded-md border border-slate-300 bg-white px-3 text-sm text-slate-950"
                disabled={busy === "upload"}
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
              <label
                htmlFor="service-name-modal"
                className="text-sm font-medium text-slate-700"
              >
                Navn
              </label>
              <Input
                id="service-name-modal"
                value={serviceName}
                onChange={(event) => {
                  setServiceName(event.target.value);
                  setUploadError("");
                }}
                placeholder="For eksempel Azure drift, sikkerhet, nettverk"
                disabled={busy === "upload" || Boolean(targetServiceId)}
              />
              {targetServiceId ? (
                <p className="text-xs text-slate-500">
                  Navnet hentes fra tjenestegruppen.
                </p>
              ) : null}
            </div>

            {uploadError ? (
              <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
                {uploadError}
              </p>
            ) : null}

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={closeUploadDialog}
                disabled={busy === "upload"}
              >
                Avbryt
              </Button>
              <Button type="submit" disabled={busy === "upload"}>
                {busy === "upload" ? (
                  <Spinner className="size-4" />
                ) : (
                  <Plus data-icon="inline-start" />
                )}
                Lagre dokument
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

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
                      aria-busy={savingSelectionIds.has(service.id)}
                      className="group flex min-w-0 flex-1 items-start gap-3 text-left transition-opacity"
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
