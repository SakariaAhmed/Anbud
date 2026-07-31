export type DocumentAnalysisVersion = "off" | "v3";

const ENABLED_VALUES = new Set(["on", "true", "1"]);

export function documentAnalysisVersion(): DocumentAnalysisVersion {
  const configured = process.env.DOCUMENT_ANALYSIS_VERSION?.trim().toLowerCase();
  if (configured === "v3" || configured === "3" || ENABLED_VALUES.has(configured ?? "")) {
    return "v3";
  }
  if (configured) return "off";

  const legacy = process.env.DOCUMENT_INTELLIGENCE_V2?.trim().toLowerCase();
  return ENABLED_VALUES.has(legacy ?? "") ? "v3" : "off";
}

export function isDocumentAnalysisEnabled() {
  return documentAnalysisVersion() !== "off";
}

export function isDocumentAnalysisV3Enabled() {
  return documentAnalysisVersion() === "v3";
}

export function customerAnalysisPipeline(): "legacy" | "v3" {
  return isDocumentAnalysisV3Enabled() ? "v3" : "legacy";
}

/** @deprecated Use isDocumentAnalysisEnabled. */
export function isDocumentIntelligenceV2Enabled() {
  return isDocumentAnalysisEnabled();
}
