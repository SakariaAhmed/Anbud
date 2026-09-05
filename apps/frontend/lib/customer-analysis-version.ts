import type { CustomerAnalysisResult } from "@/lib/types";

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, canonical(item)]));
  }
  return value;
}

export function analysisContentEqual(a: CustomerAnalysisResult | null, b: CustomerAnalysisResult) {
  if (!a) return false;
  const content = (value: CustomerAnalysisResult) => {
    const { revision: _revision, section_histories: _history, ...rest } = value;
    return JSON.stringify(canonical(rest));
  };
  return content(a) === content(b);
}

export function withoutAnalysisRevision(analysis: CustomerAnalysisResult): CustomerAnalysisResult {
  const { revision: _revision, ...content } = analysis;
  return content;
}
