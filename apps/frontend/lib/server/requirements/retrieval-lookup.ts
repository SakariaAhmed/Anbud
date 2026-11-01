import "server-only";
import { assertProjectWorkflowActive } from "@/lib/server/project-workflow-cancellation";
import { rethrowAuthoritativeLeaseLoss } from "@/lib/server/repositories/lease-fenced-persistence";
import { safeErrorTelemetry } from "@/lib/server/safe-errors";
import { extractRequirementLedgerForDocument } from "@/lib/server/requirements/source-ledger";
import { findPdfPageMarkers } from "@/lib/server/requirements/pdf-normalization";
import { extractRequirementIdentifiers, requirementIdentifierSpans } from "@/lib/server/ai/retrieval-query";
import { normalizeRequirementId } from "@/lib/server/requirements/normalization";
import type { RequirementLedgerEntry } from "@/lib/server/requirements/types";
import type { RetrievedDocumentSnippet } from "@/lib/server/document-chunks";
import type { ProjectDocumentDetail } from "@/lib/types";
import { SourceQuoteIndex } from "@/lib/server/source-evidence";
import { readDocumentRequirementRegister } from "@/lib/server/document-intelligence/repository";
import { isRequirementDocument } from "@/lib/document-processing";

// Only persisted source snapshots are used. A changed revision or fingerprint
// gets a new ledger; a failed extraction cannot poison later requests.
const ledgers = new Map<string, Promise<RequirementLedgerEntry[]>>();
function ledger(document: ProjectDocumentDetail, fingerprint: string) {
  const key = `${document.project_id}:${document.id}:${document.chunk_source_revision ?? 0}:${fingerprint}`;
  let pending = ledgers.get(key);
  if (!pending) {
    pending = readDocumentRequirementRegister({ documentId: document.id, projectId: document.project_id, sourceRevision: document.chunk_source_revision ?? 0 })
      .then(stored => stored ?? extractRequirementLedgerForDocument(document));
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
  onSourceFailure?: (documentId: string) => void;
}): Promise<RetrievedDocumentSnippet[]> {
  const wanted = new Set(input.ids.map(normalizeRequirementId));
  if (!wanted.size) return [];
  const rows = await Promise.all(input.documents
    .filter(document => isRequirementDocument(document) && extractRequirementIdentifiers(document.raw_text).some(id => wanted.has(normalizeRequirementId(id))))
    .map(async document => {
      try {
        const entries = await ledger(document, input.fingerprints.get(`project_document:${document.id}`)!);
        return entries.filter(entry => wanted.has(normalizeRequirementId(entry.id)) && entry.idOrigin !== "inferred" && entry.idOrigin !== "generated")
          .flatMap(entry => {
            const source = entry.correctionSource
              ? input.documents.find(source => source.id === entry.correctionSource!.documentId)
              : document;
            if (!source) return [];
            const pages = entry.correctionSource?.pages ?? entry.pages;
            const markers = findPdfPageMarkers(source.raw_text);
            const sourceParts = pages.length && markers.length
              ? markers.flatMap((marker, index) => pages.some(page => page >= marker.startPage && page <= marker.endPage)
                ? [source.raw_text.slice(marker.index + marker.marker.length, markers[index + 1]?.index ?? source.raw_text.length)] : [])
              : [source.raw_text];
            const target = entry.correctionSource?.excerpt ?? entry.text;
            let passage: string | null = null;
            for (const part of sourceParts) {
              const quotations = new SourceQuoteIndex(part);
              const quotedWording = entry.correctionSource ? [...target.matchAll(/[«“"]([^»”"]+)[»”"]/gu)].map(match => match[1]).reverse() : [];
              const found = quotations.find(target) ?? quotedWording.map(quote => quotations.find(quote)).find(Boolean);
              if (!found) continue;
              if (extractRequirementIdentifiers(found).includes(entry.id)) { passage = found; break; }
              const wordingAt = part.indexOf(found);
              const normalizedDashes = part.replace(/[‐‑‒–—]/gu, "-");
              let idAt = normalizedDashes.lastIndexOf(entry.id, wordingAt);
              while (idAt >= 0 && (/[\p{L}\p{N}.-]/u.test(normalizedDashes[idAt - 1] ?? " ") || /[\p{L}\p{N}.-]/u.test(normalizedDashes[idAt + entry.id.length] ?? " "))) {
                idAt = idAt > 0 ? normalizedDashes.lastIndexOf(entry.id, idAt - 1) : -1;
              }
              if (idAt >= 0 && wordingAt - idAt < 400 && !extractRequirementIdentifiers(part.slice(idAt, wordingAt)).some(id => id !== entry.id)) { passage = part.slice(idAt, wordingAt + found.length); break; }
            }
            if (!passage && !entry.correctionSource) {
              for (const part of sourceParts) {
                const starts = requirementIdentifierSpans(part).filter(span => /^[\t |>*-]*$/u.test(part.slice(part.lastIndexOf("\n", span.start - 1) + 1, span.start)));
                const row = starts.findIndex(span => span.id === normalizeRequirementId(entry.id));
                if (row < 0) continue;
                const original = part.slice(starts[row].start, Math.min(starts[row + 1]?.start ?? part.length, starts[row].start + 2000)).trim();
                // A literal source row can survive parser-normalized casing,
                // table labels and trailing headings. Never invent its wording
                // or promote a cross-reference in a prose sentence to a row.
                if (/\b(?:skal|bør|må|shall|must|should)\b/iu.test(original)) { passage = original; break; }
              }
            }
            // Corrected requirements may be reconstructions of several source
            // phrases. Never publish the reconstruction as an original quotation.
            if (!passage) return [];
            const occurrence = source.raw_text.indexOf(passage);
            const uniqueOccurrence = source.raw_text.indexOf(passage, occurrence + passage.length) < 0;
            const marker = uniqueOccurrence ? markers.find((marker, index) => occurrence >= marker.index + marker.marker.length && occurrence + passage.length <= (markers[index + 1]?.index ?? source.raw_text.length)) : undefined;
            const locatedPages = marker ? [marker.startPage, marker.endPage] : pages;
            const sections = !entry.correctionSource ? source.structure_map.filter(section => section.text.includes(passage!) && section.text.length <= 4800 && (!entry.heading || section.heading_path?.includes(entry.heading) || section.reference.includes(entry.heading))) : [];
            const section = sections.length === 1 ? sections[0] : undefined;
            return [{
              sourceType: "project_document" as const,
              sourceId: source.id,
              documentTitle: source.title,
              kind: "requirement_row" as const,
              reference: `Krav ${entry.id}${locatedPages.length ? ` · Side ${Array.from(new Set(locatedPages)).join(", ")}` : ""}`,
              text: section ? section.text : passage,
              headingPath: entry.correctionSource ? (entry.correctionSource.heading ? [entry.correctionSource.heading] : []) : (entry.heading ? [entry.heading] : []),
              pageStart: locatedPages.length ? Math.min(...locatedPages) : null,
              pageEnd: locatedPages.length ? Math.max(...locatedPages) : null,
              chunkIndex: null,
              requirementId: entry.id,
              similarity: null,
              lexicalScore: 0,
              score: 1000,
            }];
          });
      } catch (error) {
        rethrowAuthoritativeLeaseLoss(error);
        assertProjectWorkflowActive();
        if (error instanceof Error && error.name === "AbortError") throw error;
        input.onSourceFailure?.(document.id);
        console.warn(JSON.stringify({ event: "requirement_lookup_source_unavailable", document_id: document.id, ...safeErrorTelemetry(error) }));
        return [];
      }
    }));
  return rows.flat();
}
