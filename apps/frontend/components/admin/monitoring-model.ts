export const monitoringSections = [
  { id: "overview", label: "Oversikt", title: "Drift og oppfølging", description: "Se hva som trenger oppmerksomhet, og gå videre til riktig område." },
  { id: "failures", label: "Feil", title: "Feilede operasjoner", description: "Følg feil fra handling til berørt prosjekt og neste steg." },
  { id: "jobs", label: "Jobber og kø", title: "Jobber og kø", description: "Se hva som venter, hva som kjører og hvor arbeidet har stoppet." },
  { id: "documents", label: "Dokumenter", title: "Dokumentbehandling", description: "Følg dokumentene fra opplasting til de er klare for analyse." },
  { id: "health", label: "Systemstatus", title: "Systemets avhengigheter", description: "Siste kjente kontroll av appen og tjenestene den er avhengig av." },
  { id: "performance", label: "Ytelse", title: "Tidsbruk og suksessrate", description: "Se hvilke oppgaver som tar tid, og om de fullføres." },
  { id: "usage", label: "AI-forbruk", title: "Forbruk og kostnader", description: "Fordeling per prosjekt, oppgave og modell. Kostnadene er estimater." },
  { id: "quality", label: "Resultatkvalitet", title: "Kvalitet og kildegrunnlag", description: "Følg udekkede krav, kildeproblemer, validering og tilbakemeldinger." },
  { id: "access", label: "Innlogging", title: "Innlogging og tilgang", description: "Skill mellom innloggingsfeil og manglende prosjekttilgang." },
  { id: "releases", label: "Versjoner", title: "Versjoner og utrullinger", description: "Sammenhold endringer i app og jobbkjører med driftshendelser." },
] as const;
export type MonitoringTab = typeof monitoringSections[number]["id"];
export type MonitoringArea = Exclude<MonitoringTab, "overview">;
export type MonitoringPeriod = "24h" | "7d" | "30d";
export type MonitoringRow = {
  id: string;
  title: string;
  context: string;
  status: string;
  tone: "neutral" | "good" | "warning" | "error";
  timestamp: string;
  facts: { label: string; value: string }[];
  detail: string;
};
export type MonitoringSnapshot = {
  capturedAt: string;
  source: "example";
  areas: Record<MonitoringArea, MonitoringRow[]>;
};
export function rowsInPeriod(rows: MonitoringRow[], period: MonitoringPeriod, capturedAt: string) {
  const end = Date.parse(capturedAt);
  const days = period === "24h" ? 1 : period === "7d" ? 7 : 30;
  return rows.filter(row => {
    const time = Date.parse(row.timestamp);
    return Number.isFinite(time) && time <= end && time >= end - days * 86_400_000;
  });
}
