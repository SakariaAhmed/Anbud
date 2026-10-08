"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CheckCircle2,
  FileText,
  Layers3,
} from "lucide-react";

import { buttonVariants } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import {
  PROJECT_SERVICES_CACHE_TTL_MS,
  projectServicesCacheKey,
  setClientCache,
} from "@/lib/client-cache";
import { fetchProjectServices } from "@/lib/client/project-api";
import type { ProjectServiceDescription } from "@/lib/types";
import { cn } from "@/lib/utils";

export function ProjectServiceDescriptionTab({
  projectId,
  onServicesChange,
}: {
  projectId: string;
  onServicesChange?: (services: ProjectServiceDescription[]) => void;
}) {
  const [services, setServices] = useState<ProjectServiceDescription[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [savingSelectionIds, setSavingSelectionIds] = useState<Set<string>>(
    () => new Set(),
  );
  const selectionSaving = savingSelectionIds.size > 0;
  const selectedCount = useMemo(
    () => services.filter((service) => service.selected).length,
    [services],
  );

  const applyServices = useCallback(
    (nextServices: ProjectServiceDescription[]) => {
      setServices(nextServices);
      setClientCache(
        projectServicesCacheKey(projectId),
        nextServices,
        PROJECT_SERVICES_CACHE_TTL_MS,
      );
      onServicesChange?.(nextServices);
    },
    [onServicesChange, projectId],
  );

  const loadServices = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      applyServices(await fetchProjectServices(projectId));
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Kunne ikke hente tjenestebeskrivelser.",
      );
    } finally {
      setLoading(false);
    }
  }, [applyServices, projectId]);

  useEffect(() => {
    void loadServices();
  }, [loadServices]);

  async function saveSelections(
    nextIds: string[],
    previousServices: ProjectServiceDescription[],
    optimisticServices: ProjectServiceDescription[],
    changedServiceId: string,
  ) {
    setSavingSelectionIds(new Set([changedServiceId]));
    setError("");
    try {
      const response = await fetch(
        `/api/projects/${projectId}/service-descriptions`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ selected_service_ids: nextIds }),
        },
      );
      const payload = (await response.json()) as {
        selected_service_ids?: string[];
        error?: string;
      };
      if (!response.ok || !Array.isArray(payload.selected_service_ids)) {
        throw new Error(payload.error || "Kunne ikke lagre tjenestevalg.");
      }

      const confirmedIds = new Set(payload.selected_service_ids);
      applyServices(
        optimisticServices.map((service) => ({
          ...service,
          selected: confirmedIds.has(service.id),
        })),
      );
      window.dispatchEvent(new CustomEvent("project-services-updated"));
    } catch (err) {
      applyServices(previousServices);
      setError(
        err instanceof Error ? err.message : "Kunne ikke lagre tjenestevalg.",
      );
    } finally {
      setSavingSelectionIds(new Set());
    }
  }

  async function toggleSelected(service: ProjectServiceDescription) {
    if (selectionSaving) return;

    const previousServices = services;
    const optimisticServices = services.map((item) =>
      item.id === service.id ? { ...item, selected: !service.selected } : item,
    );
    const nextIds = optimisticServices
      .filter((item) => item.selected)
      .map((item) => item.id);

    applyServices(optimisticServices);
    await saveSelections(
      nextIds,
      previousServices,
      optimisticServices,
      service.id,
    );
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2.5 border-y border-slate-200 bg-white px-5 py-6 text-sm text-slate-500">
        <Spinner className="size-4 text-blue-700" />
        Laster tjenestekatalog ...
      </div>
    );
  }

  return (
    <div className="min-w-0 space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
        <p className="text-sm text-slate-600">
          Velg tjenestene som skal brukes i prosjektet.
        </p>
        <div className="flex flex-wrap items-center gap-4">
          <span aria-live="polite" className="text-sm tabular-nums text-slate-600">
            {selectedCount} av {services.length} valgt
          </span>
          <Link
            href="/service-descriptions"
            className={buttonVariants({ variant: "outline", size: "sm" })}
          >
            <Layers3 className="size-3.5" />
            Åpne katalog
          </Link>
        </div>
      </div>

      {error ? (
        <div role="alert" className="border-l-2 border-red-600 bg-red-50 px-4 py-3 text-sm text-red-800">
          {error}
        </div>
      ) : null}

      {services.length ? (
        <ul aria-label="Tjenester i prosjektet" className="divide-y divide-slate-200 border-y border-slate-200">
          {services.map((service) => (
            <li key={service.id} className="py-5">
              <div className="flex items-start gap-3">
                <button
                  type="button"
                  onClick={() => void toggleSelected(service)}
                  aria-label={service.name}
                  aria-pressed={service.selected}
                  aria-busy={savingSelectionIds.has(service.id)}
                  disabled={selectionSaving}
                  className="group flex min-w-0 flex-1 items-start gap-3 rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-4 disabled:cursor-wait disabled:opacity-70"
                >
                  <span
                    aria-hidden="true"
                    className={cn(
                      "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-sm border",
                      service.selected
                        ? "border-blue-700 bg-blue-700 text-white"
                        : "border-slate-400 bg-white group-hover:border-blue-700",
                    )}
                  >
                    {savingSelectionIds.has(service.id) ? (
                      <Spinner className="size-3 text-current" />
                    ) : service.selected ? (
                      <CheckCircle2 className="size-3.5" />
                    ) : null}
                  </span>
                  <span className="min-w-0 text-base font-semibold leading-6 text-slate-900">
                    {service.name}
                  </span>
                </button>
                {service.recommended ? (
                  <span className="pt-0.5 text-xs font-medium text-slate-500">Anbefalt</span>
                ) : null}
              </div>

              <div className="ml-8 mt-1.5">
                {service.description ? (
                  <p className="max-w-[80ch] text-base leading-relaxed text-slate-600">
                    {service.description}
                  </p>
                ) : null}

                {service.recommended || service.recommendation_reason || service.documents.length ? (
                  <details className="group mt-2.5">
                    <summary className="w-fit cursor-pointer rounded-sm text-sm text-slate-500 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-4">
                      {service.recommendation_reason ? "Begrunnelse" : "Detaljer"}
                      {service.documents.length > 0 ? ` · ${service.documents.length} ${service.documents.length === 1 ? "dokument" : "dokumenter"}` : ""}
                    </summary>
                    <div className="mt-4 grid gap-5 border-l border-slate-200 pl-4 lg:grid-cols-2">
                      {service.recommended || service.recommendation_reason ? (
                        <div>
                          <h4 className="text-sm font-semibold text-slate-900">Relevans for prosjektet</h4>
                          {service.recommendation_reason ? <p className="mt-1 text-sm leading-relaxed text-slate-600">{service.recommendation_reason}</p> : null}
                          {service.recommended ? (
                            <p className="mt-2 text-xs text-slate-500">Relevansscore: {service.recommendation_score}%</p>
                          ) : null}
                        </div>
                      ) : null}
                      {service.documents.length > 0 ? (
                        <div>
                          <h4 className="text-sm font-semibold text-slate-900">Dokumentgrunnlag</h4>
                          <ul className="mt-2 space-y-2">
                            {service.documents.map((document) => (
                              <li key={document.id} className="flex items-start gap-2 text-sm leading-relaxed text-slate-600">
                                <FileText aria-hidden="true" className="mt-1 size-3.5 shrink-0" />
                                <span className="min-w-0 break-words">{document.title}</span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      ) : null}
                    </div>
                  </details>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <div className="border-t border-slate-200 py-10">
          <p className="text-base font-semibold text-slate-900">Ingen tjenestebeskrivelser ennå</p>
          <p className="mt-1 text-sm text-slate-600">Opprett tjenester i katalogen for å bruke dem i prosjektet.</p>
        </div>
      )}
    </div>
  );
}
