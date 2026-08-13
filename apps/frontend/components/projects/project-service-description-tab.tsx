"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CheckCircle2,
  ExternalLink,
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
      <div className="flex items-center gap-2 rounded-xl border border-border/70 bg-card px-5 py-6 text-sm text-muted-foreground">
        <Spinner className="size-4" />
        Laster tjenestekatalog ...
      </div>
    );
  }

  return (
    <div className="min-w-0 space-y-6">
      <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-200 bg-slate-50 px-5 py-5">
          <div className="flex items-start gap-3">
            <span className="flex size-11 shrink-0 items-center justify-center rounded-lg bg-slate-950 text-white">
              <Layers3 className="size-5" />
            </span>
            <div className="min-w-0">
              <p className="text-xs font-bold uppercase tracking-[0.14em] text-slate-500">
                Prosjektgrunnlag
              </p>
              <h2 className="mt-1 text-xl font-bold text-slate-950">
                Velg tjenester
              </h2>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
                Valgte tjenestedokumenter brukes som leverandørkontekst i
                analyse, kravsvar og løsningsforslag for dette prosjektet.
              </p>
            </div>
          </div>
          <Link
            href="/service-descriptions"
            className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
          >
            Administrer katalog
            <ExternalLink className="size-3.5" />
          </Link>
        </div>

        <div className="px-5 py-4 text-sm text-slate-600">
          Katalogen forvaltes globalt. Her velger du bare hvilke tjenester som
          hører til tilbudet, slik at endringer ikke påvirker katalogen ved et
          uhell.
        </div>
      </section>

      {error ? (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          {error}
        </div>
      ) : null}

      {recommendedServices.length ? (
        <section className="rounded-xl border border-amber-200 bg-amber-50 px-5 py-4">
          <div className="flex items-center gap-2 text-sm font-bold text-amber-950">
            <Lightbulb className="size-4" />
            Relevante tjenester for prosjektet
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            {recommendedServices.map((service) => (
              <Button
                key={service.id}
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void toggleSelected(service)}
                aria-pressed={service.selected}
                disabled={selectionSaving}
                className="border-amber-300 bg-white text-amber-950 hover:bg-amber-100"
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

      <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="border-b border-slate-200 bg-slate-50 px-5 py-4">
          <h3 className="text-sm font-bold text-slate-950">
            Tjenester i katalogen
          </h3>
          <p className="mt-1 text-sm text-slate-500">
            Huk av tjenestene som skal inngå i prosjektets kunnskapsgrunnlag.
          </p>
        </div>

        {services.length ? (
          <div className="divide-y divide-slate-200">
            {services.map((service) => (
              <div key={service.id} className="px-5 py-4">
                <button
                  type="button"
                  onClick={() => void toggleSelected(service)}
                  aria-pressed={service.selected}
                  aria-busy={savingSelectionIds.has(service.id)}
                  disabled={selectionSaving}
                  className="group flex w-full min-w-0 items-start gap-3 text-left transition-opacity disabled:cursor-wait disabled:opacity-70"
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
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-bold text-slate-950">
                        {service.name}
                      </span>
                      {service.recommended ? (
                        <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-bold text-amber-900">
                          Anbefalt
                        </span>
                      ) : null}
                      <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-600">
                        {service.documents.length} dokument
                      </span>
                    </span>
                    {service.description ? (
                      <span className="mt-1 block text-sm leading-5 text-slate-600">
                        {service.description}
                      </span>
                    ) : null}
                    <span className="mt-1 block text-sm text-slate-500">
                      {service.recommendation_reason}
                    </span>
                  </span>
                </button>

                {service.documents.length ? (
                  <div className="mt-3 ml-8 flex flex-wrap gap-2">
                    {service.documents.map((document) => (
                      <span
                        key={document.id}
                        className="inline-flex min-w-0 items-center gap-1.5 rounded-md bg-slate-50 px-2.5 py-1.5 text-xs font-medium text-slate-600"
                      >
                        <FileText className="size-3.5 shrink-0 text-teal-700" />
                        <span className="max-w-72 truncate">{document.title}</span>
                      </span>
                    ))}
                  </div>
                ) : null}
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
              Opprett tjenestene i den globale katalogen først.
            </p>
          </div>
        )}
      </section>
    </div>
  );
}
