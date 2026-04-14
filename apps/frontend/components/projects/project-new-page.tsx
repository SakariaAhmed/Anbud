"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useState } from "react";
import { ArrowLeft, ChevronRight } from "lucide-react";

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
    <div className="mx-auto w-full max-w-2xl px-6 py-8 lg:px-0">
      {/* Breadcrumb */}
      <nav className="mb-6 flex items-center gap-1.5 text-xs text-muted-foreground">
        <Link href="/" className="hover:text-foreground transition-colors">Prosjekter</Link>
        <ChevronRight className="size-3" />
        <span className="text-foreground font-medium">Nytt prosjekt</span>
      </nav>

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
