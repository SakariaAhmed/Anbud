import {
  isPdfFooterOrChromeHeadingLine,
  normalizePageText,
} from "@/lib/server/requirements/pdf-normalization";

export function stripRequirementChrome(text: string) {
  return normalizePageText(text)
    .replace(/^\s*Leverandørens\s+besvarelse\b\s*[:|–-]?\s*/i, "")
    .replace(/\s{2,}Leverandørens\s+besvarelse\b/gi, " ")
    .replace(/\bRA\s*-\s*\d+\s*B\s*I\s*L\s*A\s*G\s*[\d,.\s]+\s*TIL\s*SSA\s*-\s*D\s*\d{4}\b/gi, " ")
    .replace(/^[\u2022\uF0B7*–—-]\s*/u, "")
    .replace(/^\s*\[(?:x|\?)\]\s*/iu, "")
    .replace(
      /^\s*(?:\[(?:(?:KR|K|R|TEK)\s*[- ]?\s*\d{1,5}|P\d{3}\s*[- ]\s*\d{1,5}|\d{2,4}\s*\/\s*\d{1,3}|[A-ZÆØÅ]\d?\s*-\s*\d{1,3}|[A-ZÆØÅ]{2,8}\s*\.\s*\d{1,3}(?:\s*\.\s*\d{1,3}){1,5}|[A-ZÆØÅ]{2,8}\s*-\s*[A-ZÆØÅ]{1,4}\s*[- ]?\d{1,5}|[A-ZÆØÅ]{2,8}\s*[- ]\s*REQ\s*[- ]\s*\d{1,5}|REQ\s*[- ]?\s*\d{1,5}|ID\s*\d{1,5}(?:\s*[.-]\s*\d{1,5})*)[A-Z]?\]\s*|(?:(?:KR|K|R|TEK)\s*[- ]?\s*\d{1,5}(?:\s*[.-]\s*\d{1,5})?[A-Z]?|P\d{3}\s*[- ]\s*\d{1,5}[A-Z]?|\d{2,4}\s*\/\s*\d{1,3}|[A-ZÆØÅ]\d?\s*-\s*\d{1,3}|[A-ZÆØÅ]{2,8}\s*\.\s*\d{1,3}(?:\s*\.\s*\d{1,3}){1,5}[A-Z]?|[A-ZÆØÅ]{2,8}\s*-\s*[A-ZÆØÅ]{1,4}\s*[- ]?\d{1,5}[A-Z]?|[A-ZÆØÅ]{2,8}\s*[- ]\s*REQ\s*[- ]\s*\d{1,5}[A-Z]?|Krav\s*(?:nr\.?|nummer)?\s*\d{1,5}|REQ\s*[- ]?\s*\d{1,5}[A-Z]?|ID\s*\d{1,5}(?:\s*[.-]\s*\d{1,5})*)\s*(?:[:.)]|[-–—])\s*)/iu,
      "",
    )
    .replace(/^\s*(?:uten\s+nr\.?|\[?\?\]?|x)\s*[:.)-]\s*/iu, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function cleanHeadingCandidate(value: string) {
  return stripRequirementChrome(value)
    .replace(/\bLeverandørens\s+besvarelse\s+ID\s*\d{1,3}\s*[-.]\s*\d{1,3}[A-Z]?\b/gi, " ")
    .replace(/\bID\s*\d{1,3}\s*[-.]\s*\d{1,3}[A-Z]?\b/gi, " ")
    .replace(/^[•\-–—:;.,\s]+|[•\-–—:;.,\s]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function isLikelyHeadingLine(line: string) {
  if (/^\s*[•\-–—]/.test(line)) {
    return false;
  }

  if (/^\s*\d{1,2}\)\s+/.test(line)) {
    return false;
  }

  if (isPdfFooterOrChromeHeadingLine(line)) {
    return false;
  }

  const cleaned = cleanHeadingCandidate(line);
  if (!cleaned || cleaned.length < 4 || cleaned.length > 90) {
    return false;
  }

  if (isPdfFooterOrChromeHeadingLine(cleaned)) {
    return false;
  }

  if (/^ID\b/i.test(cleaned) || /^[\d\s.-]+$/.test(cleaned)) {
    return false;
  }

  if (/[.!?]$/.test(cleaned)) {
    return false;
  }

  const wordCount = cleaned.split(/\s+/).length;
  if (wordCount > 9) {
    return false;
  }

  if (/^(og|eller|som|for|til|i|av|på|med)\b/i.test(cleaned)) {
    return false;
  }

  if (
    /(?:^|[^\p{L}\p{N}_])(?:skal|må|kan|bes|forbeholder|innebærer|ansvarlig|tilgjengelig)(?=$|[^\p{L}\p{N}_])/iu.test(
      cleaned,
    ) ||
    /\bvil\s+omfatte\b/i.test(cleaned) ||
    /\bomfatter\b/i.test(cleaned) ||
    /\bhovedområder\b/i.test(cleaned)
  ) {
    return false;
  }

  return (
    /^[A-ZÆØÅ0-9]/.test(cleaned) &&
    (wordCount <= 9 ||
      /^[A-ZÆØÅ][A-ZÆØÅ0-9\s/().,-]{4,}$/.test(cleaned) ||
      /^\d+(?:\.\d+)*\.?\s+\S+/.test(cleaned))
  );
}

export function headingLevel(heading: string) {
  const cleaned = cleanHeadingCandidate(heading);

  if (/^\d+\.\d+/.test(cleaned)) {
    return 2;
  }
  if (/^\d+/.test(cleaned) || /krav\b/i.test(cleaned)) {
    return 1;
  }
  return 2;
}

export function buildHeadingPath(stack: string[]) {
  return stack.filter(Boolean).slice(-3).join(" > ");
}
