"use client";

import { FormEvent, useEffect, useState } from "react";
import {
  FileText,
  Plus,
  Trash2,
  Upload,
} from "lucide-react";

import { DeleteConfirmDialog } from "@/components/projects/delete-confirm-dialog";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import {
  cacheServiceDescriptions,
  fetchServiceDescriptions,
  invalidateProjectServiceDescriptionCaches,
} from "@/lib/client/service-descriptions-api";
import type { ServiceDescription } from "@/lib/types";
import { readJsonPayload } from "@/lib/client/project-api";

function fileTitle(file: File) {
  return file.name.replace(/\.[^.]+$/, "");
}

export function GlobalServiceDescriptionsPanel() {
  const [services, setServices] = useState<ServiceDescription[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [targetServiceId, setTargetServiceId] = useState("");
  const [serviceName, setServiceName] = useState("");
  const [description, setDescription] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [fileInputKey, setFileInputKey] = useState(0);
  const [dragActive, setDragActive] = useState(false);

  async function loadServices() {
    setLoading(true);
    setError("");
    try {
      setServices(await fetchServiceDescriptions());
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Kunne ikke hente tjenestebeskrivelser.",
      );
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadServices();
  }, []);

  async function deleteDocument(serviceId: string, documentId: string) {
    setBusy(`delete-document-${documentId}`);
    setError("");
    try {
      const response = await fetch(
        `/api/service-descriptions/${serviceId}/documents/${documentId}`,
        { method: "DELETE" },
      );
      const payload = await readJsonPayload(response, "Kunne ikke slette dokumentet.");
      if (!response.ok) {
        throw new Error(payload.error || "Kunne ikke slette dokumentet.");
      }
      setServices((current) => {
        const next = current.map((service) =>
          service.id === serviceId
            ? {
                ...service,
                documents: service.documents.filter(
                  (document) => document.id !== documentId,
                ),
              }
            : service,
        );
        cacheServiceDescriptions(next);
        return next;
      });
      invalidateProjectServiceDescriptionCaches();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Kunne ikke slette dokumentet.",
      );
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
          ? services.find((service) => service.id === targetServiceId)?.name ??
              serviceName
          : serviceName,
      );
      formData.append("description", description);

      const response = await fetch("/api/service-descriptions", {
        method: "POST",
        body: formData,
      });
      const payload = await readJsonPayload<{ services: ServiceDescription[] }>(
        response,
        "Kunne ikke lagre tjenestebeskrivelsen.",
      );
      if (!response.ok || !payload.services) {
        throw new Error(
          payload.error || "Kunne ikke lagre tjenestebeskrivelsen.",
        );
      }
      setServices(payload.services);
      cacheServiceDescriptions(payload.services);
      invalidateProjectServiceDescriptionCaches();
      setTargetServiceId("");
      setServiceName("");
      setDescription("");
      setFile(null);
      setFileInputKey((current) => current + 1);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Kunne ikke lagre tjenestebeskrivelsen.",
      );
    } finally {
      setBusy("");
    }
  }

  return (
    <section className="overflow-hidden rounded-md border border-slate-200 bg-white">
      <div className="grid gap-0 lg:grid-cols-[23rem_minmax(0,1fr)]">
        <div className="border-b border-slate-200 p-4 lg:border-b-0 lg:border-r">
          <p className="text-sm text-slate-600">
            Tjenestene er tilgjengelige for alle prosjekter.
          </p>

          <form onSubmit={onSubmit} className="mt-3 space-y-3">
            <select
              aria-label="Velg tjeneste"
              value={targetServiceId}
              onChange={(event) => {
                const value = event.target.value;
                setTargetServiceId(value);
                const service = services.find((item) => item.id === value);
                setServiceName(service?.name ?? "");
                setDescription(service?.description ?? "");
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
              aria-label="Tjenestenavn"
              value={serviceName}
              onChange={(event) => setServiceName(event.target.value)}
              placeholder="Tjenestenavn"
              className="h-9 w-full rounded-md border border-slate-300 bg-white px-3 text-sm"
            />
            <textarea
              aria-label="Beskrivelse"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="Kort beskrivelse av når tjenesten er relevant"
              rows={3}
              className="w-full resize-none rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
            />

            <label
              htmlFor="home-service-file"
              role="button"
              tabIndex={0}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  const input = document.getElementById(event.currentTarget.htmlFor);
                  if (input instanceof HTMLInputElement) input.click();
                }
              }}
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
              className={`focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring flex cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed px-4 py-5 text-center ${
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
              tabIndex={-1}
              aria-hidden="true"
              type="file"
              accept=".pdf,.docx,.xlsx,.xls,.txt,.md"
              className="sr-only"
              onChange={(event) => setFile(event.target.files?.[0] ?? null)}
            />

            <Button
              type="submit"
              className="w-full"
              disabled={busy === "upload" || (!file && !serviceName.trim())}
            >
              {busy === "upload" ? <Spinner className="size-4" /> : <Plus data-icon="inline-start" />}
              Lagre tjeneste
            </Button>
          </form>
        </div>

        <div className="min-w-0 p-4">
          {error ? (
            <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
              {error}
            </div>
          ) : null}

          <div className="mb-4 flex items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-bold text-slate-950">Alle tjenestedokumenter</h3>
            </div>
            <div className="shrink-0 text-right">
              <p className="text-sm font-semibold text-slate-950">
                {services.reduce((sum, service) => sum + service.documents.length, 0)}
              </p>
              <p className="mt-1 text-xs text-slate-500">
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
                      <h4 className="text-sm font-bold text-slate-950">{service.name}</h4>
                      {service.description ? (
                        <p className="mt-1 text-sm leading-6 text-slate-500">
                          {service.description}
                        </p>
                      ) : null}
                    </div>
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
                              aria-label={`Slett ${document.title}`}
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
            <div className="py-4">
              <FileText className="size-4 text-slate-400" />
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
