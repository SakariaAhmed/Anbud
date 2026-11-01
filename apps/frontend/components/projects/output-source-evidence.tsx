"use client";
import { SourceEvidenceButton } from "@/components/projects/source-evidence-panel";
import { parseOutputSourceEvidence } from "@/lib/output-source-evidence";

export function OutputSourceEvidence({ value, projectId, canDownloadDocuments = false, path }: {
  value: unknown; projectId: string; canDownloadDocuments?: boolean; path?: string;
}) {
  const references = parseOutputSourceEvidence(value).references.filter(entry => !path || entry.path === path || entry.path.startsWith(`${path}.`));
  const unique = references.filter((entry, index) => references.findIndex(other => other.source.evidence_id === entry.source.evidence_id) === index);
  if (!unique.length) return null;
  return <div aria-label="Kildeutdrag for resultatet" className="flex min-w-0 flex-wrap gap-x-4 gap-y-2">
    {unique.map(({ source }) => <SourceEvidenceButton key={source.evidence_id} source={source} projectId={projectId} canDownloadDocuments={canDownloadDocuments} />)}
  </div>;
}
