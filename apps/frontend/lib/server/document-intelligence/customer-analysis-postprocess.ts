import { normalizeTechnologySignalWords } from "@/lib/signal-words";
import {
  MAX_CUSTOMER_ANALYSIS_CLARIFICATIONS,
  type CustomerAnalysisResult,
  type ProjectDocumentStructureEntry,
  type ProjectServiceDescription,
  type RecommendedService,
} from "@/lib/types";
import { MAX_CUSTOMER_ANALYSIS_PRIORITIZED_REQUIREMENTS } from "./customer-analysis-fields";
import { normalizeCustomerAnalysisNorwegianProse } from "./customer-analysis-language";
import {
  capNormalizedList,
  dedupeSummary,
  escapeRegExp,
  isNearDuplicate,
  normalizeComparableText,
  splitIntoSentences,
  tokenizeComparableText,
} from "./text-normalization";
import {
  normalizePercentShare,
  normalizeValueOpportunities,
} from "./value-normalization";

const MAX_DYNAMIC_KEYWORD_REGEX_CHARS = 160;
const SOURCE_EXCERPT_MAX_CHARS = 500;
const SOURCE_MATCH_STOP_WORDS = new Set([
  "alle",
  "eller",
  "etter",
  "for",
  "fra",
  "har",
  "ikke",
  "kan",
  "kunden",
  "med",
  "skal",
  "som",
  "til",
  "ved",
]);

export type CustomerAnalysisSourceDocument = {
  title: string;
  rawText: string;
  structureMap?: ProjectDocumentStructureEntry[];
};

type SourceExcerptCandidate = {
  documentTitle: string;
  reference: string;
  text: string;
  normalizedText: string;
  structured: boolean;
};

function normalizeSourceExcerpt(value: string) {
  return value.normalize("NFC").replace(/\s+/gu, " ").trim();
}

function stripFixtureDisclaimerText(value: string) {
  const cleanedSentences = splitIntoSentences(
    value.normalize("NFC").replace(/\s+/gu, " ").trim(),
  )
    .filter(
      (sentence) =>
        !/\balle\s+virksomheter,\s*leverandører,\s*tall\s+og\s+avtaler\b[^.]*\bfiktiv/iu.test(
          sentence,
        ) &&
        !/\bdokumentet\s+er\s+konstruert\s+for\s+(?:funksjons|test|kvalitets)/iu.test(
          sentence,
        ),
    )
    .map((sentence) =>
      sentence
        .replace(
          /\s+er\s+et\s+fiktivt\s+testgrunnlag\s+som\s+/giu,
          " ",
        )
        .replace(/\s+er\s+et\s+fiktivt\s+testgrunnlag\b/giu, ""),
    )
    .map((sentence) => sentence.replace(/\s+/gu, " ").trim())
    .filter(Boolean);

  return cleanedSentences.join(" ");
}

function boundedExactSourceExcerpt(value: string) {
  const normalized = normalizeSourceExcerpt(value);
  if (normalized.length <= SOURCE_EXCERPT_MAX_CHARS) {
    return normalized;
  }
  const candidate = normalized.slice(0, SOURCE_EXCERPT_MAX_CHARS + 1);
  const wordBoundary = candidate.lastIndexOf(" ");
  return candidate
    .slice(
      0,
      wordBoundary >= SOURCE_EXCERPT_MAX_CHARS * 0.75
        ? wordBoundary
        : SOURCE_EXCERPT_MAX_CHARS,
    )
    .trimEnd();
}

function sourceExcerptCandidates(
  documents: CustomerAnalysisSourceDocument[],
) {
  const candidates: SourceExcerptCandidate[] = [];
  const seen = new Set<string>();
  const add = (
    documentTitle: string,
    reference: string,
    value: string,
    structured: boolean,
  ) => {
    const normalizedValue = normalizeSourceExcerpt(value);
    const fragments = splitIntoSentences(normalizedValue);
    for (const fragment of fragments.length ? fragments : [normalizedValue]) {
      const text = boundedExactSourceExcerpt(fragment);
      const normalizedText = normalizeComparableText(text);
      const provenanceKey = [
        normalizeComparableText(documentTitle),
        normalizeComparableText(reference),
        normalizedText,
      ].join("\u0000");
      if (
        text.length < 12 ||
        normalizedText.length < 12 ||
        seen.has(provenanceKey)
      ) {
        continue;
      }
      seen.add(provenanceKey);
      candidates.push({
        documentTitle,
        reference,
        text,
        normalizedText,
        structured,
      });
    }
  };

  for (const document of documents) {
    for (const entry of document.structureMap ?? []) {
      add(
        document.title,
        entry.reference || document.title,
        entry.text,
        true,
      );
    }
    const rawLines = document.rawText
      .split(/\r?\n/gu)
      .map((line) => line.trim())
      .filter(Boolean);
    for (const line of rawLines) {
      add(document.title, document.title, line, false);
    }
    for (let index = 0; index < rawLines.length - 1; index += 1) {
      add(
        document.title,
        document.title,
        rawLines.slice(index, index + 2).join(" "),
        false,
      );
      if (index < rawLines.length - 2) {
        add(
          document.title,
          document.title,
          rawLines.slice(index, index + 3).join(" "),
          false,
        );
      }
    }
  }

  return candidates;
}

function sourceMatchTokens(value: string) {
  return tokenizeComparableText(value)
    .filter((token) => !SOURCE_MATCH_STOP_WORDS.has(token))
    .slice(0, 40);
}

function bestSourceExcerptCandidate(input: {
  requirement: CustomerAnalysisResult["implicit_requirements"][number];
  candidates: SourceExcerptCandidate[];
}) {
  const excerptTokens = sourceMatchTokens(input.requirement.source_excerpt);
  const requirementTokens = sourceMatchTokens(
    `${input.requirement.title} ${input.requirement.description}`,
  );
  const normalizedReference = normalizeComparableText(
    input.requirement.source_reference,
  );

  const scored = input.candidates
    .map((candidate, index) => {
      const excerptHits = excerptTokens.filter((token) =>
        candidate.normalizedText.includes(token),
      ).length;
      const requirementHits = requirementTokens.filter((token) =>
        candidate.normalizedText.includes(token),
      ).length;
      const referenceAffinity =
        normalizedReference &&
        (normalizedReference.includes(
          normalizeComparableText(candidate.documentTitle),
        ) ||
          normalizeComparableText(candidate.documentTitle).includes(
            normalizedReference,
          ))
          ? 4
          : normalizedReference &&
              (normalizedReference.includes(
                normalizeComparableText(candidate.reference),
              ) ||
                normalizeComparableText(candidate.reference).includes(
                  normalizedReference,
                ))
            ? 2
            : 0;
      return {
        candidate,
        index,
        excerptHits,
        requirementHits,
        score: excerptHits * 3 + requirementHits + referenceAffinity,
      };
    })
    .filter(
      (item) =>
        item.excerptHits >= Math.min(3, Math.max(1, excerptTokens.length)) ||
        item.requirementHits >=
          Math.min(4, Math.max(2, requirementTokens.length)),
    )
    .sort(
      (left, right) =>
        right.score - left.score ||
        right.excerptHits - left.excerptHits ||
        left.candidate.text.length - right.candidate.text.length ||
        left.index - right.index,
    );

  const best = scored[0];
  if (!best) {
    return null;
  }
  const ambiguousAcrossDocuments = scored
    .slice(1)
    .some(
      (item) =>
        item.score === best.score &&
        item.candidate.documentTitle !== best.candidate.documentTitle,
    );
  return ambiguousAcrossDocuments ? null : best.candidate;
}

function documentContainsExactExcerpt(
  document: CustomerAnalysisSourceDocument,
  normalizedExcerpt: string,
) {
  if (
    normalizeComparableText(document.rawText).includes(normalizedExcerpt)
  ) {
    return true;
  }
  return (document.structureMap ?? []).some((entry) =>
    normalizeComparableText(entry.text).includes(normalizedExcerpt),
  );
}

function sourceReferenceMatches(value: string, candidate: string) {
  const normalizedValue = normalizeComparableText(value);
  const normalizedCandidate = normalizeComparableText(candidate);
  return (
    Boolean(normalizedValue && normalizedCandidate) &&
    (normalizedValue.includes(normalizedCandidate) ||
      normalizedCandidate.includes(normalizedValue))
  );
}

function exactSourceExcerptCandidate(input: {
  excerpt: string;
  sourceReference: string;
  documents: CustomerAnalysisSourceDocument[];
  candidates: SourceExcerptCandidate[];
}) {
  const normalizedExcerpt = normalizeComparableText(input.excerpt);
  const matchingDocuments = input.documents.filter((document) =>
    documentContainsExactExcerpt(document, normalizedExcerpt),
  );
  if (!matchingDocuments.length) {
    return null;
  }

  const referencedDocuments = matchingDocuments.filter((document) =>
    sourceReferenceMatches(input.sourceReference, document.title),
  );
  const selectedDocuments =
    referencedDocuments.length === 1
      ? referencedDocuments
      : matchingDocuments.length === 1
        ? matchingDocuments
        : [];
  if (selectedDocuments.length !== 1) {
    return null;
  }

  const selectedDocument = selectedDocuments[0];
  const exactCandidates = input.candidates.filter(
    (candidate) =>
      candidate.documentTitle === selectedDocument.title &&
      candidate.normalizedText.includes(normalizedExcerpt),
  );
  const referencedCandidates = exactCandidates.filter(
    (candidate) =>
      sourceReferenceMatches(input.sourceReference, candidate.reference) ||
      sourceReferenceMatches(input.sourceReference, candidate.documentTitle),
  );
  const completionCandidates = exactCandidates
    .filter(
      (candidate) =>
        candidate.normalizedText !== normalizedExcerpt &&
        candidate.normalizedText.includes(normalizedExcerpt),
    )
    .sort(
      (left, right) =>
        Number(right.structured) - Number(left.structured) ||
        left.text.length - right.text.length,
    );
  const selectedCandidate =
    referencedCandidates.find(
      (candidate) => candidate.normalizedText !== normalizedExcerpt,
    ) ??
    completionCandidates[0] ??
    referencedCandidates[0] ?? (() => {
    const structuredReferences = new Set(
      exactCandidates
        .filter((candidate) => candidate.structured)
        .map((candidate) => candidate.reference),
    );
    return structuredReferences.size === 1
      ? exactCandidates.find((candidate) => candidate.structured)
      : undefined;
  })() ??
    exactCandidates[0];

  return {
    documentTitle: selectedDocument.title,
    reference: selectedCandidate?.reference ?? selectedDocument.title,
    text: selectedCandidate?.text ?? input.excerpt,
    normalizedText: selectedCandidate?.normalizedText ?? normalizedExcerpt,
    structured: selectedCandidate?.structured ?? false,
  } satisfies SourceExcerptCandidate;
}

export function groundImplicitRequirementExcerpts(input: {
  requirements: CustomerAnalysisResult["implicit_requirements"];
  sourceDocuments: CustomerAnalysisSourceDocument[];
}) {
  const candidates = sourceExcerptCandidates(input.sourceDocuments);

  return input.requirements.flatMap((requirement) => {
    const excerpt = normalizeSourceExcerpt(requirement.source_excerpt);
    if (excerpt.length >= 12) {
      const exactCandidate = exactSourceExcerptCandidate({
        excerpt,
        sourceReference: requirement.source_reference,
        documents: input.sourceDocuments,
        candidates,
      });
      if (exactCandidate) {
        return [{
          ...requirement,
          source_reference: exactCandidate.reference,
          source_excerpt: exactCandidate.text,
        }];
      }
    }

    const candidate = bestSourceExcerptCandidate({
      requirement,
      candidates,
    });
    if (!candidate) {
      return [];
    }

    return [
      {
        ...requirement,
        source_reference: candidate.reference,
        source_excerpt: candidate.text,
      },
    ];
  });
}

export function selectServiceRecommendationCandidates(
  services: ProjectServiceDescription[] | undefined,
) {
  return [...(services ?? [])]
    .filter(
      (service) =>
        service.name.trim() && !isTransientEvaluationServiceCandidate(service),
    )
    .map((service, index) => ({
      service,
      index,
      hasDocumentContext:
        service.description.trim().length > 0 ||
        service.documents.some((document) => document.ai_summary?.trim()),
    }))
    .sort(
      (left, right) =>
        Number(right.service.selected) - Number(left.service.selected) ||
        Number(right.service.recommended) - Number(left.service.recommended) ||
        right.service.recommendation_score - left.service.recommendation_score ||
        Number(right.hasDocumentContext) - Number(left.hasDocumentContext) ||
        left.index - right.index,
    )
    .slice(0, 12)
    .map(({ service }) => service);
}

function isTransientEvaluationServiceCandidate(
  service: ProjectServiceDescription,
) {
  return (
    /^LLM eval service\b/i.test(service.name.trim()) ||
    /Temporary service description for LLM-as-judge evaluation/i.test(
      service.description,
    )
  );
}

function normalizeSignalWords(items: string[]) {
  return normalizeTechnologySignalWords(items);
}

function countSignalWordMentions(keyword: string, normalizedSource: string) {
  const trimmedKeyword = keyword.replace(/\s+/g, " ").trim();

  if (!trimmedKeyword || !normalizedSource) {
    return 1;
  }

  if (trimmedKeyword.length > MAX_DYNAMIC_KEYWORD_REGEX_CHARS) {
    return countPlainTextMentions(trimmedKeyword, normalizedSource);
  }

  const flexibleKeyword = escapeRegExp(trimmedKeyword)
    .replace(/\\ /g, "\\s+")
    .replace(/\\-/g, "[-\\s]?");

  try {
    const matcher = new RegExp(
      `(^|[^\\p{L}\\p{N}])(${flexibleKeyword})(?=$|[^\\p{L}\\p{N}])`,
      "giu",
    );
    return Math.max(1, Array.from(normalizedSource.matchAll(matcher)).length);
  } catch {
    return countPlainTextMentions(trimmedKeyword, normalizedSource);
  }
}

function countPlainTextMentions(keyword: string, sourceText: string) {
  const lowerSource = sourceText.toLowerCase();
  const lowerKeyword = keyword.toLowerCase();
  let count = 0;
  let cursor = 0;

  while (cursor < lowerSource.length) {
    const nextIndex = lowerSource.indexOf(lowerKeyword, cursor);
    if (nextIndex === -1) {
      break;
    }
    count += 1;
    cursor = nextIndex + lowerKeyword.length;
  }

  return Math.max(1, count);
}

function normalizeSignalWordCounts(
  signalWords: string[],
  input?: {
    sourceText?: string;
    existingCounts?: Record<string, unknown>;
  },
) {
  const normalizedSource = (input?.sourceText ?? "")
    .replace(/\s+/g, " ")
    .trim();

  return signalWords.reduce<Record<string, number>>((counts, keyword) => {
    const existingCount = input?.existingCounts?.[keyword];
    counts[keyword] =
      typeof existingCount === "number" && Number.isFinite(existingCount)
        ? Math.max(1, Math.round(existingCount))
        : countSignalWordMentions(keyword, normalizedSource);
    return counts;
  }, {});
}

export function normalizeMermaidDiagram(value: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }

  const candidate = trimmed
    .replace(/^```mermaid\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  if (!/^(flowchart|graph)\s+(TB|TD|BT|RL|LR)\b/i.test(candidate)) {
    return "";
  }

  return candidate;
}

function countMermaidComplexity(diagram: string) {
  const lines = diagram
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const edgeCount = lines.filter((line) => /-->|---|-.->/.test(line)).length;
  const subgraphCount = lines.filter((line) =>
    /^subgraph\b/i.test(line),
  ).length;
  const nodeIds = new Set<string>();
  for (const line of lines) {
    const matches = line.matchAll(/\b([A-Za-z][A-Za-z0-9_]*)\s*[\[\(\{]/g);
    for (const match of matches) {
      nodeIds.add(match[1] || "");
    }
  }
  return {
    lineCount: lines.length,
    edgeCount,
    subgraphCount,
    nodeCount: nodeIds.size,
  };
}

function includesSignal(signals: string[], pattern: RegExp) {
  return signals.some((signal) => pattern.test(signal));
}

function buildSimpleArchitectureDiagram(result: CustomerAnalysisResult) {
  const signals = Array.isArray(result.signal_words) ? result.signal_words : [];

  const hasMicrosoftIdentity = includesSignal(
    signals,
    /\bentra\b|active directory|microsoft 365/i,
  );
  const hasAzure = includesSignal(signals, /\bazure\b/i);
  const hasNamedIntegration = includesSignal(
    signals,
    /\bid-?porten\b|noark|api/i,
  );
  const hasNamedData = includesSignal(signals, /\bpower bi\b|data|database/i);
  const hasNamedOps = includesSignal(
    signals,
    /\bci\/?cd\b|monitor|logging|backup/i,
  );

  return [
    "flowchart LR",
    '  subgraph Business["Brukere og forretning"]',
    "    Users[Forretningsbrukere og fagmiljø]",
    "    Apps[Applikasjoner og arbeidsflater]",
    "  end",
    '  subgraph Identity["Identitet"]',
    hasMicrosoftIdentity
      ? "    Identity[Microsoft Entra ID]"
      : "    Identity[Identitet og tilgang]",
    "  end",
    '  subgraph PlatformLayer["Plattform"]',
    hasAzure ? "    Platform[Azure-plattform]" : "    Platform[Plattform]",
    "  end",
    '  subgraph IntegrationLayer["Integrasjon og data"]',
    hasNamedIntegration
      ? "    Integration[API og integrasjoner]"
      : "    Integration[Integrasjonslag]",
    hasNamedData ? "    Data[Data og lagring]" : "    Data[Data og tjenester]",
    "  end",
    '  subgraph Operations["Sikkerhet og drift"]',
    hasNamedOps
      ? "    Ops[Overvåking, logging og backup]"
      : "    Ops[Drift og sikkerhet]",
    "  end",
    "",
    "  Users --> Apps",
    "  Apps --> Platform",
    "  Apps --> Integration",
    "  Identity --> Platform",
    "  Platform --> Integration",
    "  Integration --> Data",
    "  Platform --> Ops",
    "  Data --> Ops",
  ].join("\n");
}

function preferSimpleArchitectureDiagram(
  rawDiagram: string,
  result: CustomerAnalysisResult,
) {
  const normalized = normalizeMermaidDiagram(rawDiagram);
  if (!normalized) {
    return buildSimpleArchitectureDiagram(result);
  }

  const complexity = countMermaidComplexity(normalized);
  if (
    complexity.nodeCount > 10 ||
    complexity.edgeCount > 12 ||
    complexity.subgraphCount > 5 ||
    complexity.lineCount > 28
  ) {
    return buildSimpleArchitectureDiagram(result);
  }

  return normalized;
}

function normalizeRequirementList(
  requirements: CustomerAnalysisResult["implicit_requirements"],
) {
  const result: CustomerAnalysisResult["implicit_requirements"] = [];

  for (const requirement of requirements) {
    const title = requirement.title.replace(/\s+/g, " ").trim();
    const description = requirement.description.replace(/\s+/g, " ").trim();

    if (!title || !description) {
      continue;
    }

    if (
      result.some(
        (existing) =>
          isNearDuplicate(existing.title, title, 0.8) &&
          isNearDuplicate(existing.description, description, 0.72),
      )
    ) {
      continue;
    }

    result.push({
      ...requirement,
      title,
      description,
      source_reference: requirement.source_reference
        .replace(/\s+/g, " ")
        .trim(),
      source_excerpt: requirement.source_excerpt.replace(/\s+/g, " ").trim(),
    });
  }

  return result;
}

function serviceLookupKey(value: string) {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function normalizeTextField(value: unknown) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function normalizeRecommendedServices(
  items: RecommendedService[],
  serviceCandidates?: ProjectServiceDescription[],
): RecommendedService[] {
  const hasCandidateInput = Array.isArray(serviceCandidates);
  const candidateList = serviceCandidates?.length
    ? selectServiceRecommendationCandidates(serviceCandidates)
    : [];
  if (hasCandidateInput && !candidateList.length) {
    return [];
  }
  const candidatesById = new Map(
    candidateList.map((service) => [service.id, service]),
  );
  const candidatesByName = new Map(
    candidateList.map((service) => [serviceLookupKey(service.name), service]),
  );
  const constrainToCandidates = hasCandidateInput && candidateList.length > 0;
  const seen = new Set<string>();

  return (Array.isArray(items) ? items : [])
    .filter(
      (item) =>
        item &&
        typeof item.service_name === "string" &&
        typeof item.recommendation_reason === "string",
    )
    .flatMap((item): RecommendedService[] => {
      const serviceId =
        typeof item.service_id === "string" ? item.service_id.trim() : "";
      const serviceName = item.service_name.replace(/\s+/g, " ").trim();
      const candidate =
        (serviceId ? candidatesById.get(serviceId) : undefined) ??
        candidatesByName.get(serviceLookupKey(serviceName));

      if (constrainToCandidates && !candidate) {
        return [];
      }

      return [
        {
          service_id: candidate?.id ?? (serviceId || null),
          service_name: candidate?.name ?? serviceName,
          usefulness_percent:
            normalizePercentShare(item.usefulness_percent) ?? 1,
          customer_need: normalizeTextField(item.customer_need),
          recommendation_reason: normalizeTextField(item.recommendation_reason),
          evidence: normalizeTextField(item.evidence),
          risk_or_caveat: normalizeTextField(item.risk_or_caveat),
        },
      ];
    })
    .filter((item) => {
      const key = item.service_id ?? serviceLookupKey(item.service_name);
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    })
    .filter((item) => item.usefulness_percent >= 40)
    .sort(
      (left, right) =>
        right.usefulness_percent - left.usefulness_percent ||
        left.service_name.localeCompare(right.service_name, "nb"),
    )
    .slice(0, 5);
}

function inferRiskAudience(item: string): "us" | "customer" {
  const text = item.toLowerCase();

  if (
    /tilbud|leverandør|leveranse|team|ressurs|kompetanse|kapasitet|scope|omfang|pris|margin|kontrakt|avklaring|posisjonering|forplikt|ansvar/.test(
      text,
    )
  ) {
    return "us";
  }

  return "customer";
}

function normalizeRiskGroups(result: CustomerAnalysisResult) {
  const explicitForUs = capNormalizedList(
    Array.isArray(result.risks_for_us) ? result.risks_for_us : [],
  );
  const explicitForCustomer = capNormalizedList(
    Array.isArray(result.risks_for_customer) ? result.risks_for_customer : [],
  );
  const legacyRisks = capNormalizedList(
    Array.isArray(result.risks) ? result.risks : [],
  );

  if (explicitForUs.length || explicitForCustomer.length) {
    const risks = capNormalizedList([...explicitForCustomer, ...explicitForUs]);
    return {
      risks,
      risksForUs: explicitForUs,
      risksForCustomer: explicitForCustomer,
    };
  }

  const risksForUs: string[] = [];
  const risksForCustomer: string[] = [];

  for (const risk of legacyRisks) {
    if (inferRiskAudience(risk) === "us") {
      risksForUs.push(risk);
    } else {
      risksForCustomer.push(risk);
    }
  }

  return {
    risks: legacyRisks,
    risksForUs: capNormalizedList(risksForUs),
    risksForCustomer: capNormalizedList(risksForCustomer),
  };
}

export function normalizeCustomerAnalysisResult(
  result: CustomerAnalysisResult,
  options?: {
    signalSourceText?: string;
    serviceCandidates?: ProjectServiceDescription[];
    sourceDocuments?: CustomerAnalysisSourceDocument[];
  },
): CustomerAnalysisResult {
  const cleanProseList = (items: unknown[]) =>
    capNormalizedList(
      items
        .filter((item): item is string => typeof item === "string")
        .map(stripFixtureDisclaimerText)
        .filter(Boolean),
    );
  const customerProfile = cleanProseList(
    Array.isArray(result.customer_profile) ? result.customer_profile : [],
  );
  const customerGoals = cleanProseList(
    Array.isArray(result.customer_goals) ? result.customer_goals : [],
  );
  const { risks, risksForUs, risksForCustomer } = normalizeRiskGroups(result);
  const likelyEvaluationCriteria = cleanProseList(
    Array.isArray(result.likely_evaluation_criteria)
      ? result.likely_evaluation_criteria
      : [],
  );
  const signalWords = normalizeSignalWords(
    Array.isArray(result.signal_words) ? result.signal_words : [],
  );
  const signalWordCounts = normalizeSignalWordCounts(signalWords, {
    sourceText: options?.signalSourceText,
    existingCounts: result.signal_word_counts,
  });
  const expectedSolutionDirection = cleanProseList(
    Array.isArray(result.expected_solution_direction)
      ? result.expected_solution_direction
      : [],
  );
  const positioningRecommendations = cleanProseList(
    Array.isArray(result.positioning_recommendations)
      ? result.positioning_recommendations
      : [],
  );
  const ambiguities = capNormalizedList(
    (Array.isArray(result.ambiguities) ? result.ambiguities : [])
      .map(stripFixtureDisclaimerText)
      .filter(Boolean),
    { max: MAX_CUSTOMER_ANALYSIS_CLARIFICATIONS },
  );
  const prioritizedRequirements = (
    Array.isArray(result.prioritized_requirements)
      ? result.prioritized_requirements
      : []
  )
    .filter((item) => item && item.requirement && item.priority && item.reason)
    .filter((item, index, array) => {
      return !array.some(
        (existing, existingIndex) =>
          existingIndex < index &&
          isNearDuplicate(existing.requirement, item.requirement, 0.8) &&
          isNearDuplicate(existing.reason, item.reason, 0.72),
      );
    })
    .slice(0, MAX_CUSTOMER_ANALYSIS_PRIORITIZED_REQUIREMENTS);
  const valueOpportunities = normalizeValueOpportunities(
    Array.isArray(result.value_opportunities) ? result.value_opportunities : [],
  );
  const recommendedServices = normalizeRecommendedServices(
    Array.isArray(result.recommended_services)
      ? result.recommended_services
      : [],
    options?.serviceCandidates,
  );
  const implicitRequirements = normalizeRequirementList(
    Array.isArray(result.implicit_requirements)
      ? result.implicit_requirements
      : [],
  );
  const groundedImplicitRequirements = options?.sourceDocuments
    ? groundImplicitRequirementExcerpts({
        requirements: implicitRequirements,
        sourceDocuments: options.sourceDocuments,
      })
    : implicitRequirements;

  const customerProfileSummary = dedupeSummary(
    stripFixtureDisclaimerText(result.customer_profile_summary) ||
      customerProfile.slice(0, 2).join(" "),
    [
      ...customerGoals,
      result.customer_goals_summary || "",
      ...positioningRecommendations,
    ],
  );

  const customerGoalsSummary = dedupeSummary(
    stripFixtureDisclaimerText(result.customer_goals_summary) ||
      customerGoals.slice(0, 2).join(" "),
    [customerProfileSummary, ...customerProfile, ...positioningRecommendations],
  );

  const highLevelSolutionDesign = dedupeSummary(
    stripFixtureDisclaimerText(result.high_level_solution_design) ||
      expectedSolutionDirection.slice(0, 2).join(" "),
    [
      customerProfileSummary,
      customerGoalsSummary,
      ...customerProfile,
      ...customerGoals,
      ...positioningRecommendations,
      ...expectedSolutionDirection,
    ],
  );
  const highLevelArchitectureMermaid = preferSimpleArchitectureDiagram(
    result.high_level_architecture_mermaid || "",
    result,
  );

  const executiveSummary = dedupeSummary(
    stripFixtureDisclaimerText(result.executive_summary),
    [
    customerProfileSummary,
    customerGoalsSummary,
    highLevelSolutionDesign,
    ...customerProfile,
    ...customerGoals,
    ...risks,
    ...positioningRecommendations,
    ],
  );

  const normalizedResult = normalizeCustomerAnalysisNorwegianProse({
    ...result,
    customer_profile_summary: customerProfileSummary,
    customer_goals_summary: customerGoalsSummary,
    high_level_solution_design: highLevelSolutionDesign,
    high_level_architecture_mermaid: highLevelArchitectureMermaid,
    customer_profile: customerProfile,
    customer_goals: customerGoals,
    implicit_requirements: groundedImplicitRequirements,
    prioritized_requirements: prioritizedRequirements,
    ambiguities,
    risks,
    risks_for_us: risksForUs,
    risks_for_customer: risksForCustomer,
    likely_evaluation_criteria: likelyEvaluationCriteria,
    signal_words: signalWords,
    signal_word_counts: signalWordCounts,
    expected_solution_direction: expectedSolutionDirection,
    recommended_services: recommendedServices,
    value_opportunities: valueOpportunities,
    positioning_recommendations: positioningRecommendations,
    executive_summary: executiveSummary,
  });
  if (!options?.sourceDocuments) {
    return normalizedResult;
  }
  return {
    ...normalizedResult,
    implicit_requirements: groundImplicitRequirementExcerpts({
      requirements: normalizedResult.implicit_requirements,
      sourceDocuments: options.sourceDocuments,
    }),
  };
}
