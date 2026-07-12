"use client";

import { FormEvent, useEffect, useState } from "react";
import {
  CheckCircle2,
  FileText,
  Layers3,
  Plus,
  Trash2,
  Upload,
} from "lucide-react";

import { DeleteConfirmDialog } from "@/components/projects/delete-confirm-dialog";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import {
  clearClientCache,
  getClientCache,
  setClientCache,
} from "@/lib/client-cache";
import type { ServiceDescription } from "@/lib/types";

const SERVICE_DESCRIPTIONS_CACHE_KEY = "service-descriptions";
const SERVICE_DESCRIPTIONS_CACHE_TTL_MS = 5 * 60 * 1000;

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
      const response = await fetch("/api/service-descriptions", {
        cache: "no-store",
      });
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
                Dokumenter her brukes som firmaets tjenestegrunnlag på tvers av
                prosjekter. Velg hvilke tjenester som skal brukes inne på hvert
                prosjekt.
              </p>
            </div>
          </div>

          <form onSubmit={onSubmit} className="mt-5 space-y-3">
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
                Alle tjenester kan hukes av per prosjekt før de blir del av prosjektkonteksten.
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
                          <CheckCircle2 className="size-3" />
                          Global
                        </span>
                      </div>
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
