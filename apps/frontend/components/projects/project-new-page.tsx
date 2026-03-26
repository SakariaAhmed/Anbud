"use client";

import { useRouter } from "next/navigation";
import { FormEvent, useState } from "react";
import { ArrowLeft, LoaderCircle, Sparkles } from "lucide-react";

import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Label } from "@/components/projects/primitives";

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
      setError(err instanceof Error ? err.message : "Kunne ikke opprette prosjekt.");
      setLoading(false);
    }
  }

  return (
    <div className="min-h-[calc(100vh-3.5rem)] bg-[linear-gradient(180deg,_#f6fbff_0%,_#f3f6fb_100%)]">
      <div className="mx-auto flex w-full max-w-[980px] flex-col gap-8 px-4 py-10 md:px-6">
        <Button variant="ghost" className="w-fit" onClick={() => router.push("/")}>
          <ArrowLeft />
          Til dashboard
        </Button>

        <Card className="border border-slate-200/80 bg-white/92 shadow-none">
          <CardHeader className="gap-4 border-b border-slate-200/80 pb-6">
            <div className="flex items-center gap-3 text-sky-700">
              <Sparkles className="size-4" />
              <span className="text-sm font-medium uppercase tracking-[0.18em]">Ny analyse</span>
            </div>
            <div className="space-y-3">
              <CardTitle className="text-4xl font-semibold tracking-tight text-slate-950">
                Opprett et nytt prosjekt
              </CardTitle>
              <CardDescription className="max-w-2xl text-base leading-8 text-slate-600">
                Du kan fylle inn prosjektinfo nå, eller la Bilag 1 fylle inn prosjektnavn, kunde, domene og kort
                beskrivelse automatisk etter opplasting.
              </CardDescription>
            </div>
          </CardHeader>

          <CardContent className="pt-6">
            <form onSubmit={onSubmit} className="grid gap-6">
              <div className="grid gap-6 md:grid-cols-2">
                <div className="grid gap-2">
                  <Label htmlFor="name">Prosjektnavn</Label>
                  <Input
                    id="name"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    placeholder="La Bilag 1 foreslå navn automatisk"
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="customerName">Kunde</Label>
                  <Input
                    id="customerName"
                    value={customerName}
                    onChange={(event) => setCustomerName(event.target.value)}
                    placeholder="Valgfritt, kan fylles fra Bilag 1"
                  />
                </div>
              </div>

              <div className="grid gap-6 md:grid-cols-2">
                <div className="grid gap-2">
                  <Label htmlFor="industry">Domene / bransje</Label>
                  <Input
                    id="industry"
                    value={industry}
                    onChange={(event) => setIndustry(event.target.value)}
                    placeholder="Valgfritt, kan fylles fra Bilag 1"
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="description">Kort beskrivelse</Label>
                  <Input
                    id="description"
                    value={description}
                    onChange={(event) => setDescription(event.target.value)}
                    placeholder="Valgfritt, kan fylles fra Bilag 1"
                  />
                </div>
              </div>

              {error ? <p className="text-sm text-red-600">{error}</p> : null}

              <div className="flex flex-wrap items-center gap-3">
                <Button type="submit" size="lg" disabled={loading}>
                  {loading ? <LoaderCircle className="animate-spin" /> : null}
                  Opprett prosjekt
                </Button>
                <p className="text-sm text-slate-500">
                  Last opp Bilag 1 som primært kundedokument i neste steg for å la systemet lese og fylle inn
                  prosjektinformasjon automatisk.
                </p>
              </div>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
