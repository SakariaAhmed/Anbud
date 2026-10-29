import { GlobalServiceDescriptionsPanel } from "@/components/projects/global-service-descriptions-panel";

export default function ServiceDescriptionsPage() {
  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 lg:px-8">
      <section className="mb-5">
        <div className="flex items-center">
          <div >
            <h1 className="text-xl font-semibold text-foreground">
              Tjenestebeskrivelser
            </h1>
          </div>
        </div>
      </section>

      <GlobalServiceDescriptionsPanel />
    </div>
  );
}
