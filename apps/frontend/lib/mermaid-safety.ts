const MAX_MERMAID_CHARS = 6000;
const MAX_MERMAID_LINES = 120;
const BLOCKED_MERMAID_LINE =
  /^\s*(%%\{|classDef\b|class\s+\S+\s+\S+|click\b|href\b|linkStyle\b|style\b|accTitle\b|accDescr\b)/i;
const BLOCKED_MERMAID_CONTENT = /<\/?[a-z!]|javascript:|data:|@import|url\s*\(/i;

export function isSafeRenderedMermaidCss(css: string) {
  // Mermaid's own theme references gradients inside the generated SVG.
  // Permit simple fragment IDs, while still rejecting every external URL.
  const withoutLocalReferences = css.replace(
    /url\(\s*(?:(["'])#[\w-]+\1|#[\w-]+)\s*\)/gi,
    "",
  );
  return !/@import|url\s*\(|expression\s*\(|javascript:|data:/i.test(withoutLocalReferences);
}

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

  // Older fallback diagrams gave the identity group and its child the same ID.
  // Repair only that known persisted shape, leaving node/edge identities intact.
  let chart = normalized;
  if (
    /^\s*subgraph Identity\["Identitet"\]\s*$/m.test(chart) &&
    /^\s*Identity\[(Microsoft Entra ID|Identitet og tilgang)\]\s*$/m.test(chart)
  ) {
    let groupId = "IdentityLayer";
    let suffix = 2;
    while (new RegExp(`\\b${groupId}\\b`).test(chart)) {
      groupId = `IdentityLayer${suffix++}`;
    }
    chart = chart.replace(/^(\s*subgraph )Identity(?=\["Identitet"\])/m, `$1${groupId}`);
  }
  return { chart, error: "" };
}
