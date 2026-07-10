import "server-only";

export type PdfPageText = {
  page: number;
  pageEnd?: number;
  text: string;
};

export type PdfPageMarker = {
  startPage: number;
  endPage: number;
  index: number;
  marker: string;
};

const PDF_PAGE_MARKER_PATTERN = /\[\[SIDE:(\d{1,5})(?:-(\d{1,5}))?\]\]/g;

export function findPdfPageMarkers(rawText: string): PdfPageMarker[] {
  return [...rawText.matchAll(PDF_PAGE_MARKER_PATTERN)]
    .map((match) => {
      const startPage = Number(match[1]);
      const endPage = Number(match[2] ?? match[1]);
      return {
        startPage,
        endPage: Math.max(startPage, endPage),
        index: match.index ?? 0,
        marker: match[0],
      };
    })
    .filter(
      (marker) =>
        Number.isFinite(marker.startPage) &&
        Number.isFinite(marker.endPage) &&
        marker.startPage > 0,
    );
}

function splitPdfPageBlocks(
  rawText: string,
  normalize: (value: string) => string,
): PdfPageText[] {
  const markers = findPdfPageMarkers(rawText);
  const pages: PdfPageText[] = [];

  for (const [index, marker] of markers.entries()) {
    const nextMarker = markers[index + 1];
    const textStart = marker.index + marker.marker.length;
    const textEnd = nextMarker?.index ?? rawText.length;
    const text = normalize(rawText.slice(textStart, textEnd));

    if (text) {
      pages.push({
        page: marker.startPage,
        pageEnd: marker.endPage,
        text,
      });
    }
  }

  return pages;
}

export function splitPdfPages(rawText: string): PdfPageText[] {
  return splitPdfPageBlocks(rawText, normalizePageText);
}

export function splitPdfPagesPreservingLines(rawText: string): PdfPageText[] {
  return splitPdfPageBlocks(rawText, (value) =>
    value
      .replace(/\r\n/g, "\n")
      .replace(/\bSide\s+\d+\s+av\s+\d+\b/gi, " ")
      .replace(/\bSide\s*\d+\s*av\s*\d+\b/gi, " ")
      .replace(/\bKonfidensiell\b/gi, " ")
      .replace(/\bRA\s*-\s*\d+\s*B\s*I\s*L\s*A\s*G\s*[\d,.\s]+\s*TIL\s*SSA\s*-\s*D\s*\d{4}\b/gi, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim(),
  );
}

function repairPdfWordFragments(value: string) {
  return value
    .replace(/\bi(?=Leveransen\b)/g, "i ")
    .replace(/\bavLeveransen\b/gi, "av Leveransen")
    .replace(/\b(Leveransen)i\b/gi, "$1 i")
    .replace(/\b(levere|leverer|levert)(Leveransen)i\b/gi, "$1 $2 i")
    .replace(/\b(levere|leverer|levert)(?=(?:Leveranse|Leveransen|Leveransens)\b)/gi, "$1 ")
    .replace(/\b(Leveransen)i\b/gi, "$1 i")
    .replace(/\b(ny|nye)(?=(?:Leverandør|Leverandøren|Leverandørens)\b)/gi, "$1 ")
    .replace(
      /\b(for|av|til|fra|under|over|i|på|mot|hos|med|som|at|om|skal|må|kan|bør|og|eller)(?=(?:Leveranse|Leveransen|Leveransens|Leverandøren|Leverandørens|Kunden|Kundens|Kunde)\b)/gi,
      "$1 ",
    )
    .replace(
      /\b(for|av|til|fra|under|over|i|på|mot|hos|med|som|at|om|skal|må|kan|bør|og|eller)(?=(?:Kunden|Kunde|Leverandøren|Leverandør)(?:har|er|skal|må|kan|bør|forbeholder)\b)/gi,
      "$1 ",
    )
    .replace(
      /\b(Kunden|Kunde|Leverandøren|Leverandør)(?=(?:har|er|skal|må|kan|bør|forbeholder)\b)/gi,
      "$1 ",
    )
    .replace(/\bunderleverandør\s+er\b/gi, "underleverandører")
    .replace(
      /\b(alle|aktuelle|diverse|disse|eventuelle|eksisterende|involverte|nye|relevante|øvrige)\s+leverandør\s+er\b/gi,
      "$1 leverandører",
    )
    .replace(/(^|[^\p{L}\p{N}_])åiverksetterutiner(?=$|[^\p{L}\p{N}_])/giu, "$1å iverksette rutiner")
    .replace(/(^|[^\p{L}\p{N}_])åiverksette(?=$|[^\p{L}\p{N}_])/giu, "$1å iverksette")
    .replace(/(^|[^\p{L}\p{N}_])åiverksette(?=\p{L})/giu, "$1å iverksette ")
    .replace(/\bforvidere\b/gi, "for videre")
    .replace(/\btilå\b/gi, "til å")
    .replace(/\bLeverandørenbesbeskrive\b/gi, "Leverandøren bes beskrive")
    .replace(/\bLeverandørenbes\s+beskrive\b/gi, "Leverandøren bes beskrive")
    .replace(/\bLeverandørenbes\b/gi, "Leverandøren bes")
    .replace(
      /\binformasjons-ogITsikkerhet(en)?\b/gi,
      "informasjons- og IT-sikkerhet$1",
    )
    .replace(/\bogITsikkerhet(en)?\b/gi, "og IT-sikkerhet$1")
    .replace(/\bfag-\s*og\b/gi, "fag- og")
    .replace(/\bopp\s+(gave(?:r|ne)?)\b/gi, "opp$1")
    .replace(/\barbeids\s+(stasjon(?:er|ene)?)\b/gi, "arbeids$1")
    .replace(
      /\btredjeparts\s+(programvare|leverandør(?:er|ene)?)\b/gi,
      "tredjeparts$1",
    )
    .replace(/\bplattform\s+(komponent(?:er|ene)?)\b/gi, "plattform$1")
    .replace(/\bdrifts\s+(løsning(?:en|er)?|leveranse(?:n|r)?)\b/gi, "drifts$1")
    .replace(/\btilgangs\s+(styring|kontroll|prosess(?:en|er)?)\b/gi, "tilgangs$1")
    .replace(
      /\b(på|mot|med|for|av|alle|eventuelle|øvrige|diverse|disse|nye|eksisterende)\s+(underleverandør|leverandør)\s+er\b/gi,
      "$1 $2er",
    )
    .replace(/\bbakgrunns\s+(sjekk|kontroll(?:en)?)\b/gi, "bakgrunns$1")
    .replace(/\bsanksjons\s+(screening|kontroll(?:en)?)\b/gi, "sanksjons$1")
    .replace(/\bunder\s+(leverandør(?:er|ene)?)\b/gi, "under$1")
    .replace(/\bunderleverandør\s+er\b/gi, "underleverandører")
    .replace(/\bgo-\s+live\b/gi, "go-live");
}

export function normalizePageText(value: string) {
  return repairPdfWordFragments(value)
    .replace(/[‐‑‒–—]/g, "-")
    .replace(/\bSide\s+\d+\s+av\s+\d+\b/gi, " ")
    .replace(/\bSide\s*\d+\s*av\s*\d+\b/gi, " ")
    .replace(/\bKonfidensiell\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function documentRequirementId(value: string) {
  return normalizePageText(value)
    .replace(
      /\bID\s*(\d{1,3})\s*[-.]\s*(\d{1,3})\s*[-.]\s*(\d{1,3}[A-Z]?)\b/gi,
      "ID $1-$2-$3",
    )
    .replace(
      /\bID\s*(\d{1,3})\s*[-.]\s*(\d{1,3}[A-Z]?)\b/gi,
      "ID $1-$2",
    )
    .replace(/\s+([,;:])/g, "$1")
    .trim();
}

export function normalizePdfSpacing(value: string) {
  return repairPdfWordFragments(value)
    .replace(/[‐‑‒–—]/g, "-")
    .replace(/\bI\s*D\b/gi, "ID")
    .replace(/\bkr\s*a\s*v\b/gi, "krav")
    .replace(/\bTa\s*b\s*e\s*ll\b/gi, "Tabell")
    .replace(/\bD\s*el\b/gi, "Del")
    .replace(/\bL\s*ever\s*a\s*ndør\s*ens\s*sva\s*r\b/gi, "Leverandørens svar")
    .replace(/\bT\s*j\s*eneste\b/gi, "Tjeneste")
    .replace(/\bSpesi\s*f\s*i\s*ser\s*te\s*kr\s*a\s*v\b/gi, "Spesifiserte krav")
    .replace(/\bD\s*eta\s*l\s*j\s*er\s*i\s*ng\s*er\b/gi, "Detaljeringer")
    .replace(/\bSide\s*(\d+)\s*av\s*(\d+)\b/gi, "Side $1 av $2")
    .replace(/\b(\d+)\s*TIL\s*SSA\s*-\s*D\s*(\d{4})\b/gi, "$1 TIL SSA-D $2")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizePdfReferenceTypography(value: string) {
  let text = normalizePdfSpacing(value)
    .replace(/\b(Tabell\s+ID\s+\d{1,3})\s*[-.]\s*(\d{1,3}[A-Z]?)\b/gi, "$1-$2")
    .replace(
      /\bID\s+(\d{1,3})\s*[-.]\s*(\d{1,3})\s*[-.]\s*(\d{1,3}[A-Z]?)\b/gi,
      "ID $1-$2-$3",
    )
    .replace(
      /\bID\s*(\d{1,3})\s*[-.]\s*(\d{1,3}[A-Z]?)\b/gi,
      "ID $1-$2",
    );

  for (let index = 0; index < 4; index += 1) {
    const next = text
      .replace(/\b(\p{Lu}[\p{Ll}]{2,})\s+(\p{Ll})\s+(\p{Ll}{2,})\b/gu, "$1$2$3")
      .replace(/\b([A-ZÆØÅ]{2,})\s+([A-ZÆØÅ])\s+([A-ZÆØÅ]{2,})\b/g, "$1$2$3")
      .replace(/\b(\p{Lu}[\p{Ll}]{6,})\s+(ing|ering|nning|erhet|dtering)\b/gu, "$1$2");

    if (next === text) {
      break;
    }

    text = next;
  }

  return text.replace(/\s+/g, " ").trim();
}

export function normalizeTableId(value: string) {
  const match = value.match(/(?:tabell\s*)?ID\s*\d{1,3}\s*[-.]\s*\d{1,3}[A-Z]?/i);
  return match ? normalizePdfReferenceTypography(documentRequirementId(match[0])) : "";
}

export function isPdfFooterOrChromeHeadingLine(value: string) {
  const text = value.replace(/\s+/g, " ").trim();
  return (
    /^Konfidensiell$/i.test(text) ||
    /^,?\d+\s*TIL\s*SSA-D\s*\d{4}$/i.test(text) ||
    /^RA\s*-\s*\d+\s*B\s*I\s*L\s*A\s*G/i.test(text) ||
    /^Side\s*\d+\s*av\s*\d+$/i.test(text)
  );
}
