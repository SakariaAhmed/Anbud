"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useEffect, useState } from "react";
import { ArrowLeft, CheckCircle2, LockKeyhole } from "lucide-react";

import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { getClientCache, setClientCache } from "@/lib/client-cache";
import type { ServiceDescription } from "@/lib/types";

const SERVICE_DESCRIPTIONS_CACHE_KEY = "service-descriptions";
const SERVICE_DESCRIPTIONS_CACHE_TTL_MS = 5 * 60 * 1000;

export function ProjectNewPage() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [customerName, setCustomerName] = useState("");
  const [industry, setIndustry] = useState("");
  const [description, setDescription] = useState("");
  const [services, setServices] = useState<ServiceDescription[]>([]);
  const [selectedServiceIds, setSelectedServiceIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    const cached = getClientCache<ServiceDescription[]>(
      SERVICE_DESCRIPTIONS_CACHE_KEY,
    );
    if (cached) {
      setServices(cached);
      return () => {
        cancelled = true;
      };
    }

    fetch("/api/service-descriptions")
      .then(async (response) => {
        const payload = (await response.json()) as {
          services?: ServiceDescription[];
        };
        if (!cancelled && response.ok) {
          const nextServices = payload.services ?? [];
          setServices(nextServices);
          setClientCache(
            SERVICE_DESCRIPTIONS_CACHE_KEY,
            nextServices,
            SERVICE_DESCRIPTIONS_CACHE_TTL_MS,
          );
        }
      })
      .catch(() => {
        if (!cancelled) {
          setServices([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          customer_name: customerName,
          industry,
          description,
          selected_service_ids: selectedServiceIds,
        }),
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || "Kunne ikke opprette prosjekt.");
      }
      router.push(`/projects/${payload.id}`);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Kunne ikke opprette prosjekt.",
      );
      setLoading(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-2xl px-6 py-8 lg:px-0">
      <div className="rounded-md border border-border bg-card shadow-sm">
        <div className="border-b border-border px-6 py-4">
          <h1 className="text-lg font-bold tracking-tight text-foreground">
            Opprett nytt prosjekt
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Fyll inn prosjektinfo, eller la Bilag 1 fylle inn automatisk etter opplasting.
          </p>
        </div>

        <form onSubmit={onSubmit} className="p-6">
          <div className="space-y-5">
            <div className="grid gap-5 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="name" className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Prosjektnavn
                </Label>
                <Input
                  id="name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="La Bilag 1 foreslå navn automatisk"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="customerName" className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Kunde
                </Label>
                <Input
                  id="customerName"
                  value={customerName}
                  onChange={(e) => setCustomerName(e.target.value)}
                  placeholder="Valgfritt"
                />
              </div>
            </div>

            <div className="grid gap-5 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="industry" className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Domene / bransje
                </Label>
                <Input
                  id="industry"
                  value={industry}
                  onChange={(e) => setIndustry(e.target.value)}
                  placeholder="Valgfritt"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="description" className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Kort beskrivelse
                </Label>
                <Input
                  id="description"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Valgfritt"
                />
              </div>
            </div>
          </div>

          {services.length ? (
            <div className="mt-6 rounded-xl border border-slate-200 bg-slate-50/70 p-4">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Tjenestebeskrivelser
                  </p>
                  <p className="mt-1 text-sm text-slate-600">
                    Faste tjenester blir alltid med. Velg relevante prosjektspesifikke tjenester nå, eller gjør det senere i prosjektet.
                  </p>
                </div>
              </div>
              <div className="mt-4 grid gap-2">
                {services.map((service) => {
                  const fixed = service.inclusion_mode === "fixed";
                  const selected = fixed || selectedServiceIds.includes(service.id);
                  return (
                    <button
                      key={service.id}
                      type="button"
                      disabled={fixed}
                      onClick={() =>
                        setSelectedServiceIds((current) =>
                          current.includes(service.id)
                            ? current.filter((id) => id !== service.id)
                            : [...current, service.id],
                        )
                      }
                      className={`flex items-center justify-between gap-3 rounded-lg border px-3 py-2 text-left ${
                        selected
                          ? "border-slate-950 bg-white text-slate-950"
                          : "border-slate-200 bg-white text-slate-600"
                      }`}
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-semibold">
                          {service.name}
                        </span>
                        <span className="mt-0.5 block text-xs text-slate-500">
                          {service.documents.length} dokument
                        </span>
                      </span>
                      {fixed ? (
                        <LockKeyhole className="size-4 shrink-0 text-slate-500" />
                      ) : selected ? (
                        <CheckCircle2 className="size-4 shrink-0 text-slate-950" />
                      ) : null}
                    </button>
                  );
                })}
              </div>
            </div>
          ) : null}

          {error ? (
            <p className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p>
          ) : null}

          <div className="mt-6 flex items-center justify-between border-t border-border pt-5">
            <Link
              href="/"
              className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "gap-1.5 text-muted-foreground")}
            >
              <ArrowLeft className="size-3.5" />
              Avbryt
            </Link>
            <Button type="submit" disabled={loading}>
              {loading ? <Spinner className="size-4" /> : null}
              Opprett prosjekt
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
