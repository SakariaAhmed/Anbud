import { parseChatSourceReferences } from "@/lib/chat-source-references";
import type { ChatSourceReference } from "@/lib/types";

/** Recheck every displayed quotation, including sparse chat citations, against
 * one current document revision. A saved evidence ID is historical proof. */
export async function verifyProjectSourceEvidence(projectId: string, source: ChatSourceReference, signal: AbortSignal): Promise<ChatSourceReference> {
  const unavailable = "Kunne ikke kontrollere kilden. Prøv igjen.";
  const failRequest = (error: unknown): never => {
    if (signal.aborted || error instanceof Error && error.name === "AbortError") throw error;
    throw new Error(unavailable);
  };
  const quotes = source.quotation_excerpts?.length ? source.quotation_excerpts : [source.original_quote ?? ""];
  const verified = await Promise.all(quotes.map(async quote => {
    const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/source-evidence`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ documentId: source.source_id, quote, sourceRevision: source.source_revision }), signal,
    }).catch(failRequest);
    if (response.status === 429) {
      const retryAfter = response.headers.get("Retry-After");
      const seconds = retryAfter && /^\d+$/u.test(retryAfter) ? Number(retryAfter) : null;
      throw new Error(seconds !== null && Number.isSafeInteger(seconds)
        ? `For mange kildekontroller. Vent ${seconds} ${seconds === 1 ? "sekund" : "sekunder"} før du åpner kilden igjen.`
        : "For mange kildekontroller. Vent litt før du åpner kilden igjen.");
    }
    if (!response.ok) throw new Error(response.status === 409
      ? "Kilden er endret. Oppdater resultatet og kontroller henvisningen på nytt."
      : response.status === 404
        ? "Fant ikke kilden. Oppdater prosjektet og velg en annen kildehenvisning."
      : response.status === 422
        ? "Utdraget kunne ikke kontrolleres. Bruk en fullstendig kildehenvisning, eller kontroller originaldokumentet hvis du har tilgang."
        : unavailable);
    const payload: unknown = await response.json().catch(failRequest);
    const value = payload && typeof payload === "object" && "source" in payload ? parseChatSourceReferences([payload.source])[0] : undefined;
    if (!value?.evidence_id) throw new Error(unavailable);
    return value;
  }));
  const first = verified[0];
  if (!first || verified.some(value => value.source_revision !== first.source_revision || value.source_fingerprint !== first.source_fingerprint)) {
    throw new Error("Kilden ble endret under kontrollen. Lukk kildepanelet og prøv igjen.");
  }
  const multipleLocations = verified.some(value => value.reference !== first.reference || value.page_start !== first.page_start);
  return { ...first, ...(verified.length > 1 ? { quotation_excerpts: verified.map(value => value.original_quote!) } : {}),
    ...(multipleLocations ? { heading_path: [], page_start: null, page_end: null, reference: "Flere verifiserte steder i dokumentet" } : {}),
    classification: source.classification === "interpretation" ? "interpretation" : first.classification };
}
