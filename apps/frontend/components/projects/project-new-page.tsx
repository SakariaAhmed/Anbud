"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useState } from "react";
import { ArrowLeft } from "lucide-react";

import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

export function ProjectNewPage() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [customerName, setCustomerName] = useState("");
  const [industry, setIndustry] = useState("");
  const [description, setDescription] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

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
    <div className="mx-auto w-full max-w-2xl px-4 py-6 lg:px-0">
      <Link
        href="/"
        className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "-ml-2 mb-4 gap-1.5 text-muted-foreground")}
      >
        <ArrowLeft className="size-3.5" />
        Tilbake
      </Link>

      <h1 className="text-2xl font-bold tracking-tight text-foreground">
        Opprett et nytt prosjekt
      </h1>
      <p className="mt-1.5 text-base text-foreground/70">
        Du kan fylle inn prosjektinfo nå, eller la Bilag 1 fylle inn
        prosjektnavn, kunde, domene og kort beskrivelse automatisk etter
        opplasting.
      </p>

      <form onSubmit={onSubmit} className="mt-6 space-y-4 rounded-lg border p-5 shadow-sm">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="name">Prosjektnavn</Label>
            <Input
              id="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="La Bilag 1 foreslå navn automatisk"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="customerName">Kunde</Label>
            <Input
              id="customerName"
              value={customerName}
              onChange={(e) => setCustomerName(e.target.value)}
              placeholder="Valgfritt, kan fylles fra Bilag 1"
            />
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="industry">Domene / bransje</Label>
            <Input
              id="industry"
              value={industry}
              onChange={(e) => setIndustry(e.target.value)}
              placeholder="Valgfritt, kan fylles fra Bilag 1"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="description">Kort beskrivelse</Label>
            <Input
              id="description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Valgfritt, kan fylles fra Bilag 1"
            />
          </div>
        </div>

        {error ? (
          <p className="text-sm text-destructive">{error}</p>
        ) : null}

        <div className="flex flex-wrap items-center gap-3 border-t pt-4">
          <Button type="submit" disabled={loading}>
            {loading ? <Spinner className="size-4" /> : null}
            Opprett prosjekt
          </Button>
          <p className="text-xs text-muted-foreground">
            Last opp Bilag 1 som primært kundedokument i neste steg for å la
            systemet lese og fylle inn prosjektinformasjon automatisk.
          </p>
        </div>
      </form>
    </div>
  );
}
