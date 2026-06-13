import "server-only";

export function normalizeRequirementId(value: string) {
  const cleaned = value
    .replace(/[‐‑‒–—]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/\s*-\s*/g, "-")
    .replace(/\s*\.\s*/g, ".")
    .trim()
    .replace(/^krav\s*(?:nr\.?|nummer)?\s*/i, "Krav ")
    .replace(/^id\s*/i, "ID ")
    .replace(/^req\s*[- ]?\s*/i, "REQ-");

  if (/^Krav\b/i.test(cleaned)) {
    return cleaned.replace(/^krav\b/i, "Krav");
  }

  if (/^ID\b/i.test(cleaned)) {
    return cleaned.replace(/^id\b/i, "ID");
  }

  if (/^REQ-/i.test(cleaned)) {
    return cleaned.toUpperCase();
  }

  return cleaned.toUpperCase();
}

export function lastHeadingSegment(heading: string) {
  return (
    heading
      .split(">")
      .map((part) => part.replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .at(-1) ?? ""
  );
}
