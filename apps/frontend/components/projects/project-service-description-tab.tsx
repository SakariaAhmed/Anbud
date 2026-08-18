"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CheckCircle2,
  FileText,
  Layers3,
  Lightbulb,
} from "lucide-react";

import { Button, buttonVariants } from "@/components/ui/button";
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
  const recommendedServices = useMemo(
    () => services.filter((service) => service.recommended),
    [services],
  );
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
      <section className="overflow-hidden border-y border-slate-200 bg-white">
        <div className="flex flex-wrap items-start justify-between gap-4 px-6 py-6">
          <div className="flex min-w-0 items-start gap-4">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-md bg-slate-900 text-white">
              <Layers3 className="size-5" />
            </span>
            <div className="min-w-0">
              <p className="text-[0.68rem] font-semibold uppercase tracking-[0.14em] text-slate-500">
                Prosjektgrunnlag
              </p>
              <h2 className="mt-1.5 text-xl font-semibold tracking-tight text-slate-900">
                Velg tjenester
              </h2>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
                Valgte tjenestedokumenter brukes som leverandørkontekst i
                analyse, kravsvar og løsningsforslag for dette prosjektet.
              </p>
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-3">
            <span className="text-xs font-medium tabular-nums text-slate-500">
              <span className="text-slate-700">{selectedCount}</span>
              av {services.length} valgt
            </span>
            <Link
              href="/service-descriptions"
              className={cn(
                buttonVariants({ variant: "outline", size: "sm" }),
                "border-slate-200 text-slate-700 hover:bg-slate-50 hover:text-slate-900",
              )}
            >
              <Layers3 className="size-3.5 text-blue-700" />
              Tjenestebeskrivelser
            </Link>
          </div>
        </div>

        <div className="border-t border-slate-100 bg-slate-50/70 px-6 py-3.5 text-[0.8rem] leading-6 text-slate-500">
          Katalogen forvaltes globalt. Her velger du bare hvilke tjenester som
          hører til tilbudet, slik at endringer ikke påvirker katalogen ved et
          uhell.
        </div>
      </section>

      {error ? (
        <div
          role="alert"
        className="border-l-2 border-red-600 bg-red-50 px-4 py-3 text-sm text-red-800"
        >
          {error}
        </div>
      ) : null}

      {recommendedServices.length ? (
        <section className="border-l-2 border-amber-500 bg-amber-50/70 px-5 py-4">
          <div className="flex items-center gap-2.5">
            <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-amber-100 text-amber-700">
              <Lightbulb className="size-4" />
            </span>
            <h3 className="text-sm font-semibold tracking-tight text-amber-950">
              Relevante tjenester for prosjektet
            </h3>
          </div>
          <div className="mt-3.5 flex flex-wrap gap-2">
            {recommendedServices.map((service) => (
              <Button
                key={service.id}
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void toggleSelected(service)}
                aria-pressed={service.selected}
                disabled={selectionSaving}
                className={cn(
                  "rounded-md border-amber-300/80 bg-white text-amber-950 hover:bg-amber-100",
                  service.selected &&
                    "border-[rgb(30,58,138)] bg-blue-50/60 text-[rgb(30,58,138)] hover:bg-blue-50",
                )}
              >
                {savingSelectionIds.has(service.id) ? (
                  <Spinner className="size-3.5" />
                ) : service.selected ? (
                  <CheckCircle2 className="size-3.5" />
                ) : null}
                {service.name} · {service.recommendation_score}%
              </Button>
            ))}
          </div>
        </section>
      ) : null}

      <section className="overflow-hidden border-y border-slate-200 bg-white">
        <div className="flex flex-wrap items-end justify-between gap-3 border-b border-slate-200 bg-slate-50/70 px-6 py-4">
          <div>
            <h3 className="text-base font-semibold tracking-tight text-slate-900">
              Tjenester i katalogen
            </h3>
            <p className="mt-0.5 text-sm text-slate-500">
              Huk av tjenestene som skal inngå i prosjektets kunnskapsgrunnlag.
            </p>
          </div>
        </div>

        {services.length ? (
          <div className="divide-y divide-slate-100">
            {services.map((service) => (
              <div
                key={service.id}
                className={cn(
                  "px-6 py-4 transition-colors",
                  service.selected
                    ? "bg-blue-50/40"
                    : "bg-white hover:bg-slate-50/60",
                )}
              >
                <button
                  type="button"
                  onClick={() => void toggleSelected(service)}
                  aria-pressed={service.selected}
                  aria-busy={savingSelectionIds.has(service.id)}
                  disabled={selectionSaving}
                  className="group flex w-full min-w-0 items-start gap-3.5 text-left transition-opacity disabled:cursor-wait disabled:opacity-70"
                >
                  <span
                    className={cn(
                      "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-sm border transition-colors",
                      service.selected
                        ? "border-[rgb(30,58,138)] bg-[rgb(30,58,138)] text-white"
                        : "border-slate-300 bg-white group-hover:border-[rgb(30,58,138)]",
                    )}
                  >
                    {savingSelectionIds.has(service.id) ? (
                      <Spinner className="size-3 text-current" />
                    ) : service.selected ? (
                      <CheckCircle2 className="size-3.5" />
                    ) : null}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-semibold tracking-tight text-slate-900">
                        {service.name}
                      </span>
                      {service.recommended ? (
                        <span className="rounded-md border border-amber-200 bg-amber-50 px-2 py-0.5 text-[0.68rem] font-semibold uppercase tracking-[0.08em] text-amber-800">
                          Anbefalt
                        </span>
                      ) : null}
                      <span className="text-[0.68rem] font-medium tabular-nums text-slate-500">
                        {service.documents.length} dokument
                      </span>
                    </span>
                    {service.description ? (
                      <span className="mt-1.5 block text-sm leading-6 text-slate-600">
                        {service.description}
                      </span>
                    ) : null}
                    <span className="mt-1 block text-[0.8rem] leading-5 text-slate-500">
                      {service.recommendation_reason}
                    </span>
                  </span>
                </button>

                {service.documents.length ? (
                  <div className="mt-3 ml-[2.15rem] flex flex-wrap gap-2">
                    {service.documents.map((document) => (
                      <span
                        key={document.id}
                        className="inline-flex min-w-0 items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-600"
                      >
                        <FileText className="size-3.5 shrink-0 text-cyan-700" />
                        <span className="max-w-72 truncate">{document.title}</span>
                      </span>
                    ))}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        ) : (
          <div className="px-6 py-14 text-center">
            <span className="mx-auto flex size-12 items-center justify-center rounded-xl border border-slate-200 bg-slate-50 text-slate-400">
              <FileText className="size-5" />
            </span>
            <p className="mt-4 text-sm font-semibold tracking-tight text-slate-900">
              Ingen tjenestebeskrivelser ennå
            </p>
            <p className="mt-1 text-sm text-slate-500">
              Opprett tjenestene i den globale katalogen først.
            </p>
          </div>
        )}
      </section>
    </div>
  );
}
