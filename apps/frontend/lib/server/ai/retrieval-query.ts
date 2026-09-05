export function extractExactRetrievalTerms(value: string) {
  return Array.from(
    new Set(
      [
        ...value.matchAll(/\b[A-ZÆØÅ]{1,8}-?\d{1,5}(?:\.\d+)*\b/g),
        ...value.matchAll(
          /\b(?:SSA-[A-Z]|SLA|RTO|RPO|GDPR|DPIA|ISO\s*27001|NSM|WCAG)\b/gi,
        ),
      ]
        .map((match) => match[0].replace(/\s+/g, " ").trim())
        .filter(Boolean),
    ),
  ).slice(0, 12);
}
