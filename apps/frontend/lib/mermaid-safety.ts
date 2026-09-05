const MAX_MERMAID_CHARS = 6000;
const MAX_MERMAID_LINES = 120;
const BLOCKED_MERMAID_LINE =
  /^\s*(%%\{|classDef\b|class\s+\S+\s+\S+|click\b|href\b|linkStyle\b|style\b|accTitle\b|accDescr\b)/i;
const BLOCKED_MERMAID_CONTENT = /<\/?[a-z!]|javascript:|data:|@import|url\s*\(/i;

export function sanitizeMermaidChart(input: string) {
  const normalized = input.replace(/\r\n?/g, "\n").trim();
  if (!normalized) {
    return { chart: "", error: "" };
  }

  if (normalized.length > MAX_MERMAID_CHARS) {
    return {
      chart: "",
      error: "Diagrammet er for stort til å rendres trygt.",
    };
  }

  const lines = normalized.split("\n");
  if (lines.length > MAX_MERMAID_LINES) {
    return {
      chart: "",
      error: "Diagrammet har for mange linjer til å rendres trygt.",
    };
  }

  if (!/^(flowchart|graph)\s+/i.test(normalized)) {
    return {
      chart: "",
      error: "Diagrammet må være et flowchart eller graph.",
    };
  }

  if (
    BLOCKED_MERMAID_CONTENT.test(normalized) ||
    lines.some((line) => BLOCKED_MERMAID_LINE.test(line))
  ) {
    return {
      chart: "",
      error: "Diagrammet inneholder styling eller lenker som ikke rendres av sikkerhetshensyn.",
    };
  }

  return { chart: normalized, error: "" };
}

