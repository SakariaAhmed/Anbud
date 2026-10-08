"use client";

import { useState } from "react";
import { ArrowRight, ChevronDown, CircleHelp, Search } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { monitoringSections, rowsInPeriod, type MonitoringArea, type MonitoringPeriod, type MonitoringSnapshot, type MonitoringRow, type MonitoringTab } from "./monitoring-model";
import "./admin-monitoring.css";

const toneClass = { neutral: "monitor-neutral", good: "monitor-good", warning: "monitor-warning", error: "monitor-error" };
const snapshotAreas: MonitoringArea[] = ["health", "jobs", "documents"];
const date = (value: string) => new Intl.DateTimeFormat("nb-NO", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(value));

export function AdminMonitoring({ snapshot }: { snapshot?: MonitoringSnapshot }) {
  const [tab, setTab] = useState<MonitoringTab>("overview");
  const [period, setPeriod] = useState<MonitoringPeriod>("24h");
  const [query, setQuery] = useState("");
  const areas = monitoringSections.filter(item => item.id !== "overview");
  function rows(area: MonitoringArea) {
    if (!snapshot) return [];
    return snapshotAreas.includes(area) ? snapshot.areas[area] : rowsInPeriod(snapshot.areas[area], period, snapshot.capturedAt);
  }
  const attention = areas.flatMap(area => rows(area.id).filter(row => row.tone === "error" || row.tone === "warning").map(row => ({ ...row, area: area.id, areaLabel: area.label })));
  const selected = monitoringSections.find(item => item.id === tab)!;
  const displayRows = tab === "overview" ? [] : rows(tab);
  const filteredRows = displayRows.filter(row => `${row.title} ${row.context} ${row.status}`.toLocaleLowerCase("nb").includes(query.toLocaleLowerCase("nb")));
  const health = rows("health");
  return <section className="admin-monitoring" aria-label="Overvåking">
    <div className="monitor-heading">
      <div><p className="monitor-kicker">Overvåking</p><h2>{selected.title}</h2><p className="monitor-description">{selected.description}</p></div>
      <label className="monitor-period">Tidsrom<select aria-label="Tidsrom for overvåking" value={period} disabled={!snapshot} onChange={e => setPeriod(e.target.value as MonitoringPeriod)}><option value="24h">Siste 24 timer</option><option value="7d">Siste 7 dager</option><option value="30d">Siste 30 dager</option></select></label>
    </div>
    <div className="monitor-source" role="status"><span className="monitor-source-dot" />{snapshot ? <>Eksempeldata · målt {date(snapshot.capturedAt)} · ingen direktekobling til drift</> : <>Ingen driftsmålinger tilkoblet · sist oppdatert: ukjent</>}</div>
    <Tabs value={tab} onValueChange={value => { setTab(value as MonitoringTab); setQuery(""); }}>
      <TabsList className="monitor-tabs" variant="line" aria-label="Overvåkingsområder">{monitoringSections.map(item => <TabsTrigger className="monitor-tab" key={item.id} value={item.id}>{item.label}</TabsTrigger>)}</TabsList>
      {monitoringSections.map(item => <TabsContent key={item.id} value={item.id}>
        {item.id === "overview" ? <>
          <div className="monitor-metrics">
            <Metric label="Systemstatus" value={!snapshot ? "Ukjent" : health.some(row => row.tone === "error") ? "Avvik" : health.some(row => row.tone === "warning") ? "Redusert" : health.length && health.every(row => row.tone === "good") ? "Normal" : "Ukjent"} detail="Siste kontroll" />
            <Metric label="Feilede operasjoner" value={snapshot ? String(rows("failures").length) : "—"} detail="I valgt tidsrom" />
            <Metric label="Ventende jobber" value={snapshot ? String(rows("jobs").filter(row => row.status === "Venter").length) : "—"} detail="I kø nå" />
            <Metric label="Trenger oppfølging" value={snapshot ? String(attention.length) : "—"} detail="Registrerte avvik, ikke unike hendelser" />
          </div>
          <div className="monitor-section-heading"><h3>Trenger oppfølging</h3><span>Prioriterte avvik</span></div>
          {!snapshot ? <Unavailable /> : attention.length ? <ul className="monitor-attention">{attention.sort((a,b) => Number(b.tone === "error") - Number(a.tone === "error")).map(row => <li key={`${row.area}-${row.id}`}><span className={`monitor-status ${toneClass[row.tone]}`}>{row.status}</span><div><p>{row.title}</p><span>{row.context} · {row.areaLabel}</span></div><button onClick={() => setTab(row.area)} aria-label={`Se ${row.title}`}>Se detaljer<ArrowRight className="size-4" /></button></li>)}</ul> : <p className="monitor-empty">Ingen registrerte avvik i datagrunnlaget.</p>}
          <div className="monitor-section-heading"><h3>Alle områder</h3><span>Velg et område for detaljer</span></div>
          <div className="monitor-area-grid">{areas.map(area => <button key={area.id} onClick={() => setTab(area.id)}><span>{area.label}</span><small>{snapshot ? `${rows(area.id).length} registreringer` : "Ikke tilkoblet"}</small><ArrowRight className="size-4" /></button>)}</div>
        </> : <>
          <div className="monitor-metrics monitor-metrics-three">
            <Metric label={snapshotAreas.includes(item.id) ? "Registreringer nå" : "Registreringer i perioden"} value={snapshot ? String(displayRows.length) : "—"} detail={snapshotAreas.includes(item.id) ? "Siste tilgjengelige øyeblikksbilde" : "Avgrenset til valgt tidsrom"} />
            <Metric label="Avvik til oppfølging" value={snapshot ? String(displayRows.filter(row => row.tone === "error" || row.tone === "warning").length) : "—"} detail="Advarsler og feil" />
            <Metric label="Forrige periode" value="—" detail="Sammenligningsgrunnlag er ikke tilkoblet" />
          </div>
          <div className="monitor-section-heading"><h3>{item.label === "Innlogging" ? "Innloggings- og tilgangshendelser" : "Detaljer"}</h3><label className="monitor-search"><Search className="size-4" /><Input aria-label={`Søk i ${item.label.toLocaleLowerCase("nb")}`} placeholder="Søk i registreringer" value={query} onChange={e => setQuery(e.target.value)} disabled={!snapshot} /></label></div>
          {!snapshot ? <Unavailable /> : filteredRows.length ? <div className="monitor-records">{filteredRows.map(row => <Record key={row.id} row={row} />)}</div> : <p className="monitor-empty">Ingen registreringer passer tidsrommet og søket.</p>}
          {snapshotAreas.includes(item.id) ? <p className="monitor-footnote">Denne fanen viser siste kjente status. Tidsrommet brukes for hendelsesbaserte faner.</p> : null}
        </>}
      </TabsContent>)}
    </Tabs>
  </section>;
}
function Metric({ label, value, detail }: { label: string; value: string; detail: string }) { return <div><p>{label}</p><strong>{value}</strong><span>{detail}</span></div>; }
function Unavailable() { return <div className="monitor-empty"><CircleHelp className="size-5" /><div><h4>Målinger er ikke tilgjengelige ennå</h4><p>Dette området er klart for driftsdata. Manglende målinger betyr ukjent status.</p></div></div>; }
function Record({ row }: { row: MonitoringRow }) { return <details className="monitor-record"><summary><div><h4>{row.title}</h4><p>{row.context}</p></div><span className={`monitor-status ${toneClass[row.tone]}`}>{row.status}</span><time dateTime={row.timestamp}>{date(row.timestamp)}</time><ChevronDown className="monitor-chevron size-4" /></summary><div className="monitor-record-body"><dl>{row.facts.map(fact => <div key={fact.label}><dt>{fact.label}</dt><dd>{fact.value}</dd></div>)}</dl><p>{row.detail}</p></div></details>; }
