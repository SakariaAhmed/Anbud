import { BidList } from "@/components/bid-list";
import { NewBidForm } from "@/components/new-bid-form";
import { getBidsForPage } from "@/lib/server/bids-db";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const bids = await getBidsForPage();

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-[1500px] flex-col gap-8 px-4 py-8 md:px-8 lg:py-12">
      <section className="grid gap-6 lg:grid-cols-[1.2fr_0.8fr] lg:items-end">
        <div className="space-y-4">
          <p className="text-xs font-medium uppercase tracking-[0.32em] text-slate-500">ANBUD</p>
          <h1 className="max-w-4xl text-4xl font-semibold tracking-tight text-slate-950 md:text-6xl">
            Bilag 1 og Bilag 2, strippet ned til ren krav- og compliance-kontroll.
          </h1>
          <p className="max-w-3xl text-base leading-7 text-slate-600">
            Denne flaten er optimalisert for en skyarkitekt som trenger rask scanning, tydelig sporbarhet til kilde og
            få klikk fra dokument til beslutning.
          </p>
        </div>

        <div className="rounded-[2rem] border border-slate-200 bg-white/80 p-5 shadow-[0_24px_80px_rgba(15,23,42,0.08)]">
          <div className="grid gap-3 text-sm text-slate-700">
            <div className="rounded-2xl bg-slate-50 px-4 py-3">1. Last opp Bilag 1 og Bilag 2</div>
            <div className="rounded-2xl bg-slate-50 px-4 py-3">2. Generer kravmatrise og kundeanalyse</div>
            <div className="rounded-2xl bg-slate-50 px-4 py-3">3. Vurder Besvart, Delvis og Ikke besvart</div>
          </div>
        </div>
      </section>

      <NewBidForm />

      <section className="grid gap-4">
        <div className="flex items-end justify-between gap-4">
          <div>
            <h2 className="text-2xl font-semibold tracking-tight text-slate-950">Aktive saker</h2>
            <p className="text-sm text-slate-600">
              Statuslinjen viser om Bilag 1, Bilag 2 og analysen er på plass, samt hvor mange krav som fortsatt mangler.
            </p>
          </div>
          <div className="text-sm text-slate-500">{bids.length} saker</div>
        </div>
        <BidList bids={bids} />
      </section>
    </main>
  );
}
