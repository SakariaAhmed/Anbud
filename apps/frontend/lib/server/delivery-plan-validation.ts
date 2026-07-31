const GO_LIVE_TERM_PATTERN =
  /\b(?:go[- ]?live|produksjonssetting|produksjonsstart|produksjonsdato|produksjonsutrulling|idriftsett(?:else|ing)|driftsstart|ordinær\s+drift|settes?\s+i\s+produksjon|utrulling(?:en)?\s+(?:til|i)\s+produksjon)\b/iu;
const EXPLICIT_DATE_PATTERN =
  /\b(?:20\d{2}-\d{2}-\d{2}|\d{1,2}[./-]\d{1,2}[./-](?:20)?\d{2}|\d{1,2}\.?\s+(?:januar|februar|mars|april|mai|juni|juli|august|september|oktober|november|desember)\s+20\d{2})\b/iu;

const DELIVERY_MILESTONES = [
  {
    key: "go_live",
    label: "produksjonsutrulling eller go-live",
    pattern:
      /\b(?:go[- ]?live|produksjonssetting|produksjonsstart|produksjonsutrulling|idriftsett(?:else|ing)|settes?\s+i\s+produksjon|utrulling(?:en)?\s+(?:til|i)\s+produksjon)\b/iu,
  },
  {
    key: "handover",
    label: "overlevering til drift eller forvaltning",
    pattern:
      /\b(?:overlever(?:ing|es|e)?|handover|kunnskapsoverfør(?:ing|es)?|driftsovertak(?:else|ing)|overføring\s+til\s+(?:drift|forvaltning))\b/iu,
  },
  {
    key: "hypercare_or_closure",
    label: "hypercare, stabilisering eller avslutning",
    pattern:
      /\b(?:hypercare|ettervern|stabiliserings(?:fase|periode)?|stabilisering|forsterket\s+(?:støtte|support)|avslutningsfase|prosjektavslutning|formell\s+avslutning|sluttakseptanse|sluttgodkjenning|lukking)\b/iu,
  },
] as const;

export function sourceContainsDatedGoLive(value: string) {
  const text = value.normalize("NFC").replace(/\s+/gu, " ").trim();
  const termPattern = new RegExp(GO_LIVE_TERM_PATTERN.source, "giu");
  return [...text.matchAll(termPattern)].some((match) => {
    const index = match.index ?? 0;
    const nearbyText = text.slice(
      Math.max(0, index - 80),
      Math.min(text.length, index + match[0].length + 160),
    );
    return EXPLICIT_DATE_PATTERN.test(nearbyText);
  });
}

export function deliveryPlanMilestoneCoverage(input: {
  sourceText?: string;
  contentMarkdown: string;
}) {
  const required = sourceContainsDatedGoLive(input.sourceText ?? "");
  const missing = required
    ? DELIVERY_MILESTONES.filter(
        (milestone) => !milestone.pattern.test(input.contentMarkdown),
      ).map(({ key, label }) => ({ key, label }))
    : [];

  return {
    required,
    complete: missing.length === 0,
    missing,
  };
}
