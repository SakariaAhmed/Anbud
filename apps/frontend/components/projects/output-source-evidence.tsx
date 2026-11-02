"use client";
import { useMemo, useState } from "react";
import { SourceEvidenceButton } from "@/components/projects/source-evidence-panel";
import { parseOutputSourceEvidence } from "@/lib/output-source-evidence";

export function OutputSourceEvidence({ value, projectId, canDownloadDocuments = false, path, excludePaths = [], collapsible = false }: {
  value: unknown; projectId: string; canDownloadDocuments?: boolean; path?: string; excludePaths?: string[]; collapsible?: boolean;
}) {
  const manifest = useMemo(() => parseOutputSourceEvidence(value), [value]);
  const [expanded, setExpanded] = useState(false);
  const matches = (at: string) => (!path || at === path || at.startsWith(`${path}.`)) && !excludePaths.some(prefix => at === prefix || at.startsWith(`${prefix}.`));
  const references = manifest.references.filter(entry => matches(entry.path));
  const issues = manifest.issues?.filter(entry => matches(entry.path)) ?? [];
  const unique = references.filter((entry, index) => references.findIndex(other => other.source.evidence_id === entry.source.evidence_id) === index);
  if (!unique.length && !issues.length) return null;
  const links = () => <div className="flex min-w-0 flex-wrap gap-x-4 gap-y-2">{unique.map(({ source }) => <SourceEvidenceButton key={source.evidence_id} source={source} projectId={projectId} canDownloadDocuments={canDownloadDocuments} />)}</div>;
  return <div aria-label="Kildeutdrag for resultatet" className="min-w-0 space-y-2">
    {issues.length ? <p role="status" className="text-xs leading-5 text-amber-900">Må avklares: {issues.length} formulering{issues.length === 1 ? "" : "er"} ble holdt tilbake. Kontroller originalkildene før dette resultatet brukes.</p> : null}
    {unique.length ? collapsible || unique.length > 6 ? <details onToggle={event => setExpanded(event.currentTarget.open)}><summary className="cursor-pointer text-xs font-medium text-primary outline-offset-4 focus-visible:outline-2 focus-visible:outline-ring">Vis {unique.length} kildeutdrag</summary>{expanded ? <div className="mt-2 max-h-64 overflow-y-auto pr-1">{links()}</div> : null}</details> : links() : null}
  </div>;
}
