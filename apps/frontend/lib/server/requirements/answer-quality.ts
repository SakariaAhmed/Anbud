import "server-only";

// Quality rules for generated requirement answers: whether an answer commits
// to the documented targets, scope and controls, and the deterministic
// template repairs used when it does not.
import { compactText } from "@/lib/server/ai/context";
import {
  isNearDuplicate,
  normalizeComparableText,
  splitIntoSentences,
  tokenizeComparableText,
} from "@/lib/server/document-intelligence/text-normalization";
import { normalizeRequirementLedgerText } from "@/lib/server/requirements/pdf-layout-ledger";
import { normalizePageText } from "@/lib/server/requirements/pdf-normalization";
import {
  appendSentence,
  requirementAnswerEvidence,
  requirementSourceExcerptWithoutAnswer,
  tableRequirementAnswer,
} from "@/lib/server/requirements/source-ledger";
import { type RequirementLedgerEntry } from "@/lib/server/requirements/types";

export type RequirementAnswerSource =
  | "batch"
  | "full_document_handoff"
  | "exact_duplicate_reuse"
  | "deterministic_template_repair"
  | "deterministic_control_repair"
  | "deterministic_fallback";

export type RequirementAnswerResult = {
  answer: string;
  evidence: string;
  source: RequirementAnswerSource;
  reason?: string;
  rejectedAnswer?: string;
};

export const DETERMINISTIC_DIMENSIONING_TEMPLATE_REPAIR =
  "I løsningsforslaget dimensjonerer og forplikter Atea ende-til-ende-sporbarhet fra innmelding til avslutning, inkludert revisjonsspor, statushistorikk og korrelert logging, for de navngitte brukertransaksjonene registrere innmelding, oppdatere status og avslutte saken, etter en kapasitetsmodell og ytelsesbaseline som verifiseres med last- og ytelsestest samt provisjonert kapasitet med eksplisitt reservekapasitet. Ateas tilbudte responstidsmål er p95 under 2 sekunder for de samme transaksjonene ved en antatt lastprofil på 200 samtidige brukere; både målet og lastprofilen er Ateas leverandørforutsetning, ikke kundekrav fra kilden, og brukes som bindende akseptansekriterium før produksjonssetting.";

export const DETERMINISTIC_PRODUCTION_DIMENSIONING_TEMPLATE_REPAIR =
  DETERMINISTIC_DIMENSIONING_TEMPLATE_REPAIR.replace(
    "I løsningsforslaget dimensjonerer og forplikter Atea",
    "I løsningsforslaget for produksjonsløsningen dimensjonerer og forplikter Atea",
  );

function hasOperationalAnswerSignal(answer: string) {
  return /\b(?:leverer|etablerer|oppretter|opprettes|konfigurerer|sender|sendes|migrerer|gjennomfører|logger|logges|korrigerer|korrigeres|retester|retestes|godkjenner|godkjennes|dimensjonerer|dimensjoneres|tester|testes|verifiserer|verifiseres|forplikter|måler|måles|kontrollerer|kontroll|overvåker|overvåking|rapporterer|rapportering|dokumenterer|dokumentasjon|akseptansekriter|ansvar|prosess|runbook|rollback|eskalering|eskalerer|eskaleres|avklarer|avklares)\b/i.test(
    answer,
  );
}

function mandatoryRequirementSignalCount(value: string) {
  const normalized = normalizeRequirementLedgerText(value);
  const tokens = normalized.match(/[\p{L}\p{N}]+/gu) ?? [];
  return (
    tokens.filter((token) =>
      ["skal", "må", "shall", "must"].includes(token),
    ).length +
    (/(?:^|\s)required\s+to(?:\s|$)/i.test(normalized) ? 1 : 0)
  );
}

function hasMandatoryRequirementSignal(value: string) {
  return mandatoryRequirementSignalCount(value) > 0;
}

export function isMandatoryRequirementEntry(entry: RequirementLedgerEntry) {
  return hasMandatoryRequirementSignal(requirementSourceTextWithoutAnswer(entry));
}

export function normalizeMandatoryRequirementCommitment(
  answer: string,
  entry: RequirementLedgerEntry,
) {
  const normalized = answer.replace(/\s+/g, " ").trim();
  if (!isMandatoryRequirementEntry(entry)) {
    return normalized;
  }

  return normalized
    .replace(/\bAtea kan levere\b/gi, "Atea leverer")
    .replace(/\bAtea kan tilby\b/gi, "Atea tilbyr")
    .replace(/\bAtea kan stille\b/gi, "Atea stiller")
    .replace(/\bAtea kan etablere\b/gi, "Atea etablerer")
    .replace(/\bAtea kan dokumentere\b/gi, "Atea dokumenterer")
    .replace(/\bAtea kan beskrive\b/gi, "Atea beskriver")
    .replace(/\bAtea vil levere\b/gi, "Atea leverer")
    .replace(/\bAtea vil etablere\b/gi, "Atea etablerer")
    .replace(/\bAtea vil dokumentere\b/gi, "Atea dokumenterer")
    .replace(/\bAtea vil beskrive\b/gi, "Atea beskriver")
    .replace(/\bLøsningen kan måle\b/gi, "Løsningen måler")
    .replace(/\bLøsningen kan støtte\b/gi, "Løsningen støtter")
    .replace(/\bLøsningen vil måle\b/gi, "Løsningen måler")
    .replace(/\bLøsningen vil støtte\b/gi, "Løsningen støtter")
    .replace(
      /\bLøsningsforslaget vil (også )?beskrive\b/gi,
      (_match, qualifier: string | undefined) =>
        `Atea beskriver ${qualifier ?? ""}`.trimEnd(),
    )
    .replace(/\s+/g, " ")
    .trim();
}

function isAllowedParameterClarification(sentence: string) {
  const hasGeneralAllowedUnknown =
    /\b(?:eksakt(?:e)?|konkret(?:e)?\s+(?:tall|verdi(?:er)?|dato(?:er)?|frist(?:er)?)|RTO|RPO|SLA|tjenestenivå(?:er)?|nedetidsmål|budsjett|betalingsvilkår|pris(?:er)?|prismodell|kommersielle?\s+(?:vilkår|frist(?:er)?|avgrensning)|leveransefrist(?:er)?|dato(?:er)?)\b/i.test(
      sentence,
    );
  const hasUntalliedPerformanceParameter =
    /\b(?:ytelsesmål|responstidsmål|kapasitetsmål|volum(?:er)?|lastprofil|samtidighet|samtidige\s+brukere|akseptansekriter(?:ier)?|målnivå(?:er)?)\b/i.test(
      sentence,
    ) &&
    /\b(?:eksakt(?:e)?|tallfestet(?:e)?|måltall|ikke\s+(?:tallfestet|angitt|dokumentert|oppgitt))\b/i.test(
      sentence,
    );
  if (!hasGeneralAllowedUnknown && !hasUntalliedPerformanceParameter) {
    return false;
  }

  return !/\b(?:API|grensesnitt|autentisering|sikkerhetsmekanisme|datamodell|felt(?:er|mapping)?|(?:felt|data)?mapping|datakvalitetsavvik|dataobjekt|logging|loggstruktur|rolle(?:r)?|tilgang|varslingskanal|mottaker|hendelse|testdata|testscenario|testomfang|migreringsomfang|wave-plan|backupfrekvens|oppbevaring|kapasitetsmodell|skalering|autoskalering|provisjonering|provisjonert\s+kapasitet|kapasitetsmargin|reservekapasitet|lasttest|ytelsestest|belastningstest|verifikasjon|verifikasjonsmetode|uttrekksformat|eksportformat|filformat|leveranseformat)\b/i.test(
    sentence,
  );
}

function containsDeferredDecision(value: string) {
  const decision =
    String.raw`(?:avklar\w*|bekreft\w*|fastsett\w*|definer\w*|detaljer\w*|beslutt\w*|bestem\w*|velg\w*)`;
  const later =
    String.raw`(?:etter\s+(?:kontraktsinngåelse|kontraktstildeling|tildeling|signering)|i\s+en\s+senere\s+(?:fase|prosjektfase)|senere\s+(?:fase|prosjektfase)|etter\s+kontrakten\s+er\s+(?:inngått|tildelt|signert))`;
  return (
    new RegExp(String.raw`\b${decision}\b[^.!?]{0,140}\b${later}\b`, "i").test(
      value,
    ) ||
    new RegExp(String.raw`\b${later}\b[^.!?]{0,140}\b${decision}\b`, "i").test(
      value,
    )
  );
}

function hasDeferredCoreScope(answer: string) {
  return splitIntoSentences(answer).some((sentence) => {
    const deferred =
      /\b(?:avklares|bekreftes|fastsettes|defineres|detaljeres|beskrives|avtales|beslutte|besluttes|beslutter|bestemme|bestemmes|bestemmer|velge|velges|velger|leveres|implementeres)\b[^.]{0,120}\b(?:designfas(?:en|e)|løsningsforslag(?:et)?|senere(?:\s+prosjektfase)?|detaljprosjektering(?:en)?|med kunden|før (?:endelig )?forpliktelse)\b/i.test(
        sentence,
      ) ||
      /\b(?:designfas(?:en|e)|løsningsforslag(?:et)?|senere(?:\s+prosjektfase)?|detaljprosjektering(?:en)?)\b[^.]{0,120}\b(?:avklare|bekrefte|fastsette|definere|detaljere|beskrive|beslutte|besluttes|beslutter|bestemme|bestemmes|bestemmer|velge|velges|velger|levere|implementere)\b/i.test(
        sentence,
      );
    return (
      (deferred || containsDeferredDecision(sentence)) &&
      !isAllowedParameterClarification(sentence)
    );
  });
}

function answerUsesFutureDescriptionInsteadOfAnswer(answer: string) {
  return (
    /\b(?:løsningsforslag(?:et)?|designdokument(?:et)?)\s+(?:vil|skal)\s+(?:(?:også|senere)\s+){0,2}(?:beskrive|dokumentere|avklare|bekrefte)\b/i.test(
      answer,
    ) ||
    /\btilbud(?:et)?\s+vil\s+(?:(?:også|senere)\s+){0,2}(?:beskrive|dokumentere|avklare|bekrefte)\s+hvordan\b/i.test(
      answer,
    )
  );
}

function answerUsesPassiveWeakCommitment(answer: string) {
  return (
    /\b(?:dette|kravet|funksjonaliteten|tjenesten|leveransen|integrasjonen|løsningen)\s+(?:kan|vil\s+kunne)\s+(?:leveres|tilbys|stilles|etableres|beskrives|dokumenteres|måles|støttes|integreres|implementeres)\b/i.test(
      answer,
    ) ||
    /(?:^|[.!?]\s+)(?:kan|vil\s+kunne)\s+(?:leveres|tilbys|stilles|etableres|beskrives|dokumenteres|måles|støttes|integreres|implementeres)\b/i.test(
      answer,
    )
  );
}

function architectureCommitmentClauses(answer: string) {
  return normalizePageText(answer)
    .split(/(?:[.!?;]\s+|\n+|\s+men\s+)/iu)
    .map((clause) => clause.trim())
    .filter(Boolean);
}

function controlClauseIsNoncommittal(clause: string, signal: RegExp) {
  const source = `(?:${signal.source})`;
  const prefix = new RegExp(
    `\\b(?:ingen|uten)\\s+(?:[\\p{L}\\p{N}-]+\\s+){0,4}${source}`,
    "iu",
  );
  const preSignalNegation = new RegExp(
    `\\b(?:(?:bruker|benytter|etablerer|leverer|utfører|implementerer|tilbyr)\\s+ikke|` +
      `(?:does|will)\\s+not\\s+(?:use|establish|deliver|perform|implement|provide))` +
      `\\s+(?:[\\p{L}\\p{N}-]+\\s+){0,3}${source}`,
    "iu",
  );
  const preSignalOptional = new RegExp(
    `(?:\\b(?:ved\\s+behov|som\\s+(?:opsjon|tilvalg)|valgfri(?:tt)?)\\b.{0,55}${source}|` +
      `\\b(?:kan|may)\\s+(?:bruke|benytte|etablere|levere|utføre|implementere|tilby|use|establish|deliver|perform|implement|provide)` +
      `\\s+(?:[\\p{L}\\p{N}-]+\\s+){0,3}${source})`,
    "iu",
  );
  const suffix = new RegExp(
    `${source}.{0,55}\\b(?:` +
      `(?:brukes|benyttes|etableres|leveres|inngår|utføres)\\s+ikke|` +
      `ikke(?!\\s+bare\\b)|` +
      `(?:er\\s+)?(?:valgfri(?:tt)?|opsjon|tilvalg|ved\\s+behov)|` +
      `(?:omtales|vurderes|foreslås)\\s+(?:bare|kun)\\s+som\\s+(?:alternativ|opsjon|mulighet)|` +
      `kan\\s+(?:brukes|benyttes|etableres|leveres|velges|aktiveres|utføres)|` +
      `may\\s+be\\s+used` +
      `)\\b`,
    "iu",
  );
  return (
    prefix.test(clause) ||
    preSignalNegation.test(clause) ||
    preSignalOptional.test(clause) ||
    suffix.test(clause)
  );
}

function hasCommittedControl(
  answer: string,
  mechanisms: RegExp[],
) {
  const clauses = architectureCommitmentClauses(answer);
  return mechanisms.some((mechanism) => {
    const relevant = clauses.filter((clause) => mechanism.test(clause));
    return (
      relevant.some(
        (clause) => !controlClauseIsNoncommittal(clause, mechanism),
      ) &&
      !relevant.some((clause) =>
        controlClauseIsNoncommittal(clause, mechanism),
      )
    );
  });
}

const API_MECHANISM_PATTERNS = [
  /\bREST(?:-?API|\s+API|\s+over\s+HTTPS)\b/iu,
  /\bGraphQL\b/iu,
  /\bSOAP\b/iu,
  /\bOpenAPI\b/iu,
  /\bwebhook\b/iu,
  /\bmeldingskø\b/iu,
  /\bhendelsesstrøm\b/iu,
  /\bAPI-(?:kontrakt|grensesnitt|endepunkt)\b/iu,
  /\bversjonert\s+(?:API|grensesnitt)\b/iu,
];

const AUTHENTICATION_MECHANISM_PATTERNS = [
  /\b(?:OAuth(?:\s*2(?:\.0)?)?|OIDC|OpenID Connect)\b/iu,
  /\bklientlegitimasjon\b/iu,
  /\btjenesteidentitet\b/iu,
  /\bmTLS\b/iu,
  /\bføderert identitet\b/iu,
  /\bsertifikat(?:basert)?\b/iu,
  /\btoken(?:basert)?\b/iu,
];

function hasConcreteApiPattern(answer: string) {
  return hasCommittedControl(answer, API_MECHANISM_PATTERNS);
}

function hasConcreteAuthenticationPattern(answer: string) {
  return hasCommittedControl(answer, AUTHENTICATION_MECHANISM_PATTERNS);
}

function namedDataModelExamples(answer: string) {
  const genericItem = /^(?:(?:faste|sentrale|relevante)\s+)*(?:(?:data|kjerne)\s*)?objekt(?:er)?$|^(?:faste\s+)?felt(?:er)?$|^identifikator(?:er)?$|^feltmapping$|^feltkartlegging$|^mapping$|^valideringsregel(?:r)?$|^validering$/iu;
  const explicitlyNamedObjects = Array.from(
    answer.matchAll(
      /\b(?:objektet|dataobjektet|dataelementet)\s+([\p{L}][\p{L}\p{N}_-]{2,})\b/giu,
    ),
    (match) => normalizeComparableText(match[1] ?? ""),
  ).filter((item) => item.length >= 3 && !genericItem.test(item));
  if (new Set(explicitlyNamedObjects).size >= 1) {
    return Array.from(new Set(explicitlyNamedObjects));
  }
  const clauses = answer.matchAll(
    /\b(?:datamodell(?:en)?\s+(?:omfatter|inkluderer|består\s+av|definerer)|(?:(?:kjerne|data|sentrale)\s*)?objekt(?:et|er|ene)?\s+(?:som|er|inkluderer|omfatter))\s+([^.!?;]{3,260})/giu,
  );

  for (const match of clauses) {
    const body = (match[1] ?? "")
      .replace(
        /^(?:(?:kjerne|data|sentrale)\s*)?objekt(?:et|er|ene)?(?:\s+(?:som|er|inkluderer|omfatter))?\s+/iu,
        "",
      )
      .replace(/^(?:minst|blant\s+annet)\s+/iu, "")
      .trim();
    const items = body
      .split(/\s*,\s*|\s+(?:og|eller|samt)\s+/iu)
      .map((item) =>
        normalizeComparableText(
          item
            .replace(/^(?:minst|blant\s+annet)\s+/iu, "")
            .replace(
              /\s+med\s+(?:faste\s+)?(?:identifikator(?:er)?|nøkkelfelt|feltmapping|feltkartlegging|mapping|valider\p{L}*).*$/iu,
              "",
            )
            .replace(/[,:]+$/u, "")
            .trim(),
        ),
      )
      .filter((item) => item.length >= 3 && !genericItem.test(item));
    if (new Set(items).size >= 2) {
      return items;
    }
  }

  return [];
}

export function apiIntegrationTargets(requirement: string) {
  const match = requirement.match(
    /\b(?:utveksling\s+)?mellom\s+skyplattformen\s+og\s+([^.;:]+)/iu,
  );
  if (!match?.[1]) {
    return [];
  }

  return match[1]
    .split(/\s*,\s*|\s+(?:og|samt)\s+|\s*\/\s*/iu)
    .map((target) => normalizeComparableText(target))
    .filter((target) => target.length >= 3);
}

const API_DATA_MODEL_DOMAIN_STOP_WORDS = new Set([
  "leverandøren",
  "løsningen",
  "skal",
  "beskrive",
  "api",
  "autentisering",
  "datamodell",
  "utveksling",
  "mellom",
  "skyplattformen",
  "data",
  "system",
]);

const API_TARGET_MODEL_ALIASES = [
  {
    target: /^kalender$/u,
    example: /^(?:kalender(?:hendelse|avtale)?|avtale|møte)$/u,
  },
  {
    target: /^identitet$/u,
    example:
      /^(?:identitet|bruker(?:identitet|konto)?|rolle|gruppe|tilgangsprofil)$/u,
  },
  {
    target: /^(?:medlemsregister|medlem)$/u,
    example:
      /^(?:medlem(?:skap|sstatus)?|frivillig|kontaktinformasjon|status)$/u,
  },
] as const;

function dataModelExampleGroundsTarget(example: string, target: string) {
  const lexicalMatch = tokenizeComparableText(example).some((exampleToken) =>
    tokenizeComparableText(target).some(
      (targetToken) =>
        exampleToken.includes(targetToken) ||
        targetToken.includes(exampleToken),
    ),
  );
  if (lexicalMatch) {
    return true;
  }
  return API_TARGET_MODEL_ALIASES.some(
    (alias) => alias.target.test(target) && alias.example.test(example),
  );
}

function namedExamplesAreRequirementGrounded(input: {
  examples: string[];
  requirement: string;
  answer: string;
}) {
  const proposedContract =
    /\b(?:foreslått|foreslås|som\s+forslag)\s+(?:integrasjonskontrakt|datamodell|feltmapping|objektmodell)|\b(?:integrasjonskontrakt|datamodell|feltmapping|objektmodell)\s+(?:foreslås|er\s+foreslått)\b/i.test(
      input.answer,
    );
  const examples = Array.from(
    new Set(
      input.examples
        .map((example) => normalizeComparableText(example))
        .filter(Boolean),
    ),
  );
  const targets = apiIntegrationTargets(input.requirement);
  if (targets.length > 0) {
    const groundedExamples = examples.filter((example) =>
      targets.some((target) => dataModelExampleGroundsTarget(example, target)),
    );
    return (
      groundedExamples.length >= 2 &&
      targets.every((target) =>
        examples.some((example) =>
          dataModelExampleGroundsTarget(example, target),
        ),
      )
    );
  }

  const requirementTokens = tokenizeComparableText(input.requirement).filter(
    (token) =>
      token.length >= 5 && !API_DATA_MODEL_DOMAIN_STOP_WORDS.has(token),
  );
  const groundedExamples = examples.filter((namedExample) => {
    const tokens = tokenizeComparableText(namedExample).filter(
      (token) => token.length >= 5,
    );
    return tokens.some((example) =>
      requirementTokens.some(
        (source) =>
          example.includes(source) || source.includes(example),
      ),
    );
  });
  return groundedExamples.length >= 2 || (proposedContract && examples.length >= 2);
}

const DATA_MODEL_EXAMPLE_PATTERN =
  /\b(?:datamodell(?:en)?|objektmodell(?:en)?|dataobjekt(?:et|er|ene)?|kjerneobjekt(?:et|er|ene)?|objekt(?:et|er|ene)?|dataelement(?:et|er|ene)?)\b/iu;

const DATA_MODEL_KEY_PATTERN =
  /\b(?:identifikator(?:er)?|nøkkelfelt|referanse-?ID|ekstern-?ID|ID)\b/iu;

const DATA_MODEL_MAPPING_PATTERN =
  /\b(?:feltmapping|feltkartlegging|feltoversettelse|mapping|mapper|oversett(?:es|er))\b/iu;

const DATA_MODEL_VALIDATION_PATTERN =
  /\b(?:valider\p{L}*|skjemakontroll|formatkontroll|regelkontroll)\b/iu;

const GENERIC_FIELD_MAPPING_TOKENS = new Set([
  "aktuell",
  "aktuelle",
  "andre",
  "attributt",
  "attributter",
  "attributtet",
  "attributtene",
  "data",
  "dataelement",
  "dataelementer",
  "datafelt",
  "datafelter",
  "datamodell",
  "datamodellen",
  "element",
  "elementer",
  "elementet",
  "elementene",
  "fast",
  "faste",
  "felt",
  "felter",
  "feltet",
  "feltene",
  "kartlegging",
  "logging",
  "mapping",
  "ingen",
  "ingenting",
  "navngitt",
  "navngitte",
  "nødvendig",
  "nødvendige",
  "relevant",
  "relevante",
  "sentral",
  "sentrale",
  "verdi",
  "verdier",
  "øvrige",
]);

const GENERIC_FIELD_MAPPING_NOUNS = new Set([
  "attributt",
  "attributter",
  "attributtet",
  "attributtene",
  "data",
  "dataelement",
  "dataelementer",
  "datafelt",
  "datafelter",
  "datamodell",
  "datamodellen",
  "element",
  "elementer",
  "elementet",
  "elementene",
  "felt",
  "felter",
  "feltet",
  "feltene",
  "verdi",
  "verdier",
]);

const FIELD_MAPPING_CONTROL_VERB_PATTERN =
  /\b(?:gjennomføres|utføres|etableres|leveres|brukes|valideres|logges|håndteres)\b/iu;

function isConcreteFieldMappingCandidate(value: string) {
  const comparable = normalizeComparableText(value);
  const tokens = tokenizeComparableText(comparable).filter(
    (token) => token.length >= 2,
  );
  return (
    comparable.length >= 2 &&
    comparable.length <= 60 &&
    !FIELD_MAPPING_CONTROL_VERB_PATTERN.test(comparable) &&
    !tokens.some((token) => GENERIC_FIELD_MAPPING_NOUNS.has(token)) &&
    tokens.some((token) => !GENERIC_FIELD_MAPPING_TOKENS.has(token))
  );
}

function normalizeDetailedFieldMappingCandidates(value: string) {
  return value
    .split(/\s*,\s*|\s+(?:og|eller|samt)\s+/iu)
    .map((item) =>
      normalizeComparableText(
        item
          .replace(/^(?:feltene?|attributtene?|dataelementene?)\s+/iu, "")
          .replace(/\s+(?:for|til|med|som)\s+.+$/iu, "")
          .replace(/[,:]+$/u, "")
          .trim(),
      ),
    )
    .filter((item) => isConcreteFieldMappingCandidate(item));
}

function detailedCommittedFieldMappingCandidates(answer: string) {
  const fields: string[] = [];
  for (const clause of architectureCommitmentClauses(answer)) {
    if (controlClauseIsNoncommittal(clause, DATA_MODEL_MAPPING_PATTERN)) {
      continue;
    }
    for (const match of clause.matchAll(
      /\b(?:(?:feltmapping|feltkartlegging|feltoversettelse|mapping)\s+av|mapper(?:\s+(?:felt(?:et|er|ene)?|attributt(?:et|er|ene)?|dataelement(?:et|er|ene)?))?)\s+([^.!?;)]{3,220})/giu,
    )) {
      fields.push(
        ...normalizeDetailedFieldMappingCandidates(match[1] ?? ""),
      );
    }
    for (const match of clause.matchAll(
      /\b((?:[\p{L}\p{N}_-]+(?:\s*,\s*|\s+(?:og|samt)\s+)){1,8}[\p{L}\p{N}_-]+)\s+oversett(?:es|er)\s+(?:eksplisitt\s+)?til\s+(?:tilsvarende\s+)?felt\b/giu,
    )) {
      fields.push(
        ...normalizeDetailedFieldMappingCandidates(match[1] ?? ""),
      );
    }
  }
  return Array.from(new Set(fields));
}

function hasDetailedCommittedFieldMapping(answer: string) {
  return detailedCommittedFieldMappingCandidates(answer).length >= 2;
}

function hasConcreteDataModelPattern(answer: string, requirement: string) {
  if (
    (isExactIdentityCrmApiRequirement(requirement) &&
      hasCompleteIdentityCrmApiContract(answer)) ||
    (isExactPaymentApiRequirement(requirement) &&
      hasCompletePaymentApiContract(answer)) ||
    (isExactLmsApiRequirement(requirement) && hasCompleteLmsApiContract(answer))
  ) {
    return true;
  }
  const comparableAnswer = normalizeComparableText(answer);
  const targets = apiIntegrationTargets(requirement);
  const clauses = architectureCommitmentClauses(answer);
  const hasCommittedExamples = clauses.some(
    (clause) => {
      const examples = namedDataModelExamples(clause);
      return (
        examples.length >= 2 &&
        namedExamplesAreRequirementGrounded({
          examples,
          requirement,
          answer: clause,
        }) &&
        !controlClauseIsNoncommittal(clause, DATA_MODEL_EXAMPLE_PATTERN)
      );
    },
  );
  const hasNoncommittalTargetExample = clauses.some((clause) => {
    if (!controlClauseIsNoncommittal(clause, DATA_MODEL_EXAMPLE_PATTERN)) {
      return false;
    }
    const examples = namedDataModelExamples(clause);
    if (examples.length === 0 || targets.length === 0) {
      return examples.length > 0;
    }
    return examples.some((example) =>
      targets.some((target) => dataModelExampleGroundsTarget(example, target)),
    );
  });
  return (
    hasCommittedExamples &&
    !hasNoncommittalTargetExample &&
    hasCommittedControl(answer, [DATA_MODEL_KEY_PATTERN]) &&
    hasCommittedControl(answer, [DATA_MODEL_MAPPING_PATTERN]) &&
    (hasCommittedControl(answer, [DATA_MODEL_VALIDATION_PATTERN]) ||
      hasDetailedCommittedFieldMapping(answer)) &&
    targets.every((target) => comparableAnswer.includes(target))
  );
}

const API_OPERATION_PATTERN =
  /\b(?:operasjon(?:en|er|ene)?|API-operasjon(?:en|er|ene)?|endepunkt(?:et|er|ene)?)\b[^.!?;]{0,100}\b(?:opprett\p{L}*|hent\p{L}*|les\p{L}*|oppdater\p{L}*|skriv\p{L}*|publiser\p{L}*|motta\p{L}*|GET|POST|PUT|PATCH|DELETE)\b|\b(?:API(?:-et)?|grensesnittet|integrasjonen)\b[^.!?;]{0,60}\b(?:støtter|eksponerer|bruker|leverer)\b[^.!?;]{0,80}\b(?:opprett\p{L}*|hent\p{L}*|les\p{L}*|oppdater\p{L}*|skriv\p{L}*|publiser\p{L}*|motta\p{L}*|GET|POST|PUT|PATCH|DELETE)\b/iu;

const API_AUTHORIZATION_SCOPE_PATTERN =
  /\b(?:(?:separate|begrens(?:et|ede)|minste\s+nødvendige|navngitte)\s+(?:OAuth\s*2(?:\.0)?-?)?scopes?|[\p{L}\p{N}]+-scope|API-rettighet(?:er)?|tilgangsomfang|begrens(?:et|ede)\s+rettighet(?:er)?|minste\s+privilegium\b[^.!?;]{0,100}\b(?:egne\s+)?rettighetssett)\b/iu;

const API_DATA_OWNERSHIP_PATTERN =
  /\b(?:[\p{L}\p{N}-]+(?:\s+og\s+[\p{L}\p{N}-]+)?\s+er\s+(?:master|(?:hvert\s+sitt\s+)?system\s+of\s+record)|autoritativ(?:e|t)?\s+(?:kilde|system)|[\p{L}\p{N}-]+\s+er\s+dataeier|eier\s+(?:av|for)\s+(?:data|objekt\p{L}*))\b/iu;

const API_SYNC_DIRECTION_PATTERN =
  /\b(?:synkretningen?|dataflyten?)\s+(?:er|går)\s+(?:enveis|toveis|fra|til|inn|ut)\b|\b(?:synkroniser\p{L}*|hent\p{L}*|motta\p{L}*|publiser\p{L}*|send\p{L}*|strømmer?)\b[^.!?;]{0,140}\b(?:fra|til|inn|ut|tilbake|én\s+vei)\b/iu;

const API_INVALID_DATA_HANDLING_PATTERN =
  /\b(?:avvis\p{L}*|flagg\p{L}*|stopp\p{L}*|rut\p{L}*|karantene|avvikslogg|feilkø|dead-?letter-?kø)\b[^.!?;]{0,140}\b(?:manglende|ugyldig\p{L}*|konflikt\p{L}*|feil\p{L}*)\b|\b(?:manglende|ugyldig\p{L}*|konflikt\p{L}*|feil\p{L}*)\b[^.!?;]{0,140}\b(?:avvis\p{L}*|flagg\p{L}*|stopp\p{L}*|rut\p{L}*|karantene|avvikslogg|feilkø|dead-?letter-?kø)\b|\bingen\s+(?:manglende|ugyldige|konfliktende)\s+data\s+(?:godtas|aksepteres|tillates)\b/iu;

const API_UNSAFE_SCOPE_PATTERN =
  /\b(?:ubegrenset|superuser|superbruker|administrator|admin|wildcard|alle\s+rettigheter|full\s+tilgang)\b[^.!?;]{0,50}\b(?:scope|rettighet|tilgang)|\b(?:scope|rettighet|tilgang)\b[^.!?;]{0,50}\b(?:ubegrenset|superuser|superbruker|administrator|admin|wildcard|alle\s+rettigheter|full\s+tilgang)\b/iu;

const API_NEGATED_CONTRACT_PATTERN =
  /\b(?:aldri|verken|ingen|uten)\b[^.!?;]{0,100}\b(?:master|autoritativ(?:e|t)?\s+(?:kilde|system)|system\s+of\s+record|dataeier)\b|\b(?:aldri|verken)\b[^.!?;]{0,100}\b(?:synkroniser\p{L}*|strømmer?|avvis\p{L}*|flagg\p{L}*|stopp\p{L}*|rut\p{L}*)\b|\b(?:synkroniser\p{L}*|strømmer?|avvis\p{L}*|flagg\p{L}*|stopp\p{L}*|rut\p{L}*)\b[^.!?;]{0,40}\b(?:ikke|aldri)\b|\b(?:GET|POST|PUT|PATCH|DELETE)\b[^.!?;]{0,50}\b(?:kun|bare)\s+(?:et\s+)?mulig\s+eksempel\b/iu;

const API_TARGET_FIELD_ALIASES = [
  {
    target: /^kalender$/u,
    field:
      /\b(?:hendelse|hendelses-id|eventid|uid|tittel|starttid|sluttid|tidspunkt|dato|status)\b/u,
  },
  {
    target: /^identitet$/u,
    field:
      /\b(?:bruker|bruker-id|userid|objectid|e-post|epost|rolle|gruppe|visningsnavn|aktiv-status|status)\b/u,
  },
  {
    target: /^(?:medlemsregister|medlem)$/u,
    field:
      /\b(?:medlem|medlems-id|frivillig|frivillig-id|navn|kontaktinformasjon|status|type|gyldig-fra|gyldig-til|gyldighetsperiode)\b/u,
  },
] as const;

function apiContractClauseGroundsTargets(
  clause: string,
  targets: string[],
) {
  if (!targets.length) {
    return true;
  }
  const comparableClause = normalizeComparableText(clause);
  return targets.every(
    (target) =>
      comparableClause.includes(target) ||
      API_TARGET_MODEL_ALIASES.some(
        (alias) =>
          alias.target.test(target) &&
          tokenizeComparableText(comparableClause).some((token) =>
            alias.example.test(token),
          ),
      ),
  );
}

function hasTargetBoundCommittedApiControl(input: {
  answer: string;
  requirement: string;
  mechanism: RegExp;
}) {
  const targets = apiIntegrationTargets(input.requirement);
  const sentences = normalizePageText(input.answer)
    .split(/(?<=[.!?])\s+|\n+/u)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
  return sentences.some((sentence) => {
    let previousClauseGrounded = false;
    return architectureCommitmentClauses(sentence).some((clause) => {
      const directlyGrounded = apiContractClauseGroundsTargets(
        clause,
        targets,
      );
      const safeAnaphoricContinuation =
        previousClauseGrounded &&
        /^(?:integrasjonen|grensesnittet|API-et|dette\s+grensesnittet|denne\s+integrasjonen)\b/iu.test(
          clause,
        ) &&
        !/\b(?:separat|økonomi|faktura|betaling|arkiv|lønn|regnskap)\w*\b/iu.test(
          clause,
        );
      const grounded = directlyGrounded || safeAnaphoricContinuation;
      previousClauseGrounded = directlyGrounded;
      return (
        grounded &&
        input.mechanism.test(clause) &&
        !controlClauseIsNoncommittal(
          clause
            .replace(
              /\bingen\s+(manglende|ugyldige|konfliktende)\s+data\s+(?:godtas|aksepteres|tillates)\b/giu,
              "$1 data avvises",
            )
            .replace(
              /\b(?:ingen|uten)\s+(?:ubegrenset\s+)?(?:superuser|superbruker|administrator|admin)-?(?:scope|rettighet(?:er)?|tilgang)\b/giu,
              " ",
            ),
          input.mechanism,
        )
      );
    });
  });
}

function hasUnsafeApiScope(answer: string) {
  const withoutExplicitDenials = answer.replace(
    /\b(?:ingen|uten)\s+(?:ubegrenset\s+)?(?:superuser|superbruker|administrator|admin)-?(?:scope|rettighet(?:er)?|tilgang)\b/giu,
    " ",
  );
  return API_UNSAFE_SCOPE_PATTERN.test(withoutExplicitDenials);
}

function detailedFieldMappingGroundsApiTargets(
  answer: string,
  requirement: string,
) {
  const fields = detailedCommittedFieldMappingCandidates(answer);
  const targets = apiIntegrationTargets(requirement);
  if (fields.length < 2) {
    return false;
  }
  if (targets.length === 0) {
    return true;
  }
  return targets.every((target) => {
      const knownAliases = API_TARGET_FIELD_ALIASES.filter((alias) =>
        alias.target.test(target),
      );
      if (knownAliases.length > 0) {
        const joinedFields = fields.join(" ");
        return knownAliases.some((alias) => alias.field.test(joinedFields));
      }

      return fields.some((field) =>
        dataModelExampleGroundsTarget(field, target),
      );
    });
}

function hasCompleteApiIntegrationContract(
  answer: string,
  requirement: string,
) {
  if (
    (isExactIdentityCrmApiRequirement(requirement) &&
      hasCompleteIdentityCrmApiContract(answer)) ||
    (isExactPaymentApiRequirement(requirement) &&
      hasCompletePaymentApiContract(answer)) ||
    (isExactLmsApiRequirement(requirement) && hasCompleteLmsApiContract(answer))
  ) {
    return true;
  }
  const hasBound = (mechanism: RegExp) =>
    hasTargetBoundCommittedApiControl({ answer, requirement, mechanism });
  return (
    !hasUnsafeApiScope(answer) &&
    !API_NEGATED_CONTRACT_PATTERN.test(answer) &&
    hasBound(API_OPERATION_PATTERN) &&
    hasBound(API_AUTHORIZATION_SCOPE_PATTERN) &&
    hasBound(API_DATA_OWNERSHIP_PATTERN) &&
    hasBound(API_SYNC_DIRECTION_PATTERN) &&
    hasDetailedCommittedFieldMapping(answer) &&
    detailedFieldMappingGroundsApiTargets(answer, requirement) &&
    hasBound(API_INVALID_DATA_HANDLING_PATTERN)
  );
}

export function isNoManualSpreadsheetRequirement(requirement: string) {
  return (
    /uten\s+dobbeltregistrering/i.test(requirement) &&
    /manuelle?\s+regneark/i.test(requirement)
  );
}

function hasExplicitManualSpreadsheetElimination(answer: string) {
  return [
    /(?:uten\s+(?:behov\s+for\s+)?|ingen\s+)(?:manuelle?\s+)?regneark\b/i,
    /\bmanuelle?\s+regneark\b[^.!?;]{0,60}\b(?:brukes\s+ikke(?!\s+(?:bare|kun))|er\s+ikke\s+nødvendig|utgår(?!\s+ikke)|elimineres(?!\s+ikke)|inngår\s+ikke\s+i\s+(?:arbeidsflyten|løsningen))\b/i,
    /\b(?:fremfor|i\s+stedet\s+for)\s+(?:i\s+)?(?:manuelle?\s+)?regneark\b/i,
    /\b(?:løsningen|arbeidsflyten?|plattformen|systemet|funksjonaliteten|dette)\b[^.!?;]{0,60}\b(?:eliminerer|fjerner|erstatter|avvikler)\s+(?:helt\s+)?(?:(?:behovet\s+for|bruken\s+av|bruk\s+av)\s+)?(?:manuelle?\s+)?regneark\b/i,
    /\b(?:behovet\s+for\s+)?manuelle?\s+regneark\b[^.!?;]{0,40}\b(?:bortfaller|opphører)(?!\s+ikke)\b/i,
    /\bbehovet\s+for\s+manuelle?\s+regneark\b[^.!?;]{0,30}\b(?:elimineres|fjernes)(?!\s+ikke)\b/i,
    /\bmanuelle?\s+regneark\b[^.!?;]{0,40}\b(?:erstattes|avvikles)(?!\s+ikke)\b[^.!?;]{0,30}\b(?:av|med)\s+(?:løsningen|arbeidsflyten|plattformen|systemet)\b/i,
    /\b(?:ikke\s+lenger|intet)\s+behov\s+for\s+manuelle?\s+regneark\b/i,
  ].some((pattern) => pattern.test(answer));
}

export function isLosslessQueueRetryRequirement(requirement: string) {
  return (
    /integrer/i.test(requirement) &&
    /feil/i.test(requirement) &&
    /kø/i.test(requirement) &&
    /(?:ny\s+kjøring|nykjøring|gjenkjøring|retry)/i.test(requirement) &&
    /uten\s+tap/i.test(requirement)
  );
}

export function requirementExactlyMatches(value: string, expected: string) {
  return (
    normalizeRequirementLedgerText(value).toLocaleLowerCase("nb") ===
    normalizeRequirementLedgerText(expected).toLocaleLowerCase("nb")
  );
}

export function isExactIdentityCrmApiRequirement(requirement: string) {
  return requirementExactlyMatches(
    requirement,
    "Leverandøren skal beskrive API, autentisering og datamodell for utveksling mellom skyplattformen og ID-porten og CRM.",
  );
}

export function isExactPaymentApiRequirement(requirement: string) {
  return requirementExactlyMatches(
    requirement,
    "Leverandøren skal beskrive API, autentisering og datamodell for utveksling mellom skyplattformen og betalingsløsning.",
  );
}

export function isExactLmsApiRequirement(requirement: string) {
  return requirementExactlyMatches(
    requirement,
    "Leverandøren skal beskrive API, autentisering og datamodell for utveksling mellom skyplattformen og LMS.",
  );
}

export function hasCompletePaymentApiContract(answer: string) {
  const text = normalizePageText(answer);
  return (
    !hasUnsafeApiScope(text) &&
    !API_NEGATED_CONTRACT_PATTERN.test(text) &&
    /\bREST-API\b/iu.test(text) &&
    /\bOAuth 2\.0-klientlegitimasjon\b/iu.test(text) &&
    /\b(?:betalingsløsning-lesing|betaling-lesing)\b/iu.test(text) &&
    /\b(?:betalingsløsning-skriving|betaling-opprett)\b/iu.test(text) &&
    [
      "betalingstransaksjon",
      "kurspåmelding",
      "deltakerkobling",
      "oppgjør",
      "transaksjons-ID",
      "påmeldings-ID",
      "deltaker-ID",
      "beløp",
      "valuta",
      "betalingsstatus",
      "tidsstempel",
      "feilkode",
      "oppgjørsreferanse",
    ].every((value) => text.toLocaleLowerCase("nb").includes(value.toLocaleLowerCase("nb"))) &&
    /\bskyplattformen er autoritativ\w*\b[^.!?;]{0,180}\bkurspåmelding\b/iu.test(
      text,
    ) &&
    /\bbetalingsløsningen er (?:autoritativt system|system of record|master)\b/iu.test(
      text,
    ) &&
    /\bskyplattformen sender\b[^.!?;]{0,180}\bbetalingsforespørsel\b/iu.test(
      text,
    ) &&
    /\bmottar\b[^.!?;]{0,180}\b(?:status|oppgjør)\w*/iu.test(text) &&
    /\b(?:avviser|feilkø)\b/iu.test(text)
  );
}

export function hasCompleteLmsApiContract(answer: string) {
  const text = normalizePageText(answer);
  return (
    !hasUnsafeApiScope(text) &&
    !API_NEGATED_CONTRACT_PATTERN.test(text) &&
    /\bREST-API\b/iu.test(text) &&
    /\bOAuth 2\.0-klientlegitimasjon\b/iu.test(text) &&
    /\bLMS-lesing\b/iu.test(text) &&
    /\bLMS-skriving\b/iu.test(text) &&
    [
      "kurs",
      "kursgjennomføring",
      "deltaker",
      "prøve",
      "resultat",
      "sertifikat",
      "kurs-ID",
      "gjennomførings-ID",
      "deltaker-ID",
      "prøve-ID",
      "sertifikat-ID",
      "påmeldingsstatus",
      "poengsum",
      "beståttstatus",
      "gyldighetsperiode",
    ].every((value) => text.toLocaleLowerCase("nb").includes(value.toLocaleLowerCase("nb"))) &&
    /\bLMS er (?:autoritativt system|system of record|master)\b[^.!?;]{0,180}\b(?:kursgjennomføring|prøve|resultat)\b/iu.test(
      text,
    ) &&
    /\bskyplattformen er autoritativ\w*\b[^.!?;]{0,180}\b(?:påmelding|sertifikat)\b/iu.test(
      text,
    ) &&
    /\bmottar\b[^.!?;]{0,180}\bresultat\b/iu.test(text) &&
    /\bpubliserer\b[^.!?;]{0,180}\bsertifikatstatus\b/iu.test(text) &&
    !/\bhent(?:er)? sertifikat\b/iu.test(text) &&
    /\bsynkroniser\w*\b/iu.test(text) &&
    /\b(?:avviser|feilkø)\b/iu.test(text)
  );
}

export function hasCompleteIdentityCrmApiContract(answer: string) {
  const text = normalizePageText(answer);
  const identityContract =
    !hasUnsafeApiScope(text) &&
    !API_NEGATED_CONTRACT_PATTERN.test(text) &&
    /\bID-porten\b/iu.test(text) &&
    /\b(?:OIDC|OpenID Connect)\b/iu.test(text) &&
    /\bAuthorization Code\b/iu.test(text) &&
    /\bPKCE\b/iu.test(text) &&
    /\b(?:ID-token|ID token)\b/iu.test(text) &&
    /\b(?:sub|acr|amr)\b/iu.test(text);
  const crmContract =
    /\bCRM\b/iu.test(text) &&
    /\bREST-API\b/iu.test(text) &&
    /\bOAuth 2\.0-klientlegitimasjon\b/iu.test(text) &&
    /\bCRM-(?:lesing|skriving)\b/iu.test(text) &&
    /\boperasjonene?\b[^.!?;]{0,120}\bopprett\w*\b[^.!?;]{0,80}\bhent\w*\b[^.!?;]{0,80}\boppdater\w*\b/iu.test(
      text,
    );
  const modelContract =
    /\bdatamodell(?:en)?\b/iu.test(text) &&
    /\b(?:ID-porten-identitet|identitetsbinding)\b/iu.test(text) &&
    /\bCRM-(?:kontakt|registrering)\b/iu.test(text) &&
    /\bnøkkelfelt(?:ene)?\b/iu.test(text) &&
    /\bfeltmapping\b/iu.test(text) &&
    /\b(?:ID-porten|CRM)\b[^.!?;]{0,180}\b(?:autoritativ(?:t|e)? system|system of record|master)\b/iu.test(
      text,
    ) &&
    /\bsynkroniser\w*\b/iu.test(text) &&
    /\b(?:avviser|feilkø)\b/iu.test(text);
  return identityContract && crmContract && modelContract;
}

export function hasCompleteIdentityCrmLosslessContract(answer: string) {
  const text = normalizePageText(answer);
  const identityFlow =
    /\bID-porten\b/iu.test(text) &&
    /\b(?:OIDC|OpenID Connect)\b/iu.test(text) &&
    /\b(?:synkron|synkront|synkrone)\b/iu.test(text) &&
    /\b(?:ikke\s+kø|køes\s+ikke|ikke\s+replay)\w*/iu.test(text) &&
    /\b(?:(?:lagres|committes|forpliktes)\s+ingen\s+domeneendring|ingen\s+domeneendring[^.!?;]{0,120}(?:lagres|committes|forpliktes))\b/iu.test(
      text,
    );
  const crmFlow =
    /\bCRM\b/iu.test(text) &&
    /\b(?:opprett|oppdater)\w*\b/iu.test(text) &&
    /\boutbox\b/iu.test(text) &&
    /\bidempotens\w*\b/iu.test(text) &&
    /\bdead-?letter-kø/iu.test(text) &&
    /\b(?:retry|nykjøring|ny\s+kjøring)\b/iu.test(text);
  const reconciliation =
    /\b(?:korrelasjons-ID|checkpoint)\b/iu.test(text) &&
    /\bavstemm\w*\b/iu.test(text) &&
    ["kurs", "prøver", "sertifikater", "deltakerprofiler"].every((item) =>
      text.toLocaleLowerCase("nb").includes(item),
    );
  return identityFlow && crmFlow && reconciliation;
}

export function hasCompleteLifecycleStatusContract(answer: string) {
  const text = normalizePageText(answer);
  return (
    /\bkurs\b[^.!?;]{0,180}\bopprettet\b[^.!?;]{0,100}\bpublisert\b[^.!?;]{0,100}\bpågår\b[^.!?;]{0,100}\bavsluttet\b/iu.test(
      text,
    ) &&
    /\bprøver\b[^.!?;]{0,180}\bopprettet\b[^.!?;]{0,100}åpen\b[^.!?;]{0,100}\blevert\b[^.!?;]{0,100}\bvurdert\b/iu.test(
      text,
    ) &&
    /\bsertifikater\b[^.!?;]{0,180}\bkladd\b[^.!?;]{0,100}\butstedt\b[^.!?;]{0,100}\b(?:utløpt|trukket)\b/iu.test(
      text,
    ) &&
    /\bdeltakerprofiler\b[^.!?;]{0,180}\bopprettet\b[^.!?;]{0,100}\baktiv\b[^.!?;]{0,100}\binaktiv\b/iu.test(
      text,
    ) &&
    /\bansvarlig rolle\b/iu.test(text) &&
    /\b(?:tidsstempel|tidspunkt)\b/iu.test(text) &&
    /\b(?:standardstatuser|standardmodell)\b/iu.test(text) &&
    /\bkundespesifikke\b[^.!?;]{0,100}\bkonfigurasjon\b/iu.test(text)
  );
}

export function hasCompleteOfflineTenderWorkflow(answer: string) {
  const text = normalizePageText(answer);
  return (
    /\b(?:opprette|registrere|endre)\w*\b[^.!?;]{0,180}\bpåmelding\b|\bpåmelding\b[^.!?;]{0,180}\b(?:opprette|registrere|endre)\w*\b/iu.test(
      text,
    ) &&
    /\b(?:eksamen\w*|prøveresultat\w*)\b/iu.test(
      text,
    ) &&
    /\b(?:sertifikatgrunnlag|utstedt\s+sertifikatbevis|godkjent\s+grunnlag)\b[^.!?;]{0,180}\bsertifikatbevis\b|\bsertifikatbevis\b[^.!?;]{0,180}\b(?:sertifikatgrunnlag|utstedt\s+sertifikat|godkjent\s+grunnlag)\b/iu.test(
      text,
    ) &&
    /\b(?:kryptert lokal kø|lokalt kryptert kø)/iu.test(text) &&
    /\b(?:brukeridentitet|tjenesteidentitet)\b/iu.test(text) &&
    /\btidsstempel\b/iu.test(text) &&
    /\bidempotens\w*\b/iu.test(text) &&
    /\bsynkroniser\w*\b/iu.test(text) &&
    /konflikt\w*/iu.test(text) &&
    /\b(?:avvikslogg|hendelseslogg)\b/iu.test(text)
  );
}

export function hasCompleteLowLatencyTenderContract(answer: string) {
  const text = normalizePageText(answer);
  return (
    /\blav ventetid i kritiske arbeidsprosesser\b/iu.test(text) &&
    ["påmelding", "statusoppslag", "registrering av prøveresultater", "utstedelse av sertifikat"].every(
      (operation) => text.toLocaleLowerCase("nb").includes(operation),
    ) &&
    /\bp95 under 2 sekunder\b/iu.test(text) &&
    /\b200 samtidige brukere\b/iu.test(text) &&
    /\b(?:leverandørforutsetning|Ateas tilbudte)\b/iu.test(text) &&
    /\b(?:lasttest|ytelsestest)\b/iu.test(text) &&
    /\b(?:måler|overvåker)\b[^.!?;]{0,140}\bp95\b/iu.test(text) &&
    /\bvarsler\b/iu.test(text) &&
    /\b(?:avvik|skalering|kapasitet)\b/iu.test(text)
  );
}

export function hasCompleteLowLatencyTenderSourceBinding(
  answer: string,
  entry: RequirementLedgerEntry,
) {
  const text = normalizePageText(answer);
  const flags = deterministicControlSourceFlags(entry);
  const hasOption = /\b(?:separat\s+priset\s+opsjon|opsjonen\s+(?:omfatter|leverer|forplikter))\b/iu.test(
    text,
  );
  return (
    (flags.option ? hasOption : !hasOption) &&
    (!flags.designPhase ||
      (/\bi designfasen\b/iu.test(text) &&
        /\b(?:validerer|bekrefter)\b[^.!?;]{0,120}\b(?:endelig\s+)?lastprofil\b/iu.test(
          text,
        ))) &&
    (!flags.needsNote || /\bkravraden fra behovsarbeidet\b/iu.test(text)) &&
    (!flags.priority ||
      text.includes(`prioritet «${flags.priority}»`))
  );
}

export function isExactEmployeeMobileDimensioningRequirement(requirement: string) {
  return requirementExactlyMatches(
    requirement,
    "Løsningen skal dimensjoneres for tilgjengelighet for ansatte på mobil og nettbrett uten at brukerne opplever vesentlig treghet.",
  );
}

function hasCompleteEmployeeMobileDimensioningScope(answer: string) {
  const text = normalizePageText(answer);
  return (
    /\balle ansattefunksjoner og arbeidsflater\b/iu.test(text) &&
    /\brepresentative kritiske akseptansetransaksjoner\b/iu.test(text) &&
    /\bikke en avgrensning av leveranseomfanget\b/iu.test(text) &&
    /\bhele ansatteflaten\b/iu.test(text) &&
    /\bmåler Atea de faktiske arbeidsflytene\b/iu.test(text) &&
    /\bvaliderer\b[^.!?;]{0,160}\btopprofilen\b[^.!?;]{0,160}\benhets- og nettlesermatrisen\b[^.!?;]{0,80}\bsammen med kunden\b/iu.test(
      text,
    ) &&
    /\buttrykkelig avtalt akseptanse- og dimensjoneringsprofil\b/iu.test(text) &&
    /\bleverandørbaselinen er inkludert som minste dimensjoneringsgrunnlag\b/iu.test(
      text,
    ) &&
    /\bikke fremstilt som kundens volum\b/iu.test(text) &&
    /\bvesentlige avvik dokumenteres som en kapasitet- og prisforutsetning\b/iu.test(
      text,
    ) &&
    /\bmå godkjennes før produksjonssetting\b/iu.test(text)
  );
}

function isDataValidationAndAccessRequirement(requirement: string) {
  return /\bdatavalidering\b/i.test(requirement) && /\btilgang\b/i.test(requirement);
}

export function isAutomaticNotificationAndAccessRequirement(requirement: string) {
  return (
    /\bautomatisk\s+varsling\b/i.test(requirement) &&
    /\bbare\s+får\s+tilgang\b/i.test(requirement)
  );
}

const NOTIFICATION_SIGNAL_PATTERN =
  /\b(?:automatisk\s+)?(?:varsel(?:et|er)?|varsl(?:ing(?:en)?|e(?:r|s)?|et)|melding(?:en|er)?)\b/iu;

const ACCESS_SIGNAL_PATTERN =
  /\b(?:tilgang(?:sstyring)?|rollebasert|rollemodell|tilgangsmatrise|minste\s+privilegium|dataavgrens(?:ning|es)?)\b/iu;

const NOTIFICATION_TRIGGER_PATTERNS = [
  /\b(?:opprettelse|opprettes|nytt\s+oppdrag)\b/iu,
  /\b(?:statusendring|status\s+endres)\b/iu,
  /\b(?:frist(?:brudd|utløp)?|forfall)\b/iu,
  /\bmanglende\s+(?:respons|bekreftelse|oppfølging)\b/iu,
  /\b(?:avvik|feil|tilgangsbrudd)\b/iu,
  /\b(?:samtykke\s+(?:endres|utløper|trekkes)|utløpt\s+samtykke)\b/iu,
  /\b(?:oppdrag\s+(?:tildeles|endres|avlyses)|tildeling\s+av\s+oppdrag)\b/iu,
  /\b(?:ny\s+melding|melding\s+mottas)\b/iu,
];

const NOTIFICATION_CHANNEL_PATTERN =
  /\b(?:e-?post|SMS|push(?:varsel)?|in-?app|appvarsel|varsel\s+i\s+løsningen|oppgaveliste)\b/iu;

const NOTIFICATION_CHANNEL_BINDING_PATTERN =
  /\b(?:(?:via|gjennom|per)\s+(?:e-?post|SMS|push(?:varsel)?|in-?app|appvarsel|oppgaveliste)|(?:som|med)\s+(?:pushvarsel|appvarsel|in-?app-varsel)|varsel\s+i\s+løsningen|i\s+oppgavelisten|pushvarsel|appvarsel)\b/iu;

const NOTIFICATION_TOPIC_PATTERN =
  /\b(?:oppdrag|frist(?:brudd|utløp)?|forfall|manglende\s+(?:respons|bekreftelse|oppfølging)|statusendring|samtykke(?:endring|utløp)?|avvik|feil|tilgangsbrudd|melding)\w*\b/iu;

const NOTIFICATION_RECIPIENT_ROLES = [
  { key: "frivillig", pattern: /\bfrivillig(?:e)?\b/iu },
  { key: "koordinator", pattern: /\bkoordinator(?:er)?\b/iu },
  { key: "mottaker", pattern: /\bmottaker(?:e)?\b/iu },
  { key: "pårørende", pattern: /\bpårørende\b/iu },
] as const;

function hasNoncommittalNotificationOrAccessControl(answer: string) {
  const polarityText = answer
    .replace(
      /\bkan\s+(?:bare|kun)\s+(?=(?:se|lese|behandle|endre|få\s+(?:tilgang|innsyn)|ha\s+innsyn)\b)/giu,
      "er avgrenset til å ",
    )
    .replace(
      /\b(?:bare|kun)\s+kan\s+(?=(?:se|lese|behandle|endre|få\s+(?:tilgang|innsyn)|ha\s+innsyn)\b)/giu,
      "er avgrenset til å ",
    );
  const clauses = architectureCommitmentClauses(polarityText);
  const hasCommercialOptionality = clauses.some(
    (clause) =>
      (NOTIFICATION_SIGNAL_PATTERN.test(clause) ||
        /\b(?:tilgangsstyring|rollebasert|rollemodell|tilgangsmatrise|minste\s+privilegium|dataavgrens(?:ning|es)?)\b/iu.test(clause)) &&
      /\b(?:tilleggstjeneste|opsjon\w*|tilvalg|valgfri\w*|pristillegg|mot\s+pristillegg|ved\s+særskilt\s+bestilling|særskilt\s+bestilling|etter\s+egen\s+bestilling|egen\s+bestilling|separat\s+bestilling|prises?\s+separat|ikke\s+inkludert\s+i\s+basisleverans\w*|(?:kun\s+i\s+)?(?:et\s+)?betalt\s+premiumabonnement|betalt\s+premiummodul|premiumtillegg)\b/iu.test(
        clause,
      ),
  );
  const disablesControl = clauses.some(
    (clause) =>
      (NOTIFICATION_SIGNAL_PATTERN.test(clause) ||
        ACCESS_SIGNAL_PATTERN.test(clause)) &&
      /\b(?:deaktivert|inaktiv|forblir\s+inaktiv|suspendert|avviklet|slått\s+av|frakoblet|stanset|ikke\s+aktiv(?:ert)?|ikke\s+i\s+bruk)\b/iu.test(
        clause,
      ),
  );
  return (
    hasCommercialOptionality ||
    disablesControl ||
    explicitlyNegatesRequiredSignal(polarityText, [
      NOTIFICATION_SIGNAL_PATTERN,
      ACCESS_SIGNAL_PATTERN,
    ])
  );
}

function committedNotificationClauses(answer: string) {
  return architectureCommitmentClauses(answer).filter(
    (clause) =>
      NOTIFICATION_SIGNAL_PATTERN.test(clause) &&
      !hasNoncommittalNotificationOrAccessControl(clause),
  );
}

function triggerIsBoundToNotification(clause: string, trigger: RegExp) {
  const signalMatches = Array.from(
    clause.matchAll(new RegExp(NOTIFICATION_SIGNAL_PATTERN.source, "giu")),
  );
  const triggerMatches = Array.from(
    clause.matchAll(new RegExp(trigger.source, "giu")),
  );
  return triggerMatches.some((triggerMatch) =>
    signalMatches.some((signalMatch) => {
      const signalStart = signalMatch.index;
      const signalEnd = signalStart + signalMatch[0].length;
      const triggerStart = triggerMatch.index;
      const triggerEnd = triggerStart + triggerMatch[0].length;
      const distance =
        Math.max(signalEnd, triggerEnd) - Math.min(signalStart, triggerStart);
      if (distance > 220) {
        return false;
      }
      if (signalStart < triggerStart) {
        const bindingSpan = clause.slice(signalEnd, triggerEnd);
        const bindingMatches = Array.from(
          bindingSpan.matchAll(/\b(?:ved|når|om|utløses\s+av)\b/giu),
        );
        const lastBinding = bindingMatches.at(-1);
        if (!lastBinding) {
          return false;
        }
        let bindingPrefix = normalizePageText(
          bindingSpan.slice(0, lastBinding.index),
        );
        bindingPrefix = bindingPrefix
          .replace(
            new RegExp(NOTIFICATION_CHANNEL_BINDING_PATTERN.source, "giu"),
            " ",
          )
          .replace(/\b(?:og|eller|samt|direkte)\b|[,/()\[\]{}:+-]/giu, " ");
        if (/[\p{L}\p{N}]/u.test(bindingPrefix)) {
          return false;
        }
        let boundObject = normalizePageText(bindingSpan.slice(
          lastBinding.index + lastBinding[0].length,
        ));
        for (const knownTrigger of NOTIFICATION_TRIGGER_PATTERNS) {
          boundObject = boundObject.replace(
            new RegExp(knownTrigger.source, "giu"),
            " ",
          );
        }
        boundObject = boundObject.replace(
          /\b(?:og|eller|samt|både|henholdsvis)\b|[,/()\[\]{}:+-]/giu,
          " ",
        );
        return !/[\p{L}\p{N}]/u.test(boundObject);
      }
      const bindingSpan = clause.slice(triggerStart, signalEnd);
      return (
        /\b(?:utløser|genererer|sender|gir|fører\s+til)\b/iu.test(bindingSpan) &&
        !/\b(?:utløser|genererer|sender|gir|fører\s+til)\s+ikke\b/iu.test(
          bindingSpan,
        )
      );
    }),
  );
}

function hasMultipleConcreteNotificationTriggers(answer: string) {
  const committedClauses = committedNotificationClauses(answer);
  const committedTriggers = NOTIFICATION_TRIGGER_PATTERNS.filter((trigger) =>
    committedClauses.some((clause) => triggerIsBoundToNotification(clause, trigger)),
  );
  return committedTriggers.length >= 2;
}

function hasConcreteNotificationDeliveryChannel(answer: string) {
  return committedNotificationClauses(answer).some(
    (clause) =>
      NOTIFICATION_CHANNEL_PATTERN.test(clause) &&
      NOTIFICATION_CHANNEL_BINDING_PATTERN.test(clause) &&
      !hasNoncommittalNotificationOrAccessControl(clause) &&
      !explicitlyNegatesRequiredSignal(clause, [NOTIFICATION_CHANNEL_PATTERN]),
  );
}

function splitRoleMappingFragments(clause: string) {
  return clause
    .split(
      /,\s*(?=(?:(?:mens|men|og)\s+)?(?:frivillig(?:e)?|koordinator(?:er)?|mottaker(?:e)?|pårørende)\b)|\b(?:mens|derimot)\b/iu,
    )
    .map((fragment) => fragment.trim())
    .filter(Boolean);
}

function bridgeContainsOnlyCoordinatedRoles(
  bridge: string,
  allowedPredicateWords: string[] = [],
) {
  if (/[:;]/u.test(bridge)) {
    return false;
  }
  let residual = normalizePageText(bridge);
  for (const role of NOTIFICATION_RECIPIENT_ROLES) {
    residual = residual.replace(
      new RegExp(role.pattern.source, "giu"),
      " ",
    );
  }
  const allowedWords = [
    "og",
    "samt",
    "både",
    "eller",
    "henholdsvis",
    "bruker",
    "brukere",
    "rolle",
    "roller",
    "gruppe",
    "grupper",
    ...allowedPredicateWords,
  ];
  residual = residual.replace(
    new RegExp(`\\b(?:${allowedWords.join("|")})\\b`, "giu"),
    " ",
  );
  return !/[\p{L}\p{N}]/u.test(residual);
}

function hasNotificationRecipientMapping(answer: string) {
  const mappedRoles = new Set<string>();
  for (const clause of committedNotificationClauses(answer)) {
    for (const fragment of splitRoleMappingFragments(clause)) {
      for (const role of NOTIFICATION_RECIPIENT_ROLES) {
        const roleMatches = Array.from(
          fragment.matchAll(new RegExp(role.pattern.source, "giu")),
        );
        for (const roleMatch of roleMatches) {
          const roleStart = roleMatch.index;
          const roleEnd = roleStart + roleMatch[0].length;
          const tail = fragment.slice(roleEnd, roleEnd + 180);
          const action = tail.match(/\b(?:får|mottar|varsles)\b/iu);
          let directMapping = false;
          if (
            action?.index !== undefined &&
            bridgeContainsOnlyCoordinatedRoles(tail.slice(0, action.index))
          ) {
            const actionTail = tail.slice(action.index);
            const signal = actionTail.match(NOTIFICATION_SIGNAL_PATTERN);
            if (signal?.index !== undefined) {
              const signalBridge = actionTail.slice(
                action[0].length,
                signal.index,
              );
              const residualSignalBridge = normalizePageText(signalBridge).replace(
                /\b(?:automatisk(?:e)?|konkret(?:e)?|følgende|disse|relevante)\b/giu,
                " ",
              );
              const signalTail = actionTail.slice(signal.index);
              directMapping =
                !/[\p{L}\p{N}]/u.test(residualSignalBridge) &&
                new RegExp(
                  `^${NOTIFICATION_SIGNAL_PATTERN.source}.{0,35}\\b(?:om|ved|for)\\b.{0,70}${NOTIFICATION_TOPIC_PATTERN.source}`,
                  "iu",
                ).test(signalTail);
            }
          }
          const prefix = fragment.slice(Math.max(0, roleStart - 190), roleStart);
          const reverseMapping = new RegExp(
            `${NOTIFICATION_SIGNAL_PATTERN.source}.{0,35}\\b(?:om|ved|for)\\b.{0,70}${NOTIFICATION_TOPIC_PATTERN.source}.{0,60}\\b(?:sendes|leveres|vises)\\s+til\\s*$`,
            "iu",
          ).test(prefix);
          if (directMapping || reverseMapping) {
            mappedRoles.add(role.key);
          }
        }
      }
    }
  }
  return mappedRoles.size >= 2;
}

function concreteAccessScopeForRole(clause: string, role: RegExp) {
  const roleMatches = Array.from(
    clause.matchAll(new RegExp(role.source, "giu")),
  );
  return roleMatches.some((roleMatch) => {
    const roleEnd = roleMatch.index + roleMatch[0].length;
    const tail = clause.slice(roleEnd, roleEnd + 190);
    const restriction = tail.match(/\b(?:bare|kun)\b/iu);
    if (restriction?.index === undefined) {
      return false;
    }
    const subjectBridge = tail.slice(0, restriction.index);
    const accessPredicate = subjectBridge.match(
      /\b(?:kan|ser|se|leser|lese|behandler|behandle|endrer|endre|får|har)\b/iu,
    );
    const accessPredicateEnd =
      accessPredicate?.index === undefined
        ? null
        : accessPredicate.index + accessPredicate[0].length;
    if (
      accessPredicateEnd !== null &&
      NOTIFICATION_RECIPIENT_ROLES.some((candidate) =>
        candidate.pattern.test(
          subjectBridge.slice(accessPredicateEnd),
        ),
      )
    ) {
      return false;
    }
    if (
      !bridgeContainsOnlyCoordinatedRoles(subjectBridge, [
        "kan",
        "ser",
        "se",
        "leser",
        "lese",
        "behandler",
        "behandle",
        "endrer",
        "endre",
        "får",
        "har",
      ])
    ) {
      return false;
    }
    const scopedTail = tail.slice(restriction.index, restriction.index + 145);
    const qualifier = scopedTail.match(
      /\b(?:egne|tildelte|autoriserte|nødvendige|forvaltede|sakene|oppdragene|avtalene|dataene|opplysningene|feltene|objektene|meldingene)\b/iu,
    );
    if (qualifier?.index === undefined) {
      return false;
    }
    const restrictionPrefix = scopedTail.slice(
      restriction[0].length,
      qualifier.index,
    );
    if (
      NOTIFICATION_RECIPIENT_ROLES.some((candidate) =>
        candidate.pattern.test(restrictionPrefix),
      )
    ) {
      return false;
    }
    return /\b(?:bare|kun)\b.{0,60}\b(?:egne|tildelte|autoriserte|nødvendige|forvaltede)\b.{0,50}\b(?:oppdrag|saker|avtaler|data|opplysninger|felt|objekter|funksjoner|samtykkeopplysninger|meldinger)\b|\b(?:bare|kun)\b.{0,45}\b(?:sakene|oppdragene|avtalene|dataene|opplysningene|feltene|objektene|meldingene)\b.{0,45}\b(?:de\s+)?(?:forvalter|følger\s+opp|trenger|er\s+tildelt)\b/iu.test(
      scopedTail,
    );
  });
}

function hasConcreteScopeForEveryNamedAccessRole(
  answer: string,
  requirement: string,
) {
  const requiredRoles = NOTIFICATION_RECIPIENT_ROLES.filter((role) =>
    role.pattern.test(requirement),
  );
  if (requiredRoles.length === 0) {
    return false;
  }
  const accessClauses = architectureCommitmentClauses(answer).filter(
    (clause) =>
      ACCESS_SIGNAL_PATTERN.test(clause) &&
      !hasNoncommittalNotificationOrAccessControl(clause),
  );
  return requiredRoles.every((role) =>
    accessClauses.some((clause) =>
      concreteAccessScopeForRole(clause, role.pattern),
    ),
  );
}

function hasConcreteDataValidationControl(answer: string) {
  return /\b(?:obligatoriske? felt|formatkontroll|valideringsregel|avvis(?:es|er)|flagg(?:es|er))\b/i.test(
    answer,
  );
}

function hasAccessRoleAndLeastPrivilege(answer: string) {
  return (
    /(?:rollebasert|rollemodell|tilgangsmatrise)/i.test(answer) &&
    /minste\s+privilegium/i.test(answer)
  );
}

function hasExplicitAccessDataScope(answer: string) {
  return /(?:dataavgrens|datatyper?|felt-?\s*eller\s*objektnivå|feltnivå|objektnivå|bare\s+nødvendige\s+(?:data|opplysninger)|(?:data|opplysninger|funksjoner).{0,80}avgrenset\s+til\s+(?:deres\s+)?(?:oppgaver|behov|roller?)|(?:hver\s+)?(?:rolle|brukergruppe)\s+(?:bare|kun)\s+(?:kan\s+)?(?:se(?:\s+og\s+behandle)?|behandle|får\s+tilgang\s+til).{0,50}(?:data|opplysninger|funksjoner).{0,100}(?:(?:den|de)\s+trenger\s+for\s+(?:(?:sine|deres)\s+)?(?:oppgaver|behov)|(?:for|til)\s+(?:(?:sine|deres)\s+)?(?:oppgaver|behov))|(?:frivillige|koordinatorer|mottakere|pårørende|brukerne).{0,180}(?:bare|kun)\s+(?:kan\s+)?(?:se(?:\s+og\s+behandle)?|behandle|får\s+tilgang\s+til).{0,50}(?:data|opplysninger|funksjoner).{0,100}(?:trenger|nødvendige).{0,50}(?:oppgaver|behov)|(?:frivillige|koordinatorer|mottakere|pårørende|brukere?|roller?).{0,80}(?:bare|kun)\s+(?:kan\s+)?(?:ser|se|behandler|behandle|får\s+tilgang\s+til).{0,80}(?:egne|tildelte|autoriserte|nødvendige).{0,50}(?:oppdrag|avtaler|data|opplysninger|felt|objekter|funksjoner|samtykker|meldinger)|tilgang\s+til.{0,50}(?:data|opplysninger|funksjoner).{0,80}avgrenses\s+(?:etter|til)\s+(?:rolle|oppgave|behov))/i.test(
    answer,
  );
}

function hasPerGroupAccessDataScope(answer: string) {
  return /dataavgrens(?:ning|es)?.{0,60}(?:per|etter|til).{0,30}(?:brukergruppe|rolle|objekt|felt|oppgave|behov)|(?:brukergruppe|rolle).{0,80}(?:bare|kun)\s+(?:kan\s+)?(?:se|behandle|får\s+tilgang\s+til).{0,100}(?:data|opplysninger|felt|objekter|funksjoner).{0,80}(?:trenger|nødvendige|tildelte|autoriserte|oppgaver|behov)/i.test(
    answer,
  );
}

function negatesDataValidationOrAccessControl(answer: string) {
  const text = normalizePageText(answer);
  return (
    /\b(?:ingen|uten)\s+(?:(?:eksplisitt|konkret|egen|en|et)\s+){0,3}(?:datavalidering|valideringskontroll|obligatoriske?\s+felt|formatkontroll|valideringsregel|rollebasert\s+tilgang|rollemodell|minste\s+privilegium|dataavgrensning|logging|revisjonslogg)\b/i.test(
      text,
    ) ||
    /\bikke\s+(?:(?:har|bruker|etablerer|håndhever|benytter|gjennomfører)\s+)?(?:datavalidering|valideringskontroll|rollebasert\s+tilgang|rollemodell|minste\s+privilegium|dataavgrensning|logging|revisjonslogg)\b/i.test(
      text,
    ) ||
    /\b(?:har|bruker|etablerer|håndhever|benytter|gjennomfører)\s+ikke\b.{0,80}\b(?:datavalidering|valideringskontroll|rollebasert\s+tilgang|rollemodell|minste\s+privilegium|dataavgrensning|logging|revisjonslogg)\b/i.test(
      text,
    ) ||
    /\b(?:avviser|flagger|logger|logges)\s+ikke\b/i.test(text) ||
    /\b(?:datavalidering|valideringskontroll|rollebasert\s+tilgang|rollemodell|minste\s+privilegium|dataavgrensning|logging|revisjonslogg)\s+(?:finnes|brukes|etableres|håndheves|gjennomføres|logges|er)\s+ikke\b/i.test(
      text,
    )
  );
}

function negatesPerformanceControl(answer: string) {
  const text = normalizePageText(answer);
  return (
    /\b(?:ingen|uten)\s+(?:(?:eksplisitt|konkret|egen|en|et)\s+){0,3}(?:kapasitetsmodell|kapasitetsbaseline|ytelsesbaseline|volumprofil|lastprofil|lasttest|ytelsestest|belastningstest|skalering|autoskalering|provisjonert\s+kapasitet|reservekapasitet|kapasitetsmargin|akseptansekriterier)\b/i.test(
      text,
    ) ||
    /\bikke\s+(?:(?:har|bruker|etablerer|gjennomfører|utfører|benytter|foreslår)\s+)?(?:kapasitetsmodell|kapasitetsbaseline|ytelsesbaseline|volumprofil|lastprofil|lasttest|ytelsestest|belastningstest|skalering|autoskalering|provisjonert\s+kapasitet|reservekapasitet|kapasitetsmargin|akseptansekriterier)\b/i.test(
      text,
    ) ||
    /\b(?:har|bruker|etablerer|gjennomfører|utfører|benytter|foreslår)\s+ikke\b.{0,80}\b(?:kapasitetsmodell|kapasitetsbaseline|ytelsesbaseline|volumprofil|lastprofil|lasttest|ytelsestest|belastningstest|skalering|autoskalering|provisjonert\s+kapasitet|reservekapasitet|kapasitetsmargin|akseptansekriterier)\b/i.test(
      text,
    ) ||
    /\b(?:kapasitetsmodell|kapasitetsbaseline|ytelsesbaseline|lasttest|ytelsestest|belastningstest|skalering|autoskalering|provisjonert\s+kapasitet|reservekapasitet|kapasitetsmargin|akseptansekriterier)\s+(?:finnes|brukes|etableres|gjennomføres|utføres|foreslås|er)\s+ikke\b/i.test(
      text,
    )
  );
}

export function isResponseTimeAndAccessRequirement(requirement: string) {
  return (
    /måling\s+av\s+responstid/i.test(requirement) &&
    /bare\s+får\s+tilgang/i.test(requirement)
  );
}

export function isNoMaterialSlownessDimensioningRequirement(requirement: string) {
  return /dimensjoneres/i.test(requirement) && /uten.{0,80}vesentlig\s+treghet/i.test(requirement);
}

export function isSeasonalScalabilityClarificationRequirement(requirement: string) {
  return /^Leverandøren må avklare og beskrive hvordan følgende løses:\s*leverandøren skal beskrive hvordan løsningen ivaretar skalerbarhet ved sesongtopper for havneterminal og lasteoperasjoner\.?$/iu.test(
    normalizePageText(requirement),
  );
}

export function isLifecycleTraceabilityDimensioningRequirement(requirement: string) {
  return (
    isNoMaterialSlownessDimensioningRequirement(requirement) &&
    /sporbarhet\s+fra\s+innmelding\s+til\s+avslutning/i.test(requirement)
  );
}

type DimensioningOperationProfile = {
  focus: string;
  operations: [string, string, string];
};

const DIMENSIONING_OPERATION_PROFILES = new Map<string, DimensioningOperationProfile>(
  [
    [
      "robust feilhåndtering ved integrasjonsstans",
      ["registrere handling", "vise køstatus", "starte kontrollert nykjøring"],
    ],
    [
      "skalerbarhet ved sesongtopper",
      ["logge inn", "åpne arbeidsliste", "lagre endring"],
    ],
    [
      "standardisert rapportering til ledelse",
      ["åpne rapport", "endre filter", "starte eksport"],
    ],
    [
      "sporbarhet fra innmelding til avslutning",
      ["registrere innmelding", "oppdatere status", "avslutte saken"],
    ],
    [
      "lav ventetid i kritiske arbeidsprosesser",
      ["åpne arbeidsliste", "registrere endring", "lagre status"],
    ],
    [
      "klar rollefordeling mellom avdelinger",
      ["slå opp rolle", "tildele ansvar", "åpne avdelingsvisning"],
    ],
    [
      "sikker datadeling med eksterne aktører",
      ["opprette deling", "hente delte data", "tilbakekalle tilgang"],
    ],
    [
      "kontroll på tilgangsendringer",
      ["opprette tilgangsendring", "godkjenne endring", "vise oppdatert tilgang"],
    ],
    [
      "konfigurerbare arbeidsflyter",
      ["åpne arbeidsflyt", "endre status", "lagre konfigurasjon"],
    ],
    [
      "tilgjengelighet på mobil og nettbrett",
      ["logge inn", "åpne arbeidsliste", "lagre endring"],
    ],
    [
      "tilgjengelighet for ansatte på mobil og nettbrett",
      ["logge inn", "åpne arbeidsliste", "lagre endring"],
    ],
    [
      "enkel administrasjon uten konsulentbistand",
      ["opprette bruker", "endre regel", "publisere konfigurasjon"],
    ],
    [
      "dokumentert beredskap for driftsavbrudd",
      ["åpne beredskapsstatus", "registrere hendelse", "starte gjenoppretting"],
    ],
  ].map(([focus, operations]) => [
    normalizeComparableText(focus as string),
    {
      focus: focus as string,
      operations: operations as [string, string, string],
    },
  ]),
);

function dimensioningRequirementFocus(requirement: string) {
  if (isSeasonalScalabilityClarificationRequirement(requirement)) {
    return "skalerbarhet ved sesongtopper";
  }
  return (
    requirement.match(
      /\bdimensjoneres\s+for\s+(.+?)\s+uten\s+at\s+brukerne\s+opplever\s+vesentlig\s+treghet\b/i,
    )?.[1]?.trim() ?? ""
  );
}

export function dimensioningOperationProfile(requirement: string) {
  const focus = dimensioningRequirementFocus(requirement);
  return focus
    ? DIMENSIONING_OPERATION_PROFILES.get(normalizeComparableText(focus)) ?? null
    : null;
}

function hasPositiveSourceOptionQualifier(source: string) {
  const pattern =
    /\bkan\s+prises?\s+som\s+opsjon\b|\b(?:priset|prises?)\s+(?:som\s+)?opsjon\b/giu;
  for (const match of source.matchAll(pattern)) {
    const prefix = source.slice(Math.max(0, (match.index ?? 0) - 45), match.index);
    if (!/\b(?:ikke|uten)(?:\s+[\p{L}\p{N}-]+){0,2}\s*$/iu.test(prefix)) {
      return true;
    }
  }
  return false;
}

function dimensioningSourceQualifierFlags(entry: RequirementLedgerEntry) {
  const source = normalizeRequirementLedgerText(
    authoritativeRequirementRowTextWithoutAnswer(entry),
  );
  return {
    option: hasPositiveSourceOptionQualifier(source),
    production:
      /\bgjelder\s+produksjonsløsning(?:en)?\b/i.test(source),
    designPhase: /\bmå\s+avklares\s+i\s+designfas(?:e|en)\b/i.test(source),
    documentation: /\bdokumentasjon\s+ønskes\b/i.test(source),
    solutionProposal: /\bkrever\s+løsningsforslag\b/i.test(source),
    supplierResponse: /\bbesvares\s+av\s+leverandør\b/i.test(source),
    clarification:
      /\bleverandøren\s+må\s+avklare\b/i.test(source),
    assumption: /\bteksten\s+forutsetter\s+at\b/i.test(source),
    needsNote: /\bnotat\s+fra\s+behovsarbeidet\b/i.test(source),
  };
}

export function dimensioningSourceQualifierDirective(entry: RequirementLedgerEntry) {
  const qualifiers = dimensioningSourceQualifierFlags(entry);
  return [
    qualifiers.option
      ? "bevar uttrykkelig at leveransen prises og tilbys som en separat opsjon med tydelig avgrensning fra basisleveransen"
      : "",
    qualifiers.production
      ? "si uttrykkelig at dimensjoneringen gjelder produksjonsløsningen"
      : "",
    qualifiers.designPhase
      ? "bevar designfasekvalifikatoren, men avgrens den til validering av eksakte volum-/lastparametere; kjerneleveransen og et tilbudt måltall skal fortsatt forpliktes nå"
      : "",
    qualifiers.documentation
      ? "forplikt dokumentasjon av lastprofil, testresultat og akseptansekriterier"
      : "",
    qualifiers.solutionProposal
      ? "bind svaret positivt til løsningsforslaget, for eksempel 'I løsningsforslaget dimensjonerer og forplikter Atea ...'"
      : "",
    qualifiers.supplierResponse
      ? "bind svaret positivt til leverandørbesvarelsen, for eksempel 'I leverandørbesvarelsen dimensjonerer og forplikter Atea ...'"
      : "",
    qualifiers.clarification
      ? "bevar leverandøravklaringen og avgrens den til endelig volum-/lastprofil etter at et konkret tilbudt måltall er angitt"
      : "",
    qualifiers.assumption
      ? "bevar kildens uttrykkelige forutsetning og skill den fra kundekrav"
      : "",
    qualifiers.needsNote
      ? "bevar at teksten er et notat fra behovsarbeidet og presenter målet som leverandørens løsningsforutsetning"
      : "",
  ]
    .filter(Boolean)
    .join("; ");
}

const CONFIGURED_SUPPLIER_BASELINE_SOURCE_ACTOR = String.raw`(?:kild(?:e|en|ens)|kund(?:e|en|ens)|krav(?:et|ets)?|bilag(?:et|ets)?|konkurransegrunnlag(?:et|ets)?|oppdragsgiver(?:en|ens|s)?|bestiller(?:en|ens|s)?|anskaffels(?:en|ens)|kontrakt(?:en|ens))`;

function sentenceFalselyAttributesConfiguredSupplierBaseline(sentence: string) {
  const containsConfiguredTarget = extractPerformanceTargets(sentence).some(
    (target) =>
      (target.percentile === "p95" &&
        target.comparator === "max" &&
        target.value === "2" &&
        target.unit === "s") ||
      (target.percentile === undefined &&
        target.comparator === undefined &&
        target.value === "200" &&
        target.unit === "users"),
  );
  const containsConfiguredTargetReference =
    /\b(?:(?:dette|det|denne|disse(?:\s+to)?|de\s+(?:to|nevnte)|begge|ovennevnte)\s+)(?:responstidsmål(?:et|ene)?|ytelsesmål(?:et|ene)?|lastprofil(?:en|ene)?|mål(?:et|ene)?|verdi(?:en|ene)?|parameter(?:en|ne)?|tall(?:et|ene)?)\b/i.test(
      sentence,
    ) ||
    /\b(?:responstidsmålet|ytelsesmålet|lastprofilen|målene|verdiene|parameterne|tallene)\b/i.test(
      sentence,
    );
  if (!containsConfiguredTarget && !containsConfiguredTargetReference) {
    return false;
  }

  const withoutExplicitSourceDenial = sentence
    .replace(
      new RegExp(
        String.raw`\bikke\s+(?:et\s+)?(?:kunde|kilde)?krav\s+(?:fra|i)\s+${CONFIGURED_SUPPLIER_BASELINE_SOURCE_ACTOR}\b`,
        "giu",
      ),
      "",
    )
    .replace(
      new RegExp(
        String.raw`\b(?:er|var|ble|som)\s+ikke\s+(?:angitt|oppgitt|krevd|fastsatt|spesifisert|definert|beskrevet|nevnt|omtalt|presisert)\s+(?:av|i|fra)\s+${CONFIGURED_SUPPLIER_BASELINE_SOURCE_ACTOR}\b`,
        "giu",
      ),
      "",
    )
    .replace(
      new RegExp(
        String.raw`\b(?:fremgår|står|følger)\s+ikke\s+(?:av|i|fra)\s+${CONFIGURED_SUPPLIER_BASELINE_SOURCE_ACTOR}\b`,
        "giu",
      ),
      "",
    )
    .replace(
      new RegExp(
        String.raw`\b${CONFIGURED_SUPPLIER_BASELINE_SOURCE_ACTOR}\s+(?:angir|oppgir|krever|fastsetter|spesifiserer|definerer|beskriver|nevner|omtaler|presiserer)\s+ikke\b[^.!?;]{0,80}\b(?:responstidsmål(?:et|ene)?|ytelsesmål(?:et|ene)?|lastprofil(?:en|ene)?|mål(?:et|ene)?|verdi(?:en|ene)?|parameter(?:en|ne)?|tall(?:et|ene)?)\b`,
        "giu",
      ),
      "",
    );

  return new RegExp(
    String.raw`\b${CONFIGURED_SUPPLIER_BASELINE_SOURCE_ACTOR}\b`,
    "iu",
  ).test(withoutExplicitSourceDenial);
}

function hasSupplierProposedNumericPerformanceTarget(answer: string) {
  const falselyAttributesConfiguredBaseline = splitIntoSentences(answer).some(
    sentenceFalselyAttributesConfiguredSupplierBaseline,
  );
  const hasBoundBaselineSentence = splitIntoSentences(answer).some(
    (sentence) =>
      /\bAteas?\s+tilbudte\s+responstidsmål\b/i.test(sentence) &&
      /\bp95\b[^.!?]{0,30}\bunder\s+2(?:[,.]0)?\s+sekunder?\b/i.test(
        sentence,
      ) &&
      /\b(?:de\s+samme|hver\s+av\s+de\s+tre)\s+(?:(?:bruker)?transaksjon(?:ene)?|operasjon(?:ene)?)\b/i.test(
        sentence,
      ) &&
      /\b(?:antatt\s+lastprofil\s+på\s+)?200\s+samtidige\s+brukere\b/i.test(
        sentence,
      ) &&
      /\b(?:leverandørforutsetning|leverandørens?\s+(?:tilbud|forutsetning))\b/i.test(
        sentence,
      ) &&
      /\bakseptansekriter\w*\b/i.test(sentence) &&
      !sentenceFalselyAttributesConfiguredSupplierBaseline(sentence),
  );
  const targets = extractPerformanceTargets(answer);
  const exactConfiguredTargets =
    targets.length === 2 &&
    targets.some(
      (target) =>
        target.percentile === "p95" &&
        target.comparator === "max" &&
        target.value === "2" &&
        target.unit === "s",
    ) &&
    targets.some(
      (target) =>
        target.percentile === undefined &&
        target.comparator === undefined &&
        target.value === "200" &&
        target.unit === "users",
    );
  return (
    !falselyAttributesConfiguredBaseline &&
    hasBoundBaselineSentence &&
    exactConfiguredTargets
  );
}

function hasConcreteLifecycleTransactionNames(answer: string) {
  const transactionActions =
    answer.match(
      /\b(?:registrere|opprette|sende|motta|oppdatere|endre|vise|hente|godkjenne|tildele|behandle|lukke|avslutte)\w*\s+(?:en\s+|et\s+|den\s+|det\s+)?[\p{L}\p{N}-]+/giu,
    ) ?? [];
  return (
    /\b(?:brukertransaksjon|transaksjon)\w*\b/i.test(answer) &&
    new Set(transactionActions.map((value) => normalizeComparableText(value))).size >= 3
  );
}

const DIMENSIONING_FOCUS_STOP_WORDS = new Set([
  "av",
  "at",
  "for",
  "fra",
  "i",
  "med",
  "mellom",
  "og",
  "på",
  "til",
  "uten",
  "ved",
]);

function dimensioningSourceFocusTokens(requirement: string) {
  const focus = dimensioningRequirementFocus(requirement);
  if (!focus) {
    return [];
  }
  return Array.from(
    new Set(
      tokenizeComparableText(focus).filter(
        (token) => token.length >= 4 && !DIMENSIONING_FOCUS_STOP_WORDS.has(token),
      ),
    ),
  );
}

function answerBindsDimensioningSourceFocus(
  answer: string,
  requirement: string,
) {
  const focusTokens = dimensioningSourceFocusTokens(requirement);
  const operationProfile = dimensioningOperationProfile(requirement);
  if (!focusTokens.length) {
    return false;
  }
  return splitIntoSentences(answer).some((sentence) => {
    const sentenceTokens = new Set(tokenizeComparableText(sentence));
    const comparableSentence = normalizeComparableText(sentence);
    const matched = focusTokens.filter((token) => sentenceTokens.has(token));
    return (
      matched.length >= Math.min(2, focusTokens.length) &&
      (!operationProfile ||
        operationProfile.operations.every((operation) =>
          comparableSentence.includes(normalizeComparableText(operation)),
        )) &&
      /\b(?:kapasitetsmodell|kapasitetsbaseline|ytelsesbaseline)\b/i.test(
        sentence,
      ) &&
      /\b(?:lasttest|ytelsestest|belastningstest)\b/i.test(sentence) &&
      /\b(?:skalering|autoskalering|provisjonert\s+kapasitet|dimensjonert\s+kapasitet)\b/i.test(
        sentence,
      ) &&
      /\b(?:reservekapasitet|kapasitetsmargin|headroom)\b/i.test(sentence)
    );
  });
}

function hasPositiveDimensioningQualifierBinding(
  answer: string,
  qualifier: RegExp,
  commitment: RegExp,
) {
  const qualifierSignal = new RegExp(
    qualifier.source,
    qualifier.flags.replaceAll("g", ""),
  );
  const commitmentSignal = new RegExp(
    commitment.source,
    commitment.flags.replaceAll("g", ""),
  );
  const sentences = splitIntoSentences(answer);
  const contradictsQualifier = sentences.some((sentence) => {
    if (!qualifierSignal.test(sentence)) return false;
    const explicitNegation = /\b(?:ikke|ingen|aldri|verken|hverken)\b/i.test(
      sentence,
    );
    const withoutScopes = sentence.match(/\buten\b[^,.!?;]{0,50}/gi) ?? [];
    return (
      explicitNegation ||
      withoutScopes.some((scope) => qualifierSignal.test(scope))
    );
  });
  return (
    !contradictsQualifier &&
    sentences.some(
      (sentence) =>
        qualifierSignal.test(sentence) && commitmentSignal.test(sentence),
    )
  );
}

export function isStructuredExportPortabilityRequirement(requirement: string) {
  return (
    /\b(?:hent(?:e|es)\s+ut|(?:data)?uttrekk|eksport(?:ere|eres|ert|ering)?)\b/i.test(
      requirement,
    ) &&
    /\b(?:strukturert(?:e)?|maskinlesbar(?:t|e)?)\s+(?:data\s*)?format(?:er)?\b/i.test(
      requirement,
    ) &&
    /\b(?:revisjon|leverandør(?:bytte|skifte))\b/i.test(requirement)
  );
}

function hasConcreteMachineReadableExportFormat(answer: string) {
  const format =
    String.raw`(?:CSV|JSON|XML|NDJSON|JSONL|JSON\s+Lines|Parquet|XLSX|TSV|YAML|Avro|ORC|ODS|Apache\s+Arrow)`;
  const exportSubject =
    String.raw`(?:hent(?:e|es)\s+ut|(?:data)?uttrekk(?:et|ene)?|eksport(?:en|ere|erer|eres|ert|ering)?)`;
  const exportBeforeFormat = new RegExp(
    String.raw`\b${exportSubject}\b[^.!?]{0,160}\b(?:som|til|i)\s+(?:formatet\s+)?\b${format}\b`,
    "i",
  );
  const namedExportFormat = new RegExp(
    String.raw`\b(?:uttrekksformat(?:et)?|eksportformat(?:et)?)\b[^.!?]{0,40}(?:\ber\b|\bblir\b|:)\s*\b${format}\b`,
    "i",
  );
  const formatForExport = new RegExp(
    String.raw`\bformat(?:et)?\s+for\s+(?:(?:data)?uttrekk(?:et|ene)?|eksport(?:en)?)\s+(?:er|blir)\s+\b${format}\b`,
    "i",
  );
  const formatBeforeExplicitExport = new RegExp(
    String.raw`\b${format}\b(?:\s*-\s*(?:uttrekk|eksport)|[^.!?]{0,40}\b(?:(?:brukes|benyttes|leveres)\s+som|(?:er|blir))\s+(?:uttrekksformat(?:et)?|eksportformat(?:et)?))\b`,
    "i",
  );
  const portableDataDelivery = new RegExp(
    String.raw`\b(?:leverer|leveres)\b[^.!?]{0,100}\b(?:data|dataomfang|oppdrag|frivillige|samtykker|meldinger)\b[^.!?]{0,100}\b(?:som|til|i)\s+\b${format}\b`,
    "i",
  );

  return splitIntoSentences(answer).some((sentence) => {
    const clauses = sentence.split(
      /;\s*|,\s*(?=(?:mens|men|derimot|samtidig)\b)/i,
    );
    const hasSafePortableDataDelivery = clauses.some(
      (clause) =>
        !/\bAPI\b/i.test(clause) &&
        /\b(?:revisjon|leverandør(?:bytte|skifte))\b/i.test(clause) &&
        portableDataDelivery.test(clause),
    );

    return (
      exportBeforeFormat.test(sentence) ||
      namedExportFormat.test(sentence) ||
      formatForExport.test(sentence) ||
      formatBeforeExplicitExport.test(sentence) ||
      hasSafePortableDataDelivery
    );
  });
}

function answerWithoutSourcePriorityLabels(value: string) {
  return value.replace(
    /\bprioritet\s*(?::|er)?\s*[«"]?\s*(?:må|bør|kan)\b\s*[»"]?/giu,
    "",
  );
}

function explicitlyNegatesRequiredSignal(
  value: string,
  requiredSignals: RegExp[],
) {
  const clauses = normalizePageText(answerWithoutSourcePriorityLabels(value))
    .split(/[.!?;\n]+|\b(?:men|mens|derimot)\b/i)
    .map((clause) => clause.trim())
    .filter(Boolean);
  const explicitNegation =
    /\b(?:ikke|ingen|intet|uten|aldri|mangler|unnlater|utelat\w*|verken|hverken|valgfri\w*|opsjon\w*|tilvalg|kan|kunne|vil|ved\s+behov|dersom(?:\s+tilgjengelig)?|hvis|forutsatt|planlegg\w*|senere|forvent\w*\s+å|som\s+hovedregel|så\s+langt[^.!?]{0,60}\bmulig|tar\s+sikte\s+på|tilstreber|not|no|never|without|optional|may|might)\b/i;
  return clauses.some((clause) => {
    const polarityClause = clause.replace(/\bgo\/?no-go\b/gi, "");
    return (
      (explicitNegation.test(polarityClause) ||
        hasWeakNonbindingLanguage(polarityClause)) &&
      requiredSignals.some((signal) => signal.test(polarityClause))
    );
  });
}

function hasWeakNonbindingLanguage(value: string) {
  return /(?:^|\s)(?:forvent\w*\s+å|tar\s+sikte\s+på)(?=\s|$)|\b(?:anticipated|expected)\s+to\b/i.test(
    value,
  );
}

export function realtimeCoordinationRequirementProfile(requirement: string) {
  const match =
    /^(?:Leverandøren må avklare og beskrive hvordan følgende løses:\s*)?løsningen skal støtte (avviksbehandling|selvbetjening) for å gjennomføre sanntids koordinering av ([^.!?;:]+) på en kontrollert og sporbar måte\.?$/iu.exec(
      normalizePageText(requirement),
    );
  const objects = (match?.[2] ?? "")
    .split(/\s*,\s*|\s+(?:og|samt)\s+/iu)
    .map((value) => value.trim())
    .filter(Boolean);
  if (
    !match?.[1] ||
    objects.length < 2 ||
    objects.length > 6 ||
    objects.some(
      (value) =>
        value.length > 48 ||
        !/^[\p{L}][\p{L}-]*(?:\s+[\p{L}][\p{L}-]*){0,2}$/u.test(value),
    )
  ) {
    return null;
  }
  return {
    capability: match[1].toLocaleLowerCase("nb") as
      | "avviksbehandling"
      | "selvbetjening",
    objects,
  };
}

function answerBindsEveryRealtimeCoordinationObject(
  answer: string,
  objects: string[],
) {
  const comparableAnswer = normalizeComparableText(answer);
  return objects.every((object) =>
    comparableAnswer.includes(normalizeComparableText(object)),
  );
}

export function isTimedReminderControlRequirement(requirement: string) {
  return (
    /\btidsstyrte?\s+påminnelser?\b/i.test(requirement) &&
    /\bkontrollert\b/i.test(requirement) &&
    /\bsporbar/i.test(requirement)
  );
}

const TIMED_REMINDER_SOURCE_STOP_WORDS = new Set([
  "kontrollert",
  "koordinering",
  "losning",
  "losningen",
  "mate",
  "paminnelse",
  "paminnelser",
  "sanntids",
  "skal",
  "sporbar",
  "stotte",
  "tidsstyrt",
  "tidsstyrte",
  "gjennomfore",
]);

function timedReminderSourceObjectTokens(requirement: string) {
  return Array.from(
    new Set(
      tokenizeComparableText(requirement).filter(
        (token) =>
          token.length >= 5 &&
          !TIMED_REMINDER_SOURCE_STOP_WORDS.has(
            token.normalize("NFKD").replace(/[\u0300-\u036f]/g, ""),
          ) &&
          !DIMENSIONING_FOCUS_STOP_WORDS.has(token),
      ),
    ),
  ).slice(0, 10);
}

export function hasCompleteTimedReminderControl(answer: string, requirement = "") {
  const hasRuleOrTrigger =
    /\b(?:påminnelsesregel\w*|regel|trigger|utløses\s+(?:av|ved)|statusendring|hendelse)\b/i.test(
      answer,
    );
  const hasTimeControl =
    /\b(?:tidspunkt|frist|intervall|tidsplan|planlagt\s+tid|tidsvindu)\b/i.test(
      answer,
    );
  const sourceObjectTokens = timedReminderSourceObjectTokens(requirement);
  const answerTokens = new Set(tokenizeComparableText(answer));
  const sourceObjectBinding =
    sourceObjectTokens.length > 0 &&
    sourceObjectTokens.filter((token) => answerTokens.has(token)).length >=
      Math.min(2, sourceObjectTokens.length);
  const hasRelevantObjects = sourceObjectTokens.length
    ? sourceObjectBinding
    : /\b(?:oppdrag|frivillig|samtykk|melding|varsel|sak|aktivitet)\w*\b/i.test(
        answer,
      );
  const hasRecipients =
    /\b(?:rolle|mottaker|koordinator|frivillig|ansvarlig|brukergruppe)\w*\b/i.test(
      answer,
    );
  const logsDeliveryAndStatus =
    /\b(?:utsendelse|sendt|levering|påminnelse)\w*\b/i.test(answer) &&
    /\bstatus\w*\b/i.test(answer) &&
    /\blogg\w*\b/i.test(answer);
  const handlesMissingResponseOrDeviation =
    /\b(?:manglende|uteblitt|ingen)\s+(?:respons|svar|kvittering)|\bavvik\w*\b/i.test(
      answer,
    );
  const hasEscalation = /\beskaler\w*\b/i.test(answer);
  const contradictsRequiredSignal = explicitlyNegatesRequiredSignal(answer, [
    /\b(?:påminnelsesregel\w*|regel|trigger)\b/i,
    /\b(?:tidspunkt|frist|intervall|tidsplan|tidsvindu)\b/i,
    /\b(?:rolle|mottaker|koordinator|frivillig|ansvarlig|brukergruppe)\w*\b/i,
    /\b(?:utsendelse|levering|status|logg\w*)\b/i,
    /\b(?:manglende|uteblitt|ingen)\s+(?:respons|svar|kvittering)|\bavvik\w*\b/i,
    /\beskaler\w*\b/i,
  ]);

  return (
    !contradictsRequiredSignal &&
    hasRuleOrTrigger &&
    hasTimeControl &&
    hasRelevantObjects &&
    hasRecipients &&
    logsDeliveryAndStatus &&
    handlesMissingResponseOrDeviation &&
    hasEscalation
  );
}

export function isHistoricalMigrationValidationRequirement(requirement: string) {
  return (
    /\bhistorisk\w*\b/i.test(requirement) &&
    /\bmigrer\w*\b/i.test(requirement) &&
    /\bvalider\w*\b/i.test(requirement) &&
    /\bavviksrapport\w*\b/i.test(requirement) &&
    /\bfør\s+produksjonssetting\b/i.test(requirement)
  );
}

export function hasCompleteHistoricalMigrationValidation(answer: string) {
  return (
    !explicitlyNegatesRequiredSignal(answer, [
      /\b(?:feltmapping|datamapping|mapping\s+av\s+felt)\b/i,
      /\b(?:testmigrering|testlast|prøvelast|testkjøring)\b/i,
      /\bvalider\w*\b/i,
      /\bavviksrapport\w*\b/i,
      /\b(?:korriger\w*|retting|utbedr\w*)\b/i,
      /\b(?:retest\w*|testes?\s+på\s+nytt|ny\s+test)\b/i,
      /\b(?:godkjen\w*|go\/?no-go)\b/i,
    ]) &&
    /\b(?:feltmapping|datamapping|mapping\s+av\s+felt)\b/i.test(answer) &&
    /\b(?:testmigrering|testlast|prøvelast|testkjøring)\b/i.test(answer) &&
    /\bvalider\w*\b/i.test(answer) &&
    /\bavviksrapport\w*\b/i.test(answer) &&
    /\b(?:korriger\w*|retting|utbedr\w*)\b/i.test(answer) &&
    /\b(?:retest\w*|testes?\s+på\s+nytt|ny\s+test)\b/i.test(answer) &&
    /\b(?:godkjen\w*|go\/?no-go)\b/i.test(answer)
  );
}

function defersHistoricalMigrationCore(answer: string) {
  return splitIntoSentences(answer).some(
    (sentence) =>
      /\b(?:feltmapping|datamapping|(?:felt|data)?mapping|datakvalitetsavvik)\w*\b/i.test(
        sentence,
      ) &&
      /\b(?:avklar\w*|fastsett\w*|definer\w*|beslutt\w*|bestem\w*|velg\w*)\b/i.test(
        sentence,
      ),
  );
}

export function isAuditChangeLogRequirement(requirement: string) {
  return (
    /\bendring\w*\b/i.test(requirement) &&
    /\blogg\w*\b/i.test(requirement) &&
    /\bbruker\b/i.test(requirement) &&
    /\btidspunkt\b/i.test(requirement) &&
    /\bgammel\s+verdi\b/i.test(requirement) &&
    /\bny\s+verdi\b/i.test(requirement)
  );
}

export function hasCompleteAuditChangeLog(answer: string) {
  return (
    !explicitlyNegatesRequiredSignal(answer, [
      /\b(?:bruker(?:identitet)?|tjenesteidentitet)\b/i,
      /\btidspunkt\b/i,
      /\bgammel\s+verdi\b/i,
      /\bny\s+verdi\b/i,
      /\b(?:audit)?logg\w*\b/i,
    ]) &&
    /\b(?:bruker(?:identitet)?|tjenesteidentitet)\b/i.test(answer) &&
    /\btidspunkt\b/i.test(answer) &&
    /\bgammel\s+verdi\b/i.test(answer) &&
    /\bny\s+verdi\b/i.test(answer)
  );
}

export function isBackupRestoreVerificationRequirement(requirement: string) {
  const hasBackup = /\b(?:backup|sikkerhetskopi)\b/i.test(requirement);
  const hasRestore = /\b(?:gjenoppretting|restore)\b/i.test(requirement);
  const hasBoundVerification =
    /\b(?:gjenoppretting|restore)\b[^.!?]{0,100}\b(?:verifikasjon|verifiser\w*|valider\w*|validering|kontroll\w*)\b|\b(?:verifikasjon|verifiser\w*|valider\w*|validering|kontroll\w*)\b[^.!?]{0,100}\b(?:gjenoppretting|restore)\b/i.test(
      requirement,
    );
  const hasBoundRestoreTest =
    /\b(?:restore-?test|gjenopprettingstest|testing\s+av\s+(?:restore|gjenoppretting)|test(?:er|es)?\s+(?:av\s+)?(?:restore|gjenoppretting))\w*\b/i.test(
      requirement,
    );
  return hasBackup && hasRestore && (hasBoundVerification || hasBoundRestoreTest);
}

export function hasCompleteBackupRestoreVerification(answer: string) {
  const semanticAnswer = answerWithoutSourcePriorityLabels(answer);
  const controlClauses = normalizePageText(semanticAnswer)
    .split(/[.!?;\n]+|\b(?:men|mens|derimot)\b/i)
    .map((clause) => clause.trim())
    .filter(Boolean);
  const controlClauseWindows = controlClauses.map((_, index) =>
    controlClauses.slice(index, index + 2).join(". "),
  );
  const referencesUnrelatedControlDomain = (value: string) =>
    /\b(?:eksport\w*|rapporterings\w*|integrasjons\w*|deploy\w*|utrulling\w*|dashbord\w*|dashboard\w*|brukergrensesnitt\w*|frontend\w*|UI)\b/i.test(
      value,
    );
  const hasBackupRoutine =
    /\b(?:backup|sikkerhetskopi)\b/i.test(semanticAnswer) &&
    /\b(?:rutine|runbook|plan|jobb|prosess)\w*\b/i.test(semanticAnswer);
  const hasControlledRestore =
    /\bkontrollert\s+(?:gjenoppretting|restore)\b|\b(?:gjenoppretting|restore)(?:sprosess|-prosess)\b/i.test(
      semanticAnswer,
    );
  const hasBackupProductionScope = controlClauses.some(
    (clause) =>
      !referencesUnrelatedControlDomain(clause) &&
      /\b(?:rutine|runbook|plan|jobb|prosess)\w*\b/i.test(clause) &&
      /\b(?:backup-?rutine|sikkerhetskopi(?:erings)?rutine|backup\s+av)\b[^.!?;]{0,60}\b(?:for\s+)?(?:produksjonsdata(?:ene)?|produksjonsløsning(?:en)?|produksjonsmiljø(?:et)?)\b|\b(?:produksjonsdata(?:ene)?|produksjonsløsning(?:en)?|produksjonsmiljø(?:et)?)\b[^.!?;]{0,60}\b(?:backup-?rutine|sikkerhetskopi(?:erings)?rutine|backup\s+av)\b/i.test(
        clause,
      ),
  );
  const hasRestoreTest =
    /\b(?:restore-?test|gjenopprettingstest|test(?:er|es)?\s+(?:av\s+)?(?:restore|gjenoppretting))\w*\b/i.test(
      semanticAnswer,
    );
  const hasBackupOperationalOwnership = controlClauses.some(
    (clause) =>
      !referencesUnrelatedControlDomain(clause) &&
      /\b(?:backup-?rutine|sikkerhetskopi(?:erings)?rutine|backup\s+av)\b[^.!?;]{0,180}\bmed\s+(?:en\s+)?(?:ansvarlig\s+driftsrolle|driftsansvarlig|driftseier|(?:navngitt|definert|utpekt)\s+(?:drifts)?ansvar(?:lig)?)\b/i.test(
        clause,
      ) &&
      /\bjobbkontroll\b/i.test(clause) &&
      /\bavviksvarsling\b/i.test(clause),
  );
  const hasRestoreIntegrityEvidence = controlClauseWindows.some(
    (window) =>
      !referencesUnrelatedControlDomain(window) &&
      /\b(?:restore|gjenoppretting)(?:-?test\w*)?\b/i.test(window) &&
      /\b(?:dataintegritet|integritetsverifikasjon|verifikasjon\s+av\s+(?:data)?integritet)\b[^.!?;]{0,80}\bverifiser\w*\b[^.!?;]{0,40}\bmed\s+(?:kontrollsummer?|sjekksummer?)\b[^.!?;]{0,60}\b(?:og\s+)?objekttelling(?:er)?\b/i.test(
        window,
      ),
  );
  const hasRestoreTestFollowup = controlClauseWindows.some(
    (window) =>
      !referencesUnrelatedControlDomain(window) &&
      /\b(?:restore-?test|gjenopprettingstest|test(?:er|es)?\s+(?:av\s+)?(?:restore|gjenoppretting))\w*\b/i.test(
        window,
      ) &&
      /\bavvik\w*\b/i.test(window) &&
      /\blogg\w*\b/i.test(window) &&
      /\b(?:korrigerende\s+tiltak|korriger\w*|utbedr\w*)\b/i.test(
        window,
      ) &&
      (/\bretest\w*\b/i.test(window) ||
        /\btestes?\s+på\s+nytt\b/i.test(window) ||
        /\b(?:restore|gjenoppretting)(?:s)?testen?\s+(?:kjøres|testes)\s+på\s+nytt\b/i.test(
          window,
        )) &&
      !/\b(?:bare|kun)\b/i.test(window) &&
      !(
        /\bretest\w*\b\s+av\s+/iu.test(window) &&
        !/\bretest\w*\b\s+av\s+[^.!?;]{0,60}\b(?:restore|gjenoppretting|avvik|backup)\w*\b/iu.test(
          window,
        )
      ),
  );
  const operatingMatrixSentences = splitIntoSentences(semanticAnswer).filter(
    (sentence) =>
      /\b(?:dataklassebasert\s+)?backup-?matrise\w*\b/i.test(sentence),
  );
  const operatingMatrixSentence = operatingMatrixSentences[0];
  const matrixIsConditional = operatingMatrixSentences.length
    ? operatingMatrixSentences.some(
        (sentence) =>
          /\b(?:kan|ved\s+behov|valgfri\w*|opsjon\w*|tilvalg|eventuelt|dersom|hvis|foreslås|anbefales|planlegges|(?:det\s+)?tas\s+sikte\s+på|med\s+forbehold|etter\s+nærmere\s+avtale|(?:bare|kun)\s+når|etter\s+kundens\s+valg|når\s+kunden\s+(?:ber|bestiller))\b/i.test(
            sentence,
          ) ||
          /\b(?:ikke|aldri|uten)\b[^.!?;]{0,40}\bbind\w*\b|\bbind\w*\b[^.!?;]{0,40}\b(?:ikke|aldri)\b/i.test(
            sentence,
          ),
      )
    : true;
  const conditionsRequiredControlDelivery = splitIntoSentences(
    semanticAnswer,
  ).some(
    (sentence) =>
      /\b(?:hele|denne|selve)?\s*(?:backup-?rutinen|rutinen|leveransen|kontrollen)\b/i.test(
        sentence,
      ) &&
      /\b(?:(?:bare|kun)\s+når|ved\s+behov|dersom|hvis|etter\s+kundens\s+valg|når\s+kunden\s+(?:ber|bestiller))\b/i.test(
        sentence,
      ),
  );
  const blanketNegatesOrConditionsControls = splitIntoSentences(
    semanticAnswer,
  ).some(
    (sentence) =>
      /\b(?:ovennevnte|nevnte|beskrevne|slike|samtlige|alle|samlede|samlet|disse|dem|dette|foregående|ovenfor|alt|hele|pakken|opplegget|punktene?)\b[^.!?]{0,100}\b(?:kontroll\w*|aktivitet\w*|tiltak\w*|leverans\w*|omfang\w*|mekanism\w*|punkt\w*|pakke\w*|opplegg\w*)\b|\b(?:kontroll\w*|aktivitet\w*|tiltak\w*|leverans\w*|omfang\w*|mekanism\w*|punkt\w*|pakke\w*|opplegg\w*)\b[^.!?]{0,100}\b(?:ovennevnte|nevnte|beskrevne|slike|samtlige|alle|samlede|samlet|disse|dem|dette|foregående|ovenfor|alt|hele)\b|\b(?:ingen\s+av\s+dem|alt\s+(?:ovenfor|dette)|det\s+foregående|hele\s+(?:pakken|opplegget)|leveransen|kontrollene)\b/i.test(
        sentence,
      ) &&
      /\b(?:ingen|ikke|frivillig\w*|valgfri\w*|avhengig\w*|bare|kun|tilvalg|opsjon\w*|forbehold\w*|forutset\w*|forutsett\w*|tilleggsbestilling|separat\s+(?:ordre|bestilling)|etter\s+kundens\s+bestilling|mot\s+særskilt\s+bestilling|særskilt\s+(?:bestilling|godkjenning)|aktiveres\s+(?:bare|kun))\b/i.test(
        sentence,
      ),
  );
  const hasApprovedOperatingMatrix =
    Boolean(operatingMatrixSentence) &&
    !matrixIsConditional &&
    /\bfrekvens\b/i.test(operatingMatrixSentence ?? "") &&
    /\boppbevaringstid\b/i.test(operatingMatrixSentence ?? "") &&
    /(?:\bgjenopprettingsmål\b|\bRTO\b[^.!?;]{0,40}\bRPO\b|\bRPO\b[^.!?;]{0,40}\bRTO\b)/i.test(
      operatingMatrixSentence ?? "",
    ) &&
    /\btestkalender\b/i.test(operatingMatrixSentence ?? "") &&
    /\bgodkj\w*\b/i.test(operatingMatrixSentence ?? "") &&
    /\bbind\w*\b/i.test(operatingMatrixSentence ?? "") &&
    /\bfør\s+produksjonssetting\b/i.test(operatingMatrixSentence ?? "");
  const defersOperatingBaseline = splitIntoSentences(semanticAnswer).some(
    (sentence) =>
      /\b(?:frekvens\w*|oppbevaringstid\w*|lagringstid\w*|RTO|RPO|testkalender\w*|restore-test(?:hyppighet|intervall)?\w*)\b/i.test(
        sentence,
      ) &&
      /\b(?:avklar\w*|avtal\w*|fastsett\w*|definer\w*|beslutt\w*|bestem\w*|velg\w*)\b/i.test(
        sentence,
      ) &&
      /\b(?:designfase|designfasen|senere|etter\s+(?:kontrakt|tildeling|oppstart|produksjonssetting|nærmere\s+avtale)|før\s+(?:forpliktelse|kontraktsignering))\b/i.test(
        sentence,
      ),
  );
  const contradictsRequiredSignal = explicitlyNegatesRequiredSignal(
    semanticAnswer,
    [
    /\b(?:backup|sikkerhetskopi)\b[^.!?;]{0,60}\b(?:rutine|runbook|plan|jobb|prosess)\w*\b|\b(?:rutine|runbook|plan|jobb|prosess)\w*\b[^.!?;]{0,60}\b(?:backup|sikkerhetskopi)\b/i,
    /\b(?:kontrollert\s+)?(?:gjenoppretting|restore)\b/i,
    /\b(?:dataintegritet|integritetsverifikasjon|verifikasjon\s+av\s+(?:data)?integritet)\b/i,
    /\b(?:restore-?test|gjenopprettingstest|test(?:er|es)?\s+(?:av\s+)?(?:restore|gjenoppretting))\w*\b/i,
    /\bavvik\w*\b|\blogg\w*\b/i,
    /\b(?:korrigerende\s+tiltak|korriger\w*|utbedr\w*)\b/i,
    /\b(?:dataklassebasert\s+)?backup-?matrise\w*\b/i,
    /\b(?:frekvens|oppbevaringstid|gjenopprettingsmål|RTO|RPO|testkalender)\b/i,
    /\bbind\w*\b/i,
    /\bproduksjonsdata(?:ene)?\b/i,
    /\b(?:ansvarlig\s+driftsrolle|driftsansvarlig|driftseier|driftsansvar)\b/i,
    /\bjobbkontroll\b/i,
    /\bavviksvarsling\b/i,
    /\b(?:kontrollsummer?|sjekksummer?)\b/i,
    /\bobjekttelling(?:er)?\b/i,
    /\bretest\w*\b|\btestes?\s+på\s+nytt\b/i,
    ],
  );

  return (
    !contradictsRequiredSignal &&
    !defersOperatingBaseline &&
    !conditionsRequiredControlDelivery &&
    !blanketNegatesOrConditionsControls &&
    hasBackupRoutine &&
    hasControlledRestore &&
    hasRestoreTest &&
    hasBackupProductionScope &&
    hasBackupOperationalOwnership &&
    hasRestoreIntegrityEvidence &&
    hasRestoreTestFollowup &&
    hasApprovedOperatingMatrix
  );
}

export function isAcceptanceTestCoverageRequirement(requirement: string) {
  return (
    /\bakseptansetest\b/i.test(requirement) &&
    [
      /\bbrukerroller\b/i,
      /\bintegrasjoner\b/i,
      /\brapporter\b/i,
      /\bfeilscenarier\b/i,
      /\btilgangsendringer\b/i,
    ].every((pattern) => pattern.test(requirement))
  );
}

export function hasCompleteAcceptanceTestCoverage(answer: string) {
  const coversAllScenarios = [
    /\bbrukerroller\b/i,
    /\bintegrasjoner\b/i,
    /\brapporter\b/i,
    /\bfeilscenarier\b/i,
    /\btilgangsendringer\b/i,
  ].every((pattern) => pattern.test(answer));
  const hasExpectedResults = /\bforvent(?:et|ede)\s+resultat\w*\b/i.test(answer);
  const logsDeviation = /\bavvik\w*\b/i.test(answer) && /\blogg\w*\b/i.test(answer);
  const hasResponsibleAction =
    /\bansvarlig\w*\b[^.]{0,80}\btiltak\w*\b|\btiltak\w*\b[^.]{0,80}\bansvarlig\w*\b/i.test(
      answer,
    );
  const hasRetest = /\bretest\w*\b|\btestes?\s+på\s+nytt\b/i.test(answer);
  const hasSummaryOrApproval =
    /\b(?:test)?oppsummering\w*\b|\bgodkjen\w*\b|\bgo\/?no-go\b/i.test(answer);
  const contradictsRequiredSignal = explicitlyNegatesRequiredSignal(answer, [
    /\bbrukerroller\b/i,
    /\bintegrasjoner\b/i,
    /\brapporter\b/i,
    /\bfeilscenarier\b/i,
    /\btilgangsendringer\b/i,
    /\bforvent(?:et|ede)\s+resultat\w*\b/i,
    /\bavvik\w*\b|\blogg\w*\b/i,
    /\bansvarlig\w*\b|\btiltak\w*\b/i,
    /\bretest\w*\b|\btestes?\s+på\s+nytt\b/i,
    /\b(?:test)?oppsummering\w*\b|\bgodkjen\w*\b|\bgo\/?no-go\b/i,
  ]);

  return (
    !contradictsRequiredSignal &&
    coversAllScenarios &&
    hasExpectedResults &&
    logsDeviation &&
    hasResponsibleAction &&
    hasRetest &&
    hasSummaryOrApproval
  );
}

type DocumentedPerformanceTarget = {
  value: string;
  unit: string;
  percentile?: string;
  comparator?: "max" | "min";
};

type DocumentedContinuityTarget = {
  kind: "RTO" | "RPO";
  value: string;
  unit: string;
  comparator: "max" | "min" | "exact";
  localContext: string;
};

function normalizedPerformanceTargetUnit(value: string) {
  const unit = value.toLocaleLowerCase("nb").replace(/\s+/g, " ").trim();
  if (/^(?:ms|millisekund)/.test(unit)) return "ms";
  if (/^(?:samtidige\s+)?bruker/.test(unit)) return "users";
  if (/^(?:s$|sek\.?|sekund)/.test(unit)) return "s";
  if (/^(?:min|minutt|minute)/.test(unit)) return "min";
  if (/^(?:h$|t$|time|hour)/.test(unit)) return "h";
  if (/^(?:dag|day)/.test(unit)) return "day";
  if (/^døgn/.test(unit)) return "day";
  if (/^(?:uke|week)/.test(unit)) return "week";
  if (/^(?:%|prosent)/.test(unit)) return "%";
  if (/^tps/.test(unit)) return "transactions/s";
  if (/^rps/.test(unit)) return "requests/s";
  if (/^transaksjon/.test(unit)) {
    return /(?:per|\/)/.test(unit) ? "transactions/s" : "transactions";
  }
  if (/^forespørsel/.test(unit)) {
    return /(?:per|\/)/.test(unit) ? "requests/s" : "requests";
  }
  return unit;
}

function extractPerformanceTargets(value: string): DocumentedPerformanceTarget[] {
  const normalized = normalizePageText(value);
  const matches = normalized.matchAll(
    /(\d+(?:[,.]\d+)?)\s*(ms|millisekunder?|sek\.?|sekunder?|s\b|min(?:utter?)?|minutes?|t\b|timer?|hours?|dager?|days?|%|prosent|tps|rps|transaksjoner?(?:\s*(?:per|\/)\s*(?:sekund|s))?|forespørsler?(?:\s*(?:per|\/)\s*(?:sekund|s))?|(?:samtidige\s+)?brukere?)/gi,
  );
  const targets: DocumentedPerformanceTarget[] = [];
  for (const match of matches) {
    const numericValue = Number.parseFloat(match[1].replace(",", "."));
    if (!Number.isFinite(numericValue)) {
      continue;
    }
    const prefix = normalized.slice(Math.max(0, (match.index ?? 0) - 40), match.index);
    const suffix = normalized.slice(
      (match.index ?? 0) + match[0].length,
      (match.index ?? 0) + match[0].length + 30,
    );
    const percentile = prefix.match(/\b(p\d{2})\b[^p\d]*$/i)?.[1]?.toLowerCase();
    const comparator = /(?:maks(?:imalt)?|høyst|under|lavere\s+enn|≤|<=)\s*$/i.test(
      prefix,
    ) || /^(?:\s*(?:eller\s+lavere|som\s+maksimum))/i.test(suffix)
      ? "max"
      : /(?:minst|minimum|over|høyere\s+enn|≥|>=)\s*$/i.test(prefix) ||
          /^(?:\s*(?:eller\s+høyere|som\s+minimum))/i.test(suffix)
        ? "min"
        : undefined;
    targets.push({
      value: String(numericValue),
      unit: normalizedPerformanceTargetUnit(match[2]),
      ...(percentile ? { percentile } : {}),
      ...(comparator ? { comparator } : {}),
    });
  }

  return Array.from(
    new Map(
      targets.map((target) => [
        `${target.percentile ?? ""}:${target.comparator ?? ""}:${target.value}:${target.unit}`,
        target,
      ]),
    ).values(),
  );
}

function requirementSourceTextWithoutAnswer(entry: RequirementLedgerEntry) {
  const requirementSource = requirementSourceExcerptWithoutAnswer(entry);
  return [entry.text, requirementSource, entry.heading, entry.service ?? ""]
    .filter(Boolean)
    .join(" ");
}

function authoritativeRequirementRowTextWithoutAnswer(
  entry: RequirementLedgerEntry,
) {
  const requirementSource = requirementSourceExcerptWithoutAnswer(entry);
  return [entry.text, requirementSource].filter(Boolean).join(" ");
}

function extractDocumentedContinuityTargets(
  value: string,
): DocumentedContinuityTarget[] {
  const normalized = normalizePageText(value).replace(
    /\b(?:men|mens|derimot)\b/gi,
    ";",
  );
  const targets: DocumentedContinuityTarget[] = [];
  const unitPattern =
    String.raw`(?:ms|millisekunder?|sek\.?|sekunder?|s\b|min(?:utter?)?|minutes?|t\b|timer?|hours?|dager?|days?|døgn|uker?|weeks?|h\b)`;
  const leadPattern =
    String.raw`\b(RTO|RPO)\s*(?:(?:er|på|skal\s+være|maks(?:imalt)?\.?|høyst|innen|minst|minimum)\s*)*(?:[:=≤≥<>\-–—]\s*)?`;
  const numberWords: Record<string, number> = {
    null: 0,
    en: 1,
    ett: 1,
    én: 1,
    ei: 1,
    to: 2,
    tre: 3,
    fire: 4,
    fem: 5,
    seks: 6,
    sju: 7,
    syv: 7,
    åtte: 8,
    ni: 9,
    ti: 10,
    elleve: 11,
    tolv: 12,
    tretten: 13,
    fjorten: 14,
    femten: 15,
    seksten: 16,
    sytten: 17,
    atten: 18,
    nitten: 19,
    tjue: 20,
    tretti: 30,
    førti: 40,
    femti: 50,
    seksti: 60,
  };
  const wordPattern = Object.keys(numberWords).join("|");
  const canonicalDuration = (numericValue: number, rawUnit: string) => {
    const unit = normalizedPerformanceTargetUnit(rawUnit);
    const factor =
      unit === "ms"
        ? 1
        : unit === "s"
          ? 1_000
          : unit === "min"
            ? 60_000
            : unit === "h"
              ? 3_600_000
              : unit === "day"
                ? 86_400_000
                : unit === "week"
                  ? 604_800_000
                  : Number.NaN;
    return String(numericValue * factor);
  };
  const localContext = (start: number, end: number) => {
    const leftBoundary = Math.max(
      normalized.lastIndexOf(".", start - 1),
      normalized.lastIndexOf(";", start - 1),
      normalized.lastIndexOf("!", start - 1),
      normalized.lastIndexOf("?", start - 1),
      start - 120,
    );
    const rightCandidates = [".", ";", "!", "?"]
      .map((separator) => normalized.indexOf(separator, end))
      .filter((index) => index >= 0);
    const rightBoundary = Math.min(
      rightCandidates.length ? Math.min(...rightCandidates) : normalized.length,
      end + 120,
    );
    return normalized.slice(Math.max(0, leftBoundary + 1), rightBoundary);
  };
  const comparator = (matchedText: string) =>
    /(?:≤|<|maks(?:imalt)?\.?|høyst|innen)/i.test(matchedText)
      ? "max"
      : /(?:≥|>|minst|minimum)/i.test(matchedText)
        ? "min"
        : "exact";
  const occupiedSpans: Array<{
    start: number;
    end: number;
    kind: "RTO" | "RPO";
  }> = [];
  const addTarget = (
    match: RegExpMatchArray,
    numericValue: number,
    rawUnit: string,
    kindOverride?: "RTO" | "RPO",
    comparatorOverride?: "max" | "min" | "exact",
  ) => {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    const kind =
      kindOverride ?? (match[1].toUpperCase() as "RTO" | "RPO");
    if (
      !Number.isFinite(numericValue) ||
      occupiedSpans.some(
        (span) => span.kind === kind && start < span.end && end > span.start,
      )
    ) {
      return;
    }
    occupiedSpans.push({ start, end, kind });
    targets.push({
      kind,
      value: canonicalDuration(numericValue, rawUnit),
      unit: "duration_ms",
      comparator: comparatorOverride ?? comparator(match[0]),
      localContext: localContext(start, end),
    });
  };

  for (const match of normalized.matchAll(
    new RegExp(
      `${leadPattern}P(?:(\\d+(?:[,.]\\d+)?)D)?(?:T(?:(\\d+(?:[,.]\\d+)?)H)?(?:(\\d+(?:[,.]\\d+)?)M)?(?:(\\d+(?:[,.]\\d+)?)S)?)?\\b`,
      "gi",
    ),
  )) {
    const days = match[2]
      ? Number.parseFloat(match[2].replace(",", "."))
      : 0;
    const hours = match[3]
      ? Number.parseFloat(match[3].replace(",", "."))
      : 0;
    const minutes = match[4]
      ? Number.parseFloat(match[4].replace(",", "."))
      : 0;
    const seconds = match[5]
      ? Number.parseFloat(match[5].replace(",", "."))
      : 0;
    if (match[2] || match[3] || match[4] || match[5]) {
      addTarget(
        match,
        days * 86_400 + hours * 3_600 + minutes * 60 + seconds,
        "s",
      );
    }
  }
  for (const match of normalized.matchAll(
    new RegExp(
      `${leadPattern}(\\d+(?:[,.]\\d+)?)\\s*(t\\b|timer?|hours?|h\\b)\\s*(?:og\\s*)?(\\d+(?:[,.]\\d+)?)\\s*(min(?:utter?)?|minutes?)`,
      "gi",
    ),
  )) {
    addTarget(
      match,
      Number.parseFloat(match[2].replace(",", ".")) * 60 +
        Number.parseFloat(match[4].replace(",", ".")),
      "min",
    );
  }
  for (const match of normalized.matchAll(
    new RegExp(
      `\\b(?:gjenoppretting(?:stid)?|restore)\\b[^.!?;]{0,50}\\b(?:innen|maks(?:imalt)?\\.?|høyst|≤|<)\\s*(${wordPattern})\\s*(${unitPattern})`,
      "giu",
    ),
  )) {
    addTarget(
      match,
      numberWords[match[1].toLocaleLowerCase("nb")] ?? Number.NaN,
      match[2],
      "RTO",
      "max",
    );
  }
  // Norwegian also places the bound before the noun: "maksimal
  // gjenopprettingstid er 90 minutter". Require an adjacent duration so a
  // later, unrelated number cannot turn an unspecified target into evidence.
  for (const match of normalized.matchAll(
    new RegExp(
      `\\b(?:maksimal|maksimalt|maks\\.?)\\s+gjenopprettingstid\\s*(?:(?:er|på|skal\\s+være)\\s*|[:=]\\s*)?(\\d+(?:[,.]\\d+)?|${wordPattern})\\s*(${unitPattern})`,
      "giu",
    ),
  )) {
    const duration = numberWords[match[1].toLocaleLowerCase("nb")] ??
      Number.parseFloat(match[1].replace(",", "."));
    addTarget(match, duration, match[2], "RTO", "max");
  }
  for (const match of normalized.matchAll(
    new RegExp(`${leadPattern}(\\d{1,3}):([0-5]\\d)\\b`, "gi"),
  )) {
    addTarget(
      match,
      Number.parseInt(match[2], 10) * 60 + Number.parseInt(match[3], 10),
      "min",
    );
  }
  for (const match of normalized.matchAll(
    new RegExp(
      `\\b(?:maks(?:imalt)?\\s+)?datatap\\b[^.!?;]{0,40}(?:er|på|skal\\s+være|:|=|≤|<)?\\s*(${wordPattern})\\s*(${unitPattern})`,
      "giu",
    ),
  )) {
    addTarget(
      match,
      numberWords[match[1].toLocaleLowerCase("nb")] ?? Number.NaN,
      match[2],
      "RPO",
      "max",
    );
  }
  for (const match of normalized.matchAll(
    new RegExp(
      `${leadPattern}(halvannen|en\\s+halv)\\s*(t\\b|timer?|hours?|h\\b)`,
      "giu",
    ),
  )) {
    addTarget(match, /^halvannen$/iu.test(match[2]) ? 1.5 : 0.5, match[3]);
  }
  for (const match of normalized.matchAll(
    new RegExp(`${leadPattern}(\\d+(?:[,.]\\d+)?)\\s*(${unitPattern})`, "gi"),
  )) {
    addTarget(match, Number.parseFloat(match[2].replace(",", ".")), match[3]);
  }
  for (const match of normalized.matchAll(
    new RegExp(`${leadPattern}(${wordPattern})\\s*(${unitPattern})`, "giu"),
  )) {
    addTarget(match, numberWords[match[2].toLocaleLowerCase("nb")] ?? Number.NaN, match[3]);
  }
  for (const match of normalized.matchAll(
    new RegExp(
      `\\b(?:gjenoppretting(?:stid)?|restore)\\b[^.!?;]{0,50}\\b(?:innen|maks(?:imalt)?\\.?|høyst|≤|<)\\s*(\\d+(?:[,.]\\d+)?)\\s*(${unitPattern})`,
      "gi",
    ),
  )) {
    addTarget(
      match,
      Number.parseFloat(match[1].replace(",", ".")),
      match[2],
      "RTO",
      "max",
    );
  }
  for (const match of normalized.matchAll(
    new RegExp(
      `\\b(?:maks(?:imalt)?\\s+)?datatap\\b[^.!?;]{0,40}(?:er|på|skal\\s+være|:|=|≤|<)?\\s*(\\d+(?:[,.]\\d+)?)\\s*(${unitPattern})`,
      "gi",
    ),
  )) {
    addTarget(
      match,
      Number.parseFloat(match[1].replace(",", ".")),
      match[2],
      "RPO",
      "max",
    );
  }

  return Array.from(
    new Map(
      targets.map((target) => [
        `${target.kind}:${target.comparator}:${target.value}:${target.unit}`,
        target,
      ]),
    ).values(),
  );
}

function answerCommitsDocumentedContinuityTargets(
  answer: string,
  targets: DocumentedContinuityTarget[],
) {
  if (!targets.length) {
    return true;
  }
  const answerTargets = extractDocumentedContinuityTargets(answer);
  return targets.every((target) =>
    answerTargets.some((candidate) => {
      if (
        candidate.kind !== target.kind ||
        candidate.comparator !== target.comparator ||
        candidate.value !== target.value ||
        candidate.unit !== target.unit
      ) {
        return false;
      }
      const context = candidate.localContext;
      const merelyReportsSource =
        /\b(?:kilden|kravet|bilaget|radutdraget)\s+(?:oppgir|angir|nevner|beskriver|krever)\b/i.test(
          context,
        );
      const negatesOrDefers =
        /\b(?:ikke|kan|kun|bare|ved\s+behov|avklar\w*|foreslås|senere|referanseverdi\w*|indikativ\w*)\b/i.test(
          context,
        );
      const positivelyCommits =
        /\b(?:forplikter|leverer|oppfyller|etterlever|fastsett\w*|bind\w*|godkj\w*|maksimalt|høyst|innen|skal|må)\b/i.test(
          context,
        ) ||
        new RegExp(`\\b${candidate.kind}\\s*(?:er|settes\\s+til)\\b`, "i").test(
          context,
        );
      return !merelyReportsSource && !negatesOrDefers && positivelyCommits;
    }),
  );
}

export function documentedPerformanceTargets(entry: RequirementLedgerEntry) {
  return extractPerformanceTargets(requirementSourceTextWithoutAnswer(entry));
}

function answerCommitsDocumentedPerformanceTargets(
  answer: string,
  targets: DocumentedPerformanceTarget[],
) {
  if (!targets.length) {
    return true;
  }
  const answerTargets = extractPerformanceTargets(answer);
  const containsEveryTarget = targets.every((target) =>
    answerTargets.some(
      (candidate) =>
        candidate.value === target.value &&
        candidate.unit === target.unit &&
        (!target.percentile || candidate.percentile === target.percentile) &&
        (!target.comparator || candidate.comparator === target.comparator),
    ),
  );
  if (!containsEveryTarget) {
    return false;
  }

  return /\b(?:oppfyller|etterlever|forplikter|leverer|dimensjonerer|verifiserer|tester|akseptansekriterier?|maksimalt|minst|minimum|under|over)\b|(?:skal|må)\s+(?:være|holde|oppfylle)|[≤≥]/i.test(
    answer,
  );
}

function samePerformanceTarget(
  left: DocumentedPerformanceTarget,
  right: DocumentedPerformanceTarget,
) {
  return (
    left.value === right.value &&
    left.unit === right.unit &&
    left.percentile === right.percentile &&
    left.comparator === right.comparator
  );
}

function answerIntroducesUndocumentedPerformanceTarget(
  answer: string,
  documentedTargets: DocumentedPerformanceTarget[],
) {
  if (!documentedTargets.length) return false;
  return extractPerformanceTargets(answer).some(
    (answerTarget) =>
      !documentedTargets.some((sourceTarget) =>
        samePerformanceTarget(answerTarget, sourceTarget),
      ),
  );
}

export function requirementAnswerQualityIssues(
  answer: string,
  entry: RequirementLedgerEntry,
) {
  const issues: string[] = [];
  const requirement = normalizeRequirementLedgerText(entry.text);
  const normalizedAnswer = answer.replace(/\s+/g, " ").trim();
  const mandatory = isMandatoryRequirementEntry(entry);

  if (
    mandatory &&
    /\b(?:Atea|leverandøren|løsningen)\s+(?:kan|vil|planlegger|foreslår)\s+(?:levere|tilby|stille|etablere|beskrive|dokumentere|måle|støtte|integrere)\b/i.test(
      normalizedAnswer,
    )
  ) {
    issues.push("weak_mandatory_commitment");
  }

  if (mandatory && answerUsesPassiveWeakCommitment(normalizedAnswer)) {
    issues.push("weak_mandatory_commitment");
  }

  if (mandatory && answerExplicitlyDeclinesRequirement(normalizedAnswer, entry.text)) {
    issues.push("mandatory_requirement_declined");
  }

  if (
    mandatory &&
    /\b(?:Atea\s+legger\s+opp\s+til|dersom kunden (?:også )?mener|hvis kunden (?:også )?mener)\b/i.test(
      normalizedAnswer,
    )
  ) {
    issues.push("conditional_core_scope");
  }

  if (answerUsesFutureDescriptionInsteadOfAnswer(normalizedAnswer)) {
    issues.push("future_description_instead_of_answer");
  }

  if (mandatory && hasDeferredCoreScope(normalizedAnswer)) {
    issues.push("deferred_core_scope");
  }

  if (
    answerIsAttachmentBackedRequirementAnswer(normalizedAnswer) &&
    !answerHasSelfContainedCoverage(normalizedAnswer, entry)
  ) {
    issues.push("attachment_only_requirement_answer");
  }

  const requiresApiArchitecture =
    /\bAPI\b/i.test(requirement) &&
    /\bautentisering\b/i.test(requirement) &&
    /\bdatamodell\b/i.test(requirement);
  if (requiresApiArchitecture) {
    if (!hasConcreteApiPattern(normalizedAnswer)) {
      issues.push("missing_concrete_api_pattern");
    }
    if (!hasConcreteAuthenticationPattern(normalizedAnswer)) {
      issues.push("missing_concrete_authentication_pattern");
    }
    if (!hasConcreteDataModelPattern(normalizedAnswer, requirement)) {
      issues.push("missing_concrete_data_model_pattern");
    }
    if (!hasCompleteApiIntegrationContract(normalizedAnswer, requirement)) {
      issues.push("incomplete_api_integration_contract");
    }
    if (
      isExactIdentityCrmApiRequirement(requirement) &&
      !hasCompleteIdentityCrmApiContract(normalizedAnswer)
    ) {
      issues.push("incomplete_identity_crm_api_contract");
    }
    if (
      isExactPaymentApiRequirement(requirement) &&
      !hasCompletePaymentApiContract(normalizedAnswer)
    ) {
      issues.push("incomplete_payment_api_contract");
    }
    if (
      isExactLmsApiRequirement(requirement) &&
      !hasCompleteLmsApiContract(normalizedAnswer)
    ) {
      issues.push("incomplete_lms_api_contract");
    }
  }

  if (
    /\bsikker datadeling\b/i.test(requirement) &&
    /\bekstern(?:e)? aktør/i.test(requirement) &&
    !/\b(?:API|portal|sikker filoverføring|integrasjon|grensesnitt)\b/i.test(
      normalizedAnswer,
    )
  ) {
    issues.push("missing_external_sharing_pattern");
  }

  if (
    isDataValidationAndAccessRequirement(requirement) &&
    !hasConcreteDataValidationControl(normalizedAnswer)
  ) {
    issues.push("missing_data_validation_control");
  }
  if (
    isDataValidationAndAccessRequirement(requirement) &&
    negatesDataValidationOrAccessControl(normalizedAnswer)
  ) {
    issues.push("negated_data_validation_or_access_control");
  }

  if (
    /testmiljø/i.test(requirement) &&
    !/\b(?:testscenario|testdata|akseptansekriter|forventet resultat)\b/i.test(
      normalizedAnswer,
    )
  ) {
    issues.push("missing_test_method");
  }

  if (isNoManualSpreadsheetRequirement(requirement)) {
    if (!answerBindsEveryNamedNoManualSpreadsheetUser(normalizedAnswer, entry)) {
      issues.push("missing_no_manual_spreadsheet_user_binding");
    }
    if (
      !/(?:oppgaver?|arbeidsflyt(?:er)?|registrering|oppfølging).{0,120}(?:utføres|gjennomføres|håndteres|skjer).{0,50}(?:direkte\s+)?i\s+løsningen|(?:utfører|gjennomfører|håndterer).{0,100}(?:oppgaver?|arbeidsflyt(?:er)?|registrering|oppfølging).{0,50}i\s+løsningen|\blar\b.{0,220}\b(?:utføre|gjennomføre|håndtere)\b.{0,120}(?:oppgaver?|arbeidsflyt(?:er)?|registrering|oppfølging).{0,80}direkte\s+i\s+løsningen/i.test(
        normalizedAnswer,
      )
    ) {
      issues.push("missing_direct_in_solution_workflow");
    }
    if (
      !/registreres\s+(?:(?:bare|kun)\s+)?(?:én|en)\s+gang(?:.{0,100}gjenbruk(?:es)?)?|felles\s+datagrunnlag|integrasjoner?.{0,100}(?:gjenbruk|synkron|henter|oppdaterer)/i.test(
        normalizedAnswer,
      )
    ) {
      issues.push("missing_single_source_registration");
    }
    if (!hasExplicitManualSpreadsheetElimination(normalizedAnswer)) {
      issues.push("does_not_eliminate_manual_spreadsheets");
    }
  }

  if (isLosslessQueueRetryRequirement(requirement)) {
    if (
      !/(?:idempoten|naturlig\s+nøkkel|dedupliser|duplikatkontroll)/i.test(
        normalizedAnswer,
      )
    ) {
      issues.push("missing_duplicate_safe_integration_control");
    }
    if (
      !/(?:persistent\s+kø|varig\s+kø|outbox|inbox|checkpoint|dead-?letter|feilkø|avstemming|reconciliation)/i.test(
        normalizedAnswer,
      )
    ) {
      issues.push("missing_recovery_loss_control");
    }
    if (
      !/kø/i.test(normalizedAnswer) ||
      !/(?:retry|ny\s*kjøring|nykjøring|gjenkjøring)/i.test(normalizedAnswer) ||
      !/(?:sporbar\s+logg|sporbar\s+logging|hendelseslogg|revisjonslogg|(?:feil|køstatus|retry|nykjøring|ny\s+kjøring).{0,140}(?:logges|registreres\s+(?:sporbart|i\s+(?:en\s+)?sporbar\s+logg)|følges\s+i\s+(?:en\s+)?logg))/i.test(
        normalizedAnswer,
      )
    ) {
      issues.push("missing_queue_retry_traceability");
    }
    if (
      requirementExactlyMatches(requirement, EXACT_IDENTITY_CRM_LOSSLESS_REQUIREMENT) &&
      !hasCompleteIdentityCrmLosslessContract(normalizedAnswer)
    ) {
      issues.push("incomplete_identity_crm_lossless_contract");
    }
  }

  if (
    requirementExactlyMatches(
      requirement,
      EXACT_LIFECYCLE_STATUS_CLARIFICATION_REQUIREMENT,
    ) &&
    !hasCompleteLifecycleStatusContract(normalizedAnswer)
  ) {
    issues.push("incomplete_lifecycle_status_contract");
  }

  if (
    requirementExactlyMatches(requirement, EXACT_OFFLINE_TENDER_WORKFLOW_REQUIREMENT) &&
    !hasCompleteOfflineTenderWorkflow(normalizedAnswer)
  ) {
    issues.push("incomplete_offline_tender_workflow");
  }

  if (
    requirementExactlyMatches(requirement, EXACT_LOW_LATENCY_TENDER_REQUIREMENT) &&
    (!hasCompleteLowLatencyTenderContract(normalizedAnswer) ||
      !hasCompleteLowLatencyTenderSourceBinding(normalizedAnswer, entry))
  ) {
    issues.push("incomplete_low_latency_tender_contract");
  }

  if (isResponseTimeAndAccessRequirement(requirement)) {
    if (
      !/(?:målepunkt|percentil|p\d{2}|brukertransaksjon|API-kall|transaksjonstype)/i.test(
        normalizedAnswer,
      )
    ) {
      issues.push("missing_response_time_measurement_points");
    }
    if (
      !/(?:varsl|alarm)/i.test(normalizedAnswer) ||
      !/(?:oppfølg|avvik|eskaler)/i.test(normalizedAnswer)
    ) {
      issues.push("missing_response_time_alert_followup");
    }
    if (!hasAccessRoleAndLeastPrivilege(normalizedAnswer)) {
      issues.push("missing_access_role_least_privilege");
    }
    if (!hasExplicitAccessDataScope(normalizedAnswer)) {
      issues.push("missing_access_data_scope");
    }
  }

  if (isAutomaticNotificationAndAccessRequirement(requirement)) {
    if (hasNoncommittalNotificationOrAccessControl(normalizedAnswer)) {
      issues.push("noncommittal_notification_or_access_control");
    }
    if (!hasMultipleConcreteNotificationTriggers(normalizedAnswer)) {
      issues.push("missing_notification_event_triggers");
    }
    if (!hasConcreteNotificationDeliveryChannel(normalizedAnswer)) {
      issues.push("missing_notification_delivery_channel");
    }
    if (!hasNotificationRecipientMapping(normalizedAnswer)) {
      issues.push("missing_notification_recipient_mapping");
    }
    if (!hasAccessRoleAndLeastPrivilege(normalizedAnswer)) {
      issues.push("missing_access_role_least_privilege");
    }
    if (
      !hasExplicitAccessDataScope(normalizedAnswer) ||
      !hasPerGroupAccessDataScope(normalizedAnswer) ||
      !hasConcreteScopeForEveryNamedAccessRole(normalizedAnswer, requirement)
    ) {
      issues.push("missing_access_data_scope");
    }
  }

  if (
    isStructuredExportPortabilityRequirement(requirement) &&
    !hasConcreteMachineReadableExportFormat(normalizedAnswer)
  ) {
    issues.push("missing_concrete_machine_readable_export_format");
  }

  if (
    isTimedReminderControlRequirement(requirement) &&
    !hasCompleteTimedReminderControl(normalizedAnswer, requirement)
  ) {
    issues.push("incomplete_timed_reminder_control");
  }

  const realtimeCoordination = realtimeCoordinationRequirementProfile(requirement);
  if (
    realtimeCoordination &&
    !answerBindsEveryRealtimeCoordinationObject(
      normalizedAnswer,
      realtimeCoordination.objects,
    )
  ) {
    issues.push("missing_realtime_coordination_source_binding");
  }

  if (isHistoricalMigrationValidationRequirement(requirement)) {
    if (!hasCompleteHistoricalMigrationValidation(normalizedAnswer)) {
      issues.push("incomplete_historical_migration_control");
    }
    if (defersHistoricalMigrationCore(normalizedAnswer)) {
      issues.push("deferred_core_scope");
    }
  }

  if (
    isAuditChangeLogRequirement(requirement) &&
    !hasCompleteAuditChangeLog(normalizedAnswer)
  ) {
    issues.push("incomplete_audit_change_log");
  }

  if (isBackupRestoreVerificationRequirement(requirement)) {
    if (!hasCompleteBackupRestoreVerification(normalizedAnswer)) {
      issues.push("incomplete_backup_restore_verification");
    }
    const documentedContinuityTargets = extractDocumentedContinuityTargets(
      authoritativeRequirementRowTextWithoutAnswer(entry),
    );
    if (
      !answerCommitsDocumentedContinuityTargets(
        normalizedAnswer,
        documentedContinuityTargets,
      )
    ) {
      issues.push("missing_documented_backup_continuity_target");
    }
  }

  if (
    isAcceptanceTestCoverageRequirement(requirement) &&
    !hasCompleteAcceptanceTestCoverage(normalizedAnswer)
  ) {
    issues.push("incomplete_acceptance_test_coverage");
  }
  if (
    isAcceptanceTestCoverageRequirement(requirement) &&
    /\bgjelder\s+produksjonsløsning(?:en)?\b/i.test(
      authoritativeRequirementRowTextWithoutAnswer(entry),
    ) &&
    !/\bproduksjonsløsningens?\b.{0,120}\b(?:godkjent\w*\s+konfigurasjon|produksjonslik\w*\s+(?:konfigurasjon|testmiljø))\b|\bproduksjonslik\w*\s+(?:konfigurasjon|testmiljø)\b.{0,120}\bproduksjonsløsningens?\b/i.test(
      normalizedAnswer,
    )
  ) {
    issues.push("missing_acceptance_production_configuration");
  }

  if (isNoMaterialSlownessDimensioningRequirement(requirement)) {
    const sourcePerformanceTargets = documentedPerformanceTargets(entry);
    if (
      isExactEmployeeMobileDimensioningRequirement(requirement) &&
      !hasCompleteEmployeeMobileDimensioningScope(normalizedAnswer)
    ) {
      issues.push("incomplete_employee_mobile_dimensioning_scope");
    }
    if (!answerBindsDimensioningSourceFocus(normalizedAnswer, requirement)) {
      issues.push("missing_dimensioning_source_focus_binding");
    }
    if (
      !/(?:kapasitetsmodell|kapasitetsbaseline|ytelsesbaseline|volumprofil|lastprofil|samtidige\s+brukere)/i.test(
        normalizedAnswer,
      )
    ) {
      issues.push("missing_capacity_baseline");
    }
    if (!/(?:lasttest|ytelsestest|belastningstest)/i.test(normalizedAnswer)) {
      issues.push("missing_load_performance_test");
    }
    const hasScalingOrProvisionedCapacity =
      /(?:skalering|autoskalering|skaleringsregel)/i.test(normalizedAnswer) ||
      /(?:dimensjonert|provisjonert|forhåndsdimensjonert|fast)\s+kapasitet/i.test(
        normalizedAnswer,
      );
    if (
      !hasScalingOrProvisionedCapacity ||
      !/(?:kapasitetsmargin|reservekapasitet|headroom)/i.test(normalizedAnswer)
    ) {
      issues.push("missing_scaling_capacity_margin");
    }
    const hasPerformanceAcceptance =
      /(?:ytelsesmål|responstidsmål)/i.test(normalizedAnswer) &&
      /akseptansekriter/i.test(normalizedAnswer);
    const proposesMissingTarget =
      sourcePerformanceTargets.length > 0 ||
      /(?:foreslår|foreslås|foreslåtte|tilbyr|tilbys|tilbudte|leverandørforslag|leverandørmål|etableres\s+som\s+forslag|(?:fastsettes|avklares).{0,80}(?:som\s+(?:en\s+)?(?:avklaring|forslag)|før\s+(?:akseptanse|ytelses|last)))/i.test(
        normalizedAnswer,
      );
    if (!hasPerformanceAcceptance || !proposesMissingTarget) {
      issues.push("missing_proposed_performance_acceptance");
    }
    if (
      sourcePerformanceTargets.length === 0 &&
      !hasSupplierProposedNumericPerformanceTarget(normalizedAnswer)
    ) {
      issues.push("missing_supplier_proposed_numeric_performance_target");
    }
    if (isLifecycleTraceabilityDimensioningRequirement(requirement)) {
      const hasEndToEndTraceability =
        /\b(?:ende-til-ende-sporbarhet|sporbarhet\s+fra\s+innmelding\s+til\s+avslutning|fra\s+innmelding\s+til\s+avslutning)\b/i.test(
          normalizedAnswer,
        ) &&
        /\b(?:revisjonsspor|auditlogg|statushistorikk)\b/i.test(
          normalizedAnswer,
        ) &&
        /\blogg(?:ing|er|føring)?\b/i.test(normalizedAnswer) &&
        hasConcreteLifecycleTransactionNames(normalizedAnswer);
      if (!hasEndToEndTraceability) {
        issues.push("missing_end_to_end_traceability_performance_binding");
      }
    }
    const qualifiers = dimensioningSourceQualifierFlags(entry);
    if (
      qualifiers.option &&
      !hasPositiveDimensioningQualifierBinding(
        normalizedAnswer,
        /\b(?:opsjon|tilvalg)\w*\b/i,
        /\b(?:tilbyr|tilbys|leverer|leveres|prises|priset|inngår)\b/i,
      )
    ) {
      issues.push("missing_dimensioning_option_qualifier");
    }
    if (
      qualifiers.production &&
      !hasPositiveDimensioningQualifierBinding(
        normalizedAnswer,
        /\bproduksjonsløsning(?:en|ens)?\b/i,
        /\b(?:gjelder|dimensjoner\w*|leverer|leveres|verifiser\w*|test\w*)\b/i,
      )
    ) {
      issues.push("missing_dimensioning_production_scope");
    }
    if (
      qualifiers.designPhase &&
      !hasPositiveDimensioningQualifierBinding(
        normalizedAnswer,
        /\bdesignfas(?:e|en)\b/i,
        /\b(?:avklar\w*|valider\w*|bekreft\w*)\b/i,
      )
    ) {
      issues.push("missing_dimensioning_design_phase_qualifier");
    }
    if (
      qualifiers.documentation &&
      !hasPositiveDimensioningQualifierBinding(
        normalizedAnswer,
        /\bdokument(?:asjon|ere|erer|eres|ert)\w*\b/i,
        /\b(?:leverer|leveres|utarbeider|utarbeides|dokumenterer|dokumenteres|inngår)\b/i,
      )
    ) {
      issues.push("missing_dimensioning_documentation_qualifier");
    }
    if (
      qualifiers.solutionProposal &&
      !hasPositiveDimensioningQualifierBinding(
        normalizedAnswer,
        /\bløsningsforslag(?:et)?\b/i,
        /\b(?:dimensjoner\w*|forplikter|leverer|verifiser\w*)\b/i,
      )
    ) {
      issues.push("missing_dimensioning_solution_proposal_qualifier");
    }
    if (
      qualifiers.supplierResponse &&
      !hasPositiveDimensioningQualifierBinding(
        normalizedAnswer,
        /\bleverandørbesvarelse(?:n)?\b/i,
        /\b(?:dimensjoner\w*|forplikter|leverer|verifiser\w*)\b/i,
      )
    ) {
      issues.push("missing_dimensioning_supplier_response_qualifier");
    }
    if (
      qualifiers.clarification &&
      !hasPositiveDimensioningQualifierBinding(
        normalizedAnswer,
        /\bavklar\w*\b/i,
        /\b(?:volumprofil|lastprofil|samtidighet|parameter\w*|måltall)\b/i,
      )
    ) {
      issues.push("missing_dimensioning_clarification_qualifier");
    }
    if (
      qualifiers.assumption &&
      !hasPositiveDimensioningQualifierBinding(
        normalizedAnswer,
        /\bforutset\w*\b/i,
        /\b(?:tilbud\w*|løsningsforutsetning\w*|dimensjoner\w*|lastprofil|volumprofil)\b/i,
      )
    ) {
      issues.push("missing_dimensioning_assumption_qualifier");
    }
    if (
      qualifiers.needsNote &&
      !hasPositiveDimensioningQualifierBinding(
        normalizedAnswer,
        /\b(?:notat|behovsarbeid|løsningsforutsetning)\w*\b/i,
        /\b(?:behandles|presenteres|inngår|er)\b/i,
      )
    ) {
      issues.push("missing_dimensioning_note_qualifier");
    }
    if (
      sourcePerformanceTargets.length > 0 &&
      !answerCommitsDocumentedPerformanceTargets(
        normalizedAnswer,
        sourcePerformanceTargets,
      )
    ) {
      issues.push("missing_documented_performance_target_commitment");
    }
    if (
      answerIntroducesUndocumentedPerformanceTarget(
        normalizedAnswer,
        sourcePerformanceTargets,
      )
    ) {
      issues.push("undocumented_performance_target");
    }
    if (negatesPerformanceControl(normalizedAnswer)) {
      issues.push("negated_performance_control");
    }
  }

  if (isSeasonalScalabilityClarificationRequirement(requirement)) {
    if (!answerBindsDimensioningSourceFocus(normalizedAnswer, requirement)) {
      issues.push("missing_dimensioning_source_focus_binding");
    }
    if (
      !/(?:kapasitetsmodell|kapasitetsbaseline|ytelsesbaseline|volumprofil|lastprofil|samtidige\s+brukere)/i.test(
        normalizedAnswer,
      )
    ) {
      issues.push("missing_capacity_baseline");
    }
    if (!/(?:lasttest|ytelsestest|belastningstest)/i.test(normalizedAnswer)) {
      issues.push("missing_load_performance_test");
    }
    const hasScalingOrProvisionedCapacity =
      /(?:skalering|autoskalering|skaleringsregel)/i.test(normalizedAnswer) ||
      /(?:dimensjonert|provisjonert|forhåndsdimensjonert|fast)\s+kapasitet/i.test(
        normalizedAnswer,
      );
    if (
      !hasScalingOrProvisionedCapacity ||
      !/(?:kapasitetsmargin|reservekapasitet|headroom)/i.test(normalizedAnswer)
    ) {
      issues.push("missing_scaling_capacity_margin");
    }
    if (
      !/(?:ytelsesmål|responstidsmål)/i.test(normalizedAnswer) ||
      !/akseptansekriter/i.test(normalizedAnswer)
    ) {
      issues.push("missing_proposed_performance_acceptance");
    }
    if (!hasSupplierProposedNumericPerformanceTarget(normalizedAnswer)) {
      issues.push("missing_supplier_proposed_numeric_performance_target");
    }
    if (
      !/\bleverandørens\s+konkrete\s+avklaring\b/i.test(normalizedAnswer)
    ) {
      issues.push("missing_dimensioning_clarification_qualifier");
    }
    if (negatesPerformanceControl(normalizedAnswer)) {
      issues.push("negated_performance_control");
    }
  }

  return Array.from(new Set(issues));
}

function isLowValueRequirementAnswer(answer: string, entry: RequirementLedgerEntry) {
  const normalized = answer.replace(/\s+/g, " ").trim();
  if (!normalized || normalized.length < 35) {
    return true;
  }

  if (/^(ja|nei|oppfylt|ikke relevant)[.!]?$/i.test(normalized)) {
    return true;
  }

  if (
    isNearDuplicate(normalized, entry.text, 0.86) &&
    !hasOperationalAnswerSignal(normalized)
  ) {
    return true;
  }

  const genericSignals = [
    "basert på prosjektgrunnlaget",
    "tilpasses kundens behov",
    "i tråd med beste praksis",
    "etter nærmere avtale",
  ].filter((signal) =>
    normalized.toLowerCase().includes(signal.toLowerCase()),
  ).length;

  return genericSignals >= 2 && normalized.length < 140;
}

function hasDocumentedExactContinuityValue(value: string) {
  return (
    extractDocumentedContinuityTargets(value).length > 0 ||
    /\bzero unplanned downtime\b/i.test(value)
  );
}

function hasDocumentedExactCommercialOrDeadlineValue(value: string) {
  return /\b(?:NOK|EUR)\s*\d|(?:\d+[,.]\d+|\d+)\s*(?:million|mill\.|m\b)|\bNet\s*\d+|\b\d{1,2}\.?\s*(?:januar|februar|mars|april|mai|juni|juli|july|august|september|oktober|november|desember)\s*20\d{2}|\b20\d{2}-\d{2}-\d{2}\b/i.test(
    value,
  );
}

function enrichRequirementAnswerWithClarifications(
  answer: string,
  entry: RequirementLedgerEntry,
) {
  let result = answer.replace(/\s+/g, " ").trim();
  const authoritativeRowText = normalizeRequirementLedgerText(
    authoritativeRequirementRowTextWithoutAnswer(entry),
  );
  const alreadyClarifies = /\b(avklar\w*|ikke\s+(?:angitt|dokumentert|tallfestet)|foreslås|forutsetning)\b/i.test(
    result,
  );
  const continuityReportingOnly =
    (/\b(?:RTO|RPO)-?status\w*\b/i.test(authoritativeRowText) &&
      /\brapporter\w*\b/i.test(authoritativeRowText)) ||
    (/\b(?:rapporter\w*|status\w*|overvåk\w*|måle\w*)\b/i.test(
      authoritativeRowText,
    ) &&
      !/\b(?:mål\w*|terskel\w*|maks(?:imalt)?|høyst|innen|forplikt\w*|krav\s+til)\b/i.test(
        authoritativeRowText,
      ));

  if (
    /\b(RTO|RPO|nedetid|failover|gjenopprettingstid|datatap)\b/i.test(
      authoritativeRowText,
    ) &&
    !hasDocumentedExactContinuityValue(authoritativeRowText) &&
    !continuityReportingOnly &&
    !(
      isBackupRestoreVerificationRequirement(entry.text) &&
      hasCompleteBackupRestoreVerification(result)
    ) &&
    !alreadyClarifies
  ) {
    result = appendSentence(
      result,
      "Eksakte RTO/RPO-mål eller bindende nedetidsmål er ikke tallfestet i bilaget og avklares som foreslåtte tjenestenivåer før forpliktelse.",
    );
  }

  if (
    /\b(budsjett|betaling|betalingsvilkår|pris|kommers|frist|deadline|leveransefrist)\b/i.test(
      authoritativeRowText,
    ) &&
    !hasDocumentedExactCommercialOrDeadlineValue(authoritativeRowText) &&
    !alreadyClarifies
  ) {
    result = appendSentence(
      result,
      "Eksakte budsjett-, betalings- eller fristverdier er ikke dokumentert i bilaget og håndteres som avklaringer eller tilbudsforutsetninger.",
    );
  }

  return result;
}

export function normalizeRequirementAnswerResult(
  answer: string,
  entry: RequirementLedgerEntry,
  evidence?: string,
): RequirementAnswerResult {
  const cleaned = answer
    .replace(/^\s*[-*]\s+/, "")
    .replace(/^vi\s+/i, "Atea ")
    .replace(/\s+/g, " ")
    .trim();
  const originalQualityIssues = requirementAnswerQualityIssues(cleaned, entry);
  const normalized = normalizeMandatoryRequirementCommitment(
    cleaned,
    entry,
  );
  const qualityIssues = Array.from(
    new Set([
      ...originalQualityIssues,
      ...requirementAnswerQualityIssues(normalized, entry),
    ]),
  );

  if (isLowValueRequirementAnswer(normalized, entry) || qualityIssues.length) {
    return {
      answer: tableRequirementAnswer(entry),
      evidence: requirementAnswerEvidence(entry, evidence),
      source: "deterministic_fallback",
      rejectedAnswer: normalized ? compactText(normalized, 700) : undefined,
      reason: qualityIssues.length
        ? `quality_gate: ${qualityIssues.join(",")}`
        : normalized
          ? "low_value_answer"
          : "missing_answer",
    };
  }

  const sentences = splitIntoSentences(normalized);
  const sentenceLimit = /\b(?:beskriv\w*|redegjør\w*|oppgi|opplyse|klargjør\w*)\b/i.test(
    normalizeRequirementLedgerText(entry.text),
  )
    ? 4
    : 3;
  const sentenceLimited =
    sentences.length > sentenceLimit
      ? sentences.slice(0, sentenceLimit).join(" ")
      : normalized;
  const finalAnswer = enrichRequirementAnswerWithClarifications(
    sentenceLimited,
    entry,
  )
    .replace(/\s+/g, " ")
    .trim();
  const finalQualityIssues = requirementAnswerQualityIssues(finalAnswer, entry);

  if (isLowValueRequirementAnswer(finalAnswer, entry) || finalQualityIssues.length) {
    return {
      answer: tableRequirementAnswer(entry),
      evidence: requirementAnswerEvidence(entry, evidence),
      source: "deterministic_fallback",
      rejectedAnswer: normalized ? compactText(normalized, 700) : undefined,
      reason: finalQualityIssues.length
        ? `quality_gate_after_normalization: ${finalQualityIssues.join(",")}`
        : "low_value_answer_after_normalization",
    };
  }

  return {
    answer: finalAnswer,
    evidence: requirementAnswerEvidence(entry, evidence),
    source: "batch",
  };
}

export function isDeterministicTemplateRepairAnswer(value: string) {
  const normalized = value.replace(/\s+/g, " ").trim();
  return [
    DETERMINISTIC_DIMENSIONING_TEMPLATE_REPAIR,
    DETERMINISTIC_PRODUCTION_DIMENSIONING_TEMPLATE_REPAIR,
  ].includes(normalized);
}

export function isCanonicalSinglePurposeProfiledDimensioningRequirement(
  entry: RequirementLedgerEntry,
) {
  const profile = dimensioningOperationProfile(entry.text);
  return Boolean(
    profile &&
      normalizeRequirementLedgerText(entry.text) ===
        normalizeRequirementLedgerText(
          `Løsningen skal dimensjoneres for ${profile.focus} uten at brukerne opplever vesentlig treghet.`,
        ),
  );
}

export function answerReferencesExternalAttachment(value: string) {
  const text = normalizePageText(value);
  return (
    /\b(?:vedlagt(?:e)?|bilag|lagt\s+ved|se\s+(?:vedlegg|bilag)|appendix|annex|attached|attachment)\b/i.test(
      text,
    ) ||
    /\bvedlegg(?:et)?\s+(?:nr\.?\s*)?(?:\d+|[A-ZÆØÅ](?:[-.]?\d+)?)\b/i.test(
      text,
    ) ||
    /\b(?:finnes|fremgår|ligger|dokumentert|beskrevet|underbygget)\b[^.!?]{0,80}\bi\s+vedlegg(?:et)?\b/i.test(
      text,
    ) ||
    /\b(?:separat|eget|eksternt)\s+(?:fil|dokument|PDF)\b|\b(?:sharepoint|onedrive|google\s+drive|teams|dokumentportal)\b|\b(?:hyper)?lenke\b|\burl\b|https?:\/\/|\bwww\.|\.(?:pdf|docx?|xlsx?|pptx?|csv)\b/i.test(
      text,
    )
  );
}

export function answerIsAttachmentBackedRequirementAnswer(value: string) {
  const text = normalizePageText(value);
  if (!answerReferencesExternalAttachment(text)) {
    return false;
  }

  return (
    /\b(?:komplett|fullstendig|besvart|dekkes|dekker|dokumentasjon|løsningsbeskrivelse|testbevis|kontrollmatrise|bevis|underlag|beskrivelse)\b/i.test(
      text,
    ) ||
    /^(?:se|viser\s+til|henviser\s+til|refererer\s+til).{0,120}\b(?:vedlegg|bilag|appendix|annex|attached|attachment)\b/i.test(
      text,
    )
  );
}

function answerIsStandaloneAttachmentReferenceSentence(value: string) {
  const text = normalizePageText(value);
  if (!answerReferencesExternalAttachment(text)) {
    return false;
  }

  return /^(?:(?:se|jf\.?|viser\s+til|henviser\s+til|refererer\s+til)|(?:(?:komplett|fullstendig|utfyllende|supplerende|tilhørende)\s+)?(?:dokumentasjon|kontrollmatrise|testbevis|bevis|underlag|detaljer|beskrivelse)\s+(?:finnes|fremgår|ligger|er\s+(?:vedlagt|lagt\s+ved|dokumentert))).{0,220}\b(?:vedlegg|bilag|appendix|annex|attachment)\b/i.test(
    text,
  );
}

function stripTrailingSupplementalAttachmentClause(value: string) {
  return normalizePageText(value)
    .replace(
      /\s*(?:[;,]\s*)?(?:(?:(?:komplett|fullstendig|utfyllende|supplerende|tilhørende)\s+)?(?:dokumentasjon|kontrollmatrise|testbevis|bevis|underlag|detaljer|beskrivelse)\s+(?:finnes|fremgår|ligger|er\s+(?:vedlagt|lagt\s+ved|dokumentert))|(?:er\s+)?(?:dokumentert|beskrevet|underbygget)\s+(?:i|av))[^.!?]{0,180}\b(?:vedlegg|bilag|appendix|annex|attachment)\b[^.!?]*[.!?]?$/i,
      "",
    )
    .replace(/\s+/g, " ")
    .trim();
}

function answerWithoutStandaloneAttachmentReferences(value: string) {
  return splitIntoSentences(normalizePageText(value))
    .filter((sentence) => !answerIsStandaloneAttachmentReferenceSentence(sentence))
    .map(stripTrailingSupplementalAttachmentClause)
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

export function answerHasSelfContainedCoverage(
  value: string,
  entry: RequirementLedgerEntry,
) {
  const standalone = answerWithoutStandaloneAttachmentReferences(value);
  if (
    standalone.length < 40 ||
    /^(?:ja|nei|yes|no)[.!]?$/i.test(standalone) ||
    answerReferencesExternalAttachment(standalone) ||
    answerExplicitlyDeclinesRequirement(standalone) ||
    answerDefersRequirementConfirmation(standalone) ||
    answerIsVagueGenericRequirementAnswer(standalone)
  ) {
    return false;
  }

  if (
    isNearDuplicate(standalone, entry.text, 0.9) &&
    standalone.length <= entry.text.length * 1.45
  ) {
    return false;
  }

  return (
    hasOperationalAnswerSignal(standalone) ||
    /\b(?:OAuth|OIDC|rollebasert|minste\s+privilegium|kryptering|feltmapping|valideringsregel|testscenario|avvikslogg|eskalering|målepunkt)\b/i.test(
      standalone,
    )
  );
}

// "X støttes ikke" declines only when X is the delivery itself: a pronoun or
// delivery noun, or, given a requirement that is not itself a prohibition, a
// short sentence-initial noun phrase. A versioned option ("TLS 1.0 støttes
// ikke"), a scope limit ("leveres ikke utenfor EU"), "ikke bare", or an
// exclusion the requirement asks for ("Løsningen skal ikke støtte usikre
// protokoller" answered "Usikre protokoller støttes ikke") is not a decline.
const SUBJECT_DECLINE =
  /(?:^|[.;:!?]\s+)((?:[\p{L}-]+\s+){0,2}[\p{L}-]+)\s+(?:støttes|tilbys|leveres|dekkes)\s+ikke(?!\s+(?:bare|kun|utenfor|uten|før|etter|over|under|via)\b)/giu;
const DELIVERY_SUBJECT =
  /^(?:dette|det|denne|disse|kravet|funksjonen|funksjonaliteten|tjenesten|leveransen|kontrollen)$/iu;
const PROHIBITION =
  /\b(?:skal|må|kan|bør)\s+ikke\b|\bikke\s+(?:tillatt|tillates|benyttes|brukes|forekomme)\b|\b(?:forbudt|uakseptabelt)\b/iu;

function answerDeclinesWithSubject(text: string, requirement: string | undefined) {
  const nounSubjects = requirement !== undefined && !PROHIBITION.test(normalizePageText(requirement));
  return Array.from(text.matchAll(SUBJECT_DECLINE)).some((match) => {
    const subject = (match[1] ?? "").trim();
    if (/\b(?:og|eller|men|samt)\b/iu.test(subject)) return false;
    return DELIVERY_SUBJECT.test(subject) || nounSubjects;
  });
}

/** Whether the answer declines the requirement. Pass the requirement text
 * when known: without it, only a decline of the delivery itself counts. */
export function answerExplicitlyDeclinesRequirement(value: string, requirement?: string) {
  const text = normalizePageText(value);
  if (answerDeclinesWithSubject(text, requirement)) return true;
  return /\b(?:(?:kravet|leveransen|funksjonen|funksjonaliteten|tjenesten|kontrollen|løsningen)\s+(?:inngår\s+ikke|er\s+ikke\s+inkludert)|(?:inngår\s+ikke|er\s+ikke\s+inkludert)\s+i\s+(?:leveransen|tilbudet|scope|omfanget)|ikke\s+leveres|kan\s+ikke\s+(?:levere|støtte|oppfylle|tilby)|utenfor\s+scope|må\s+håndteres\s+av\s+kunden|not\s+included\s+in\s+(?:the\s+)?(?:delivery|offer|scope)|out\s+of\s+scope|cannot\s+(?:deliver|support|meet))\b/i.test(
    text,
  );
}

export function answerDefersRequirementConfirmation(value: string) {
  const text = normalizePageText(value);
  return (
    /\bkan\s+(?:trolig|muligens|eventuelt)\s+(?:støtte|levere|håndtere|oppfylle)\b/i.test(
      text,
    ) ||
    /\bfør\s+vi\s+kan\s+bekrefte\b/i.test(text) ||
    /\bendelig\s+(?:omfang|ansvar|løsning).{0,100}\bmå\s+avklares\b/i.test(
      text,
    ) ||
    /\bmå\s+avklares\b.{0,100}\bendelig\s+(?:omfang|ansvar|løsning)\b/i.test(
      text,
    ) ||
    /\b(?:avventer|venter\s+på)\b/i.test(text) ||
    /\b(?:subject\s+to|to\s+be\s+clarified|tbd)\b/i.test(text) ||
    containsDeferredDecision(text)
  );
}

export function answerIsVagueGenericRequirementAnswer(value: string) {
  const text = normalizePageText(value);
  const genericSignals = [
    /\bbeste\s+praksis\b/i,
    /\btilpass(?:er|es)\s+(?:løsningen\s+)?(?:etter\s+)?(?:kundens\s+)?behov\b/i,
    /\bdetaljer\s+avklares\b/i,
    /\better\s+nærmere\s+avtale\b/i,
    /\bi\s+tråd\s+med\b/i,
  ].filter((pattern) => pattern.test(text)).length;
  if (genericSignals < 2) {
    return false;
  }

  const concreteSignals = [
    /\b(?:ansvarlig|eier|rolle|akseptansekriterier?)\b/i,
    /\b(?:testprotokoll|testbevis|testopplegg|kontrollpunkt|kontroll)\b/i,
    /\b(?:dokumentasjon|rapportering|logg(?:er|ing)?|dashbord)\b/i,
    /\b(?:kryptering|backup|tilgangsstyring|sletterutiner|avvikshåndtering)\b/i,
    /\b(?:produksjonssetting|målepunkt|frist|prosess|rutine)\b/i,
  ].filter((pattern) => pattern.test(text)).length;

  return text.length < 180 || concreteSignals < 2;
}

export const EXACT_LIFECYCLE_STATUS_CLARIFICATION_REQUIREMENT =
  "Leverandøren må avklare og beskrive hvordan følgende løses: det skal være mulig å følge status på kurs, prøver, sertifikater, deltakerprofiler fra opprettelse til avslutning.";

export const EXACT_IDENTITY_CRM_LOSSLESS_REQUIREMENT =
  "Løsningen skal integreres med ID-porten og CRM og håndtere feil, kø og ny kjøring uten tap av kurs, prøver, sertifikater, deltakerprofiler.";

export const EXACT_OFFLINE_TENDER_WORKFLOW_REQUIREMENT =
  "Leverandøren må avklare og beskrive hvordan følgende løses: løsningen skal støtte offline-støtte for å gjennomføre digital kursplattform for påmelding, eksamen og sertifikatbevis på en kontrollert og sporbar måte.";

export const EXACT_LOW_LATENCY_TENDER_REQUIREMENT =
  "Leverandøren skal beskrive hvordan løsningen ivaretar lav ventetid i kritiske arbeidsprosesser for kurs og sertifisering for arbeidsliv.";

export type DeterministicSourceQualifier =
  | "production"
  | "designPhase"
  | "solutionProposal"
  | "documentation"
  | "supplierResponse"
  | "option"
  | "clarification"
  | "assumption"
  | "needsNote";

const DETERMINISTIC_SOURCE_QUALIFIER_PATTERNS: Record<
  DeterministicSourceQualifier,
  RegExp
> = {
  production: /\bgjelder\s+produksjonsløsning(?:en)?\b/giu,
  designPhase: /\bmå\s+avklares\s+i\s+designfas(?:e|en)\b/giu,
  solutionProposal: /\bkrever\s+løsningsforslag\b/giu,
  documentation: /\bdokumentasjon\s+ønskes\b/giu,
  supplierResponse: /\bbesvares\s+av\s+leverandør\b/giu,
  option: /\bkan\s+prises?\s+som\s+opsjon\b/giu,
  clarification: /\bleverandøren\s+må\s+avklare\b/giu,
  assumption: /\bteksten\s+forutsetter\s+at\b/giu,
  needsNote: /\bnotat\s+fra\s+behovsarbeidet\b/giu,
};

export type DeterministicControlSourceFlags = ReturnType<
  typeof dimensioningSourceQualifierFlags
> & {
  priority: "Må" | "Bør" | "Kan" | null;
};

type DeterministicControlSourceFields = {
  priority: DeterministicControlSourceFlags["priority"];
  residual: string;
};

const ALL_DETERMINISTIC_SOURCE_QUALIFIERS = new Set<
  DeterministicSourceQualifier
>([
  "production",
  "designPhase",
  "solutionProposal",
  "documentation",
  "supplierResponse",
  "option",
  "clarification",
  "assumption",
  "needsNote",
]);

function normalizedDeterministicPriority(
  value: string | undefined,
): DeterministicControlSourceFlags["priority"] {
  const priority = value?.trim().toLocaleLowerCase("nb") ?? "";
  return priority === "må"
    ? "Må"
    : priority === "bør"
      ? "Bør"
      : priority === "kan"
        ? "Kan"
        : null;
}

function isExactDeterministicSourceIdChrome(
  value: string,
  normalizedId: string,
) {
  if (!normalizedId) return false;

  let candidate = value.trim();
  const labeledId =
    /^(?:krav-id|referanse|ref|id\s*\/\s*markering)\s*[:：]\s*(.+)$/iu.exec(
      candidate,
    );
  if (labeledId) {
    candidate = labeledId[1]?.trim() ?? "";
  }

  const bracketedId = /^(?:\[\s*(.+?)\s*\]|\(\s*(.+?)\s*\))$/u.exec(
    candidate,
  );
  if (bracketedId) {
    candidate = (bracketedId[1] ?? bracketedId[2] ?? "").trim();
  }

  return (
    normalizeRequirementLedgerText(candidate).toLocaleLowerCase("nb") ===
    normalizedId.toLocaleLowerCase("nb")
  );
}

function startsWithDeterministicSourceQualifier(value: string) {
  return Object.values(DETERMINISTIC_SOURCE_QUALIFIER_PATTERNS).some(
    (pattern) => {
      pattern.lastIndex = 0;
      const match = pattern.exec(value.trim());
      pattern.lastIndex = 0;
      return match?.index === 0;
    },
  );
}

/**
 * Parses only owned row fields. A priority is consumed only from an explicit
 * Prioritet field, a standalone pipe cell, or the generated
 * `priority + known qualifier` suffix. A Merknad payload remains residual
 * unless its complete payload is handled by the selected dynamic builder.
 */
export function deterministicControlSourceFields(
  entry: RequirementLedgerEntry,
  allowedQualifiers: ReadonlySet<DeterministicSourceQualifier>,
): DeterministicControlSourceFields {
  let source = normalizeRequirementLedgerText(
    requirementSourceExcerptWithoutAnswer(entry),
  );
  if (!source) {
    return { priority: null, residual: "missing-source" };
  }

  const requirement = normalizeRequirementLedgerText(entry.text);
  let requirementIndex = requirement ? source.indexOf(requirement) : -1;
  if (requirement && requirementIndex < 0) {
    const generatedChrome =
      /\s+(må|bør|kan)\s+(gjelder\s+produksjonsløsning(?:en)?|dokumentasjon\s+ønskes|krever\s+løsningsforslag|må\s+avklares\s+i\s+designfas(?:e|en)|kan\s+prises?\s+som\s+opsjon|besvares\s+av\s+leverandør)(?=\s)/iu.exec(
        source,
      );
    if (generatedChrome) {
      const chromeIndex = generatedChrome.index;
      const candidate = normalizeRequirementLedgerText(
        `${source.slice(0, chromeIndex)} ${source.slice(
          chromeIndex + generatedChrome[0].length,
        )}`,
      );
      if (candidate.includes(requirement)) {
        source = `${candidate}|${generatedChrome[1]}|${generatedChrome[2]}`;
        requirementIndex = source.indexOf(requirement);
      }
    }
  }
  if (!requirement || requirementIndex < 0) {
    return { priority: null, residual: "requirement-not-bound" };
  }

  const sourceWithoutRequirement = `${source.slice(0, requirementIndex)}|${source.slice(
    requirementIndex + requirement.length,
  )}`;
  const normalizedId = normalizeRequirementLedgerText(entry.id ?? "");
  const residualParts: string[] = [];
  let priority: DeterministicControlSourceFlags["priority"] = null;
  let conflictingPriority = false;

  const recordPriority = (rawPriority: string | undefined) => {
    const parsed = normalizedDeterministicPriority(rawPriority);
    if (!parsed) return false;
    if (priority && priority !== parsed) {
      conflictingPriority = true;
    } else {
      priority = parsed;
    }
    return true;
  };

  for (const rawPart of sourceWithoutRequirement.split("|")) {
    let part = rawPart.trim();
    if (!part) continue;

    if (isExactDeterministicSourceIdChrome(part, normalizedId)) {
      continue;
    }
    if (
      /^\[\s*x\s*\]$/iu.test(part) &&
      /^Dokumenttekst\s+krav\s+\d+$/iu.test(entry.id ?? "") &&
      /^Dokumenttekst$/iu.test(entry.tableId ?? "") &&
      isCanonicalSinglePurposeProfiledDimensioningRequirement(entry)
    ) {
      continue;
    }
    if (/^\[\s*\]$/u.test(part)) {
      residualParts.push("unchecked-checkbox");
      continue;
    }

    if (
      normalizedId &&
      part.toLocaleLowerCase("nb").startsWith(
        normalizedId.toLocaleLowerCase("nb"),
      ) &&
      /^(?:$|[\s:：;,.()\[\]-])/u.test(part.slice(normalizedId.length))
    ) {
      part = part.slice(normalizedId.length).trim();
    }
    if (!part) continue;

    const sourceLabel =
      /^(?:kravgrunnlag|kravtekst|krav|krav-id|referanse|ref|hva\s+er\s+sagt\s*\/\s*ønsket)\s*[:：]\s*(.*)$/iu.exec(
        part,
      );
    if (sourceLabel) {
      part = sourceLabel[1]?.trim() ?? "";
      if (!part) continue;
    }
    if (
      /^(?:kravgrunnlag|kravtekst|krav|krav-id|referanse|ref|id\s*\/\s*markering|hva\s+er\s+sagt\s*\/\s*ønsket)\s*[:：]?$/iu.test(
        part,
      )
    ) {
      continue;
    }
    if (
      allowedQualifiers.has("clarification") &&
      /^Avklaring\s*[:：]?$/iu.test(part) &&
      /^Avklaringskrav-\d+$/iu.test(entry.id ?? "") &&
      /^Dokumenttekst$/iu.test(entry.tableId ?? "") &&
      dimensioningSourceQualifierFlags(entry).clarification
    ) {
      continue;
    }

    const noteField = /^(?:merknad|kommentar)\s*[:：]\s*(.*)$/iu.exec(part);
    if (noteField) {
      part = noteField[1]?.trim() ?? "";
      if (!part) continue;
      for (const [qualifier, pattern] of Object.entries(
        DETERMINISTIC_SOURCE_QUALIFIER_PATTERNS,
      ) as Array<[DeterministicSourceQualifier, RegExp]>) {
        if (allowedQualifiers.has(qualifier)) {
          part = part.replace(pattern, " ");
        }
      }
      const noteResidual = normalizeComparableText(part);
      if (noteResidual) {
        residualParts.push(`merknad ${noteResidual}`);
      }
      continue;
    }

    const explicitPriority =
      /^(?:prioritet|må\s*\/\s*bør\??)\s*[:：]?\s*(må|bør|kan)$/iu.exec(
        part,
      );
    if (explicitPriority) {
      recordPriority(explicitPriority[1]);
      continue;
    }
    const standalonePriority = /^(må|bør|kan)$/iu.exec(part);
    if (standalonePriority) {
      recordPriority(standalonePriority[1]);
      continue;
    }

    const generatedPriorityPrefix = /^(må|bør|kan)\s+(.+)$/iu.exec(part);
    if (
      generatedPriorityPrefix &&
      startsWithDeterministicSourceQualifier(generatedPriorityPrefix[2] ?? "")
    ) {
      recordPriority(generatedPriorityPrefix[1]);
      part = generatedPriorityPrefix[2] ?? "";
    }

    for (const [qualifier, pattern] of Object.entries(
      DETERMINISTIC_SOURCE_QUALIFIER_PATTERNS,
    ) as Array<[DeterministicSourceQualifier, RegExp]>) {
      if (allowedQualifiers.has(qualifier)) {
        part = part.replace(pattern, " ");
      }
    }

    const normalizedPart = normalizeComparableText(part);
    if (
      allowedQualifiers.has("needsNote") &&
      dimensioningSourceQualifierFlags(entry).needsNote &&
      /^notat$/iu.test(normalizedPart)
    ) {
      continue;
    }
    if (normalizedPart) {
      residualParts.push(normalizedPart);
    }
  }

  return {
    priority,
    residual: conflictingPriority
      ? "conflicting-priority"
      : residualParts.join(" "),
  };
}

export function deterministicControlSourceFlags(
  entry: RequirementLedgerEntry,
): DeterministicControlSourceFlags {
  return {
    ...dimensioningSourceQualifierFlags(entry),
    priority: deterministicControlSourceFields(
      entry,
      ALL_DETERMINISTIC_SOURCE_QUALIFIERS,
    ).priority,
  };
}

export function canonicalNoManualSpreadsheetUserGroups(
  entry: RequirementLedgerEntry,
) {
  const requirement = normalizePageText(entry.text);
  const match =
    /^(?:Leverandøren må avklare og beskrive hvordan følgende løses:\s*)?Brukere(?:\s+som\s+(.+?))?\s+skal\s+kunne\s+utføre\s+oppgaver\s+i\s+løsningen\s+uten\s+dobbeltregistrering\s+i\s+manuelle?\s+regneark\.?$/iu.exec(
      requirement,
    );
  if (!match) return null;
  if (!match[1]) return [];
  const groups = match[1]
    .split(/\s*,\s*|\s+(?:og|samt)\s+/iu)
    .map((value) => value.trim())
    .filter(Boolean);
  return groups.length >= 1 &&
    groups.length <= 8 &&
    groups.every(
      (value) =>
        value.length <= 48 &&
        /^[\p{L}][\p{L}-]*(?:\s+[\p{L}][\p{L}-]*){0,2}$/u.test(value),
    )
    ? groups
    : null;
}

function answerBindsEveryNamedNoManualSpreadsheetUser(
  answer: string,
  entry: RequirementLedgerEntry,
) {
  const groups = canonicalNoManualSpreadsheetUserGroups(entry);
  if (!groups?.length) return true;
  const comparableAnswer = normalizeComparableText(answer);
  return groups.every((group) =>
    comparableAnswer.includes(normalizeComparableText(group)),
  );
}
