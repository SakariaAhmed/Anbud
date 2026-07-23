export function isDocumentIntelligenceV2Enabled() {
  const value = process.env.DOCUMENT_INTELLIGENCE_V2?.trim().toLowerCase();
  return value === "on" || value === "true" || value === "1";
}
