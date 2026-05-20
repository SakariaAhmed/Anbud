import { GlobalServiceDescriptionsPanel } from "@/components/projects/global-service-descriptions-panel";

export default function ServiceDescriptionsPage() {
  return (
    <div className="mx-auto w-full max-w-6xl px-6 py-8 lg:px-8">
      <section className="mb-8">
        <div className="flex items-center justify-center text-center">
          <div className="mx-auto">
            <h1 className="text-[1.9rem] font-bold tracking-[-0.035em] text-foreground sm:text-[2.4rem]">
              Tjenestebeskrivelser
            </h1>
            <p className="mx-auto mt-4 max-w-2xl text-[1.05rem] font-medium leading-8 text-slate-600 md:text-[1.2rem]">
              Administrer den globale tjenestekatalogen og velg relevante
              tjenester inne på hvert tilbudsprosjekt.
            </p>
          </div>
        </div>
      </section>

      <GlobalServiceDescriptionsPanel />
    </div>
  );
}
