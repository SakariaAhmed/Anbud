"use client";

import { FormEvent, useEffect, useState } from "react";
import {
  CheckCircle2,
  FileText,
  Layers3,
  LockKeyhole,
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
import type { ServiceDescription, ServiceInclusionMode } from "@/lib/types";

const SERVICE_DESCRIPTIONS_CACHE_KEY = "service-descriptions";
const SERVICE_DESCRIPTIONS_CACHE_TTL_MS = 5 * 60 * 1000;

function fileTitle(file: File) {
  return file.name.replace(/\.[^.]+$/, "");
}

function serviceModeLabel(mode: ServiceInclusionMode) {
  return mode === "fixed" ? "Fast for alle" : "Velges per prosjekt";
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
