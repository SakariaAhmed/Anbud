import "server-only";
import { extractRequirementLedgerForDocument } from "@/lib/server/requirements/source-ledger";
import { normalizeRequirementId } from "@/lib/server/requirements/normalization";
import type { RequirementLedgerEntry } from "@/lib/server/requirements/types";
import type { RetrievedDocumentSnippet } from "@/lib/server/document-chunks";
import type { ProjectDocumentDetail } from "@/lib/types";
import { SourceQuoteIndex } from "@/lib/server/source-evidence";

// Only persisted source snapshots are used. A changed revision or fingerprint
// gets a new ledger; a failed extraction cannot poison later requests.
const ledgers = new Map<string, Promise<RequirementLedgerEntry[]>>();
function ledger(document: ProjectDocumentDetail, fingerprint: string) {
  const key = `${document.project_id}:${document.id}:${document.chunk_source_revision ?? 0}:${fingerprint}`;
  let pending = ledgers.get(key);
  if (!pending) {
    pending = extractRequirementLedgerForDocument(document);
    ledgers.set(key, pending);
    void pending.catch(() => { if (ledgers.get(key) === pending) ledgers.delete(key); });
    while (ledgers.size > 32) ledgers.delete(ledgers.keys().next().value!);
  }
  return pending;
}

/** An ID resolves every authoritative occurrence; a solution's references
 * cannot displace the requirement. Repeated IDs remain distinct by source. */
export async function lookupRequirementSnippets(input: {
  ids: string[];
  documents: ProjectDocumentDetail[];
  fingerprints: ReadonlyMap<string, string>;
}): Promise<RetrievedDocumentSnippet[]> {
  const wanted = new Set(input.ids.map(normalizeRequirementId));
  if (!wanted.size) return [];
  const rows = await Promise.all(input.documents
    .filter(document => document.role !== "primary_solution_document")
    .map(async document => {
      const entries = await ledger(document, input.fingerprints.get(`project_document:${document.id}`)!);
      const quotations = new SourceQuoteIndex(document.raw_text);
      return entries.filter(entry => wanted.has(normalizeRequirementId(entry.id)) && entry.idOrigin !== "inferred" && entry.idOrigin !== "generated")
        .map(entry => {
          const section = document.structure_map.find(section =>
            section.text.includes(entry.id) && section.text.includes(entry.text),
          );
          const pages = entry.correctionSource?.pages ?? entry.pages;
          const wording = quotations.find(entry.text);
          const wordingAt = wording ? document.raw_text.indexOf(wording) : -1;
          const idAt = wordingAt >= 0 ? document.raw_text.lastIndexOf(entry.id, wordingAt) : -1;
          const sourceRow = wording && idAt >= 0 && wordingAt - idAt < 400
            ? document.raw_text.slice(idAt, wordingAt + wording.length) : null;
          return {
            sourceType: "project_document" as const,
            sourceId: document.id,
            documentTitle: document.title,
            kind: "requirement_row" as const,
            reference: `Krav ${entry.id}${pages.length ? ` · Side ${pages.join(", ")}` : ""}`,
            text: section && section.text.length <= 4800 ? section.text : sourceRow ?? `${entry.id} ${entry.text}`,
            headingPath: entry.heading ? [entry.heading] : [],
            pageStart: pages.length ? Math.min(...pages) : null,
            pageEnd: pages.length ? Math.max(...pages) : null,
            chunkIndex: null,
            requirementId: entry.id,
            similarity: null,
            lexicalScore: 0,
            score: 1000,
          };
        });
    }));
  return rows.flat();
}
