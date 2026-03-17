"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function NewBidForm() {
  const router = useRouter();
  const [customerName, setCustomerName] = useState("");
  const [title, setTitle] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError("");

    try {
      const response = await fetch("/api/v1/bids", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-tenant-id": "default",
        },
        body: JSON.stringify({
          customer_name: customerName,
          title,
        }),
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { detail?: string };
        throw new Error(payload.detail || `Kunne ikke opprette sak (${response.status})`);
      }

      const payload = (await response.json()) as { id: string };
      router.push(`/bids/${payload.id}`);
      router.refresh();
    } catch (submissionError) {
      setError(submissionError instanceof Error ? submissionError.message : "Noe gikk galt");
      setLoading(false);
    }
  }

  return (
    <Card className="border border-foreground/10 bg-white/80 shadow-[0_24px_80px_rgba(15,23,42,0.08)] backdrop-blur">
      <CardHeader>
        <CardTitle>Ny analyse</CardTitle>
        <CardDescription>
          Opprett en sak og gå rett til opplasting av Bilag 1 og Bilag 2.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form className="grid gap-4 md:grid-cols-[1.1fr_1fr_auto]" onSubmit={onSubmit}>
          <div className="grid gap-1.5">
            <Label htmlFor="customer_name">Kunde</Label>
            <Input
              id="customer_name"
              value={customerName}
              onChange={(event) => setCustomerName(event.target.value)}
              placeholder="Statens vegvesen"
              required
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="title">Tittel</Label>
            <Input
              id="title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="Drift av skyplattform"
            />
          </div>
          <div className="flex items-end">
            <Button className="w-full md:w-auto" disabled={loading} type="submit">
              {loading ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
              Opprett
            </Button>
          </div>
        </form>
        {error ? <p className="mt-3 text-sm text-destructive">{error}</p> : null}
      </CardContent>
    </Card>
  );
}
