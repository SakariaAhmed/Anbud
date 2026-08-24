import {
  MAX_CUSTOMER_ANALYSIS_CLARIFICATIONS,
  type CustomerAnalysisResult,
  type CustomerAnalysisSection,
} from "@/lib/types";

const text = { type: "string", minLength: 1 } as const;
const stringArray = (maxItems = 5) => ({
  type: "array",
  items: text,
  maxItems,
});
export const MAX_CUSTOMER_ANALYSIS_PRIORITIZED_REQUIREMENTS = 5;

const implicitRequirement = {
  type: "object",
  additionalProperties: false,
  properties: {
    title: text,
    description: text,
    category: text,
    importance: { enum: ["Kritisk", "Viktig", "Mindre viktig"] },
    kind: { enum: ["Implisitt"] },
    source_reference: text,
    source_excerpt: text,
  },
  required: [
    "title",
    "description",
    "category",
    "importance",
    "kind",
    "source_reference",
    "source_excerpt",
  ],
} as const;

const prioritizedRequirement = {
  type: "object",
  additionalProperties: false,
  properties: {
    requirement: text,
    priority: { enum: ["Kritisk", "Viktig", "Mindre viktig"] },
    reason: text,
  },
  required: ["requirement", "priority", "reason"],
} as const;

const recommendedService = {
  type: "object",
  additionalProperties: false,
  properties: {
    service_id: { type: ["string", "null"] },
    service_name: text,
    usefulness_percent: { type: "integer", minimum: 40, maximum: 100 },
    customer_need: text,
    recommendation_reason: text,
    evidence: text,
    risk_or_caveat: text,
  },
  required: [
    "service_id",
    "service_name",
    "usefulness_percent",
    "customer_need",
    "recommendation_reason",
    "evidence",
    "risk_or_caveat",
  ],
} as const;

const valueOpportunity = {
  type: "object",
  additionalProperties: false,
  properties: {
    title: text,
    description: text,
    value_categories: {
      type: "array",
      minItems: 1,
      maxItems: 1,
      items: {
        enum: [
          "Høyere produktivitet",
          "Lavere kostnader",
          "Redusert risiko",
          "Bedre brukeropplevelse",
        ],
      },
    },
    profit_share_percent: { type: "integer", minimum: 1, maximum: 100 },
  },
  required: [
    "title",
    "description",
    "value_categories",
    "profit_share_percent",
  ],
} as const;

export type CustomerAnalysisModelField = Exclude<
  keyof CustomerAnalysisResult,
  "section_histories" | "signal_word_counts"
>;

type CustomerAnalysisFieldDefinition = {
  schema: Record<string, unknown>;
  fullAnalysis: true;
  regenerate?: CustomerAnalysisSection;
  historySection?: CustomerAnalysisSection;
  fullGuidance?: string[];
};

// Exported as the canonical schema contract for analysis tooling.
// fallow-ignore-next-line unused-export
export const CUSTOMER_ANALYSIS_FIELD_DEFINITIONS = {
  customer_profile_summary: {
    schema: text,
    fullAnalysis: true,
    regenerate: "summary",
    historySection: "summary",
    fullGuidance: [
      "customer_profile_summary og customer_profile dekker kundesituasjon, omfang, interessenter og kjøpsdriver. Bevar alle dokumenterte skalafigurer som lokasjoner, ansatte, brukere og transaksjons-/saksvolum samlet.",
    ],
  },
  customer_goals_summary: {
    schema: text,
    fullAnalysis: true,
    regenerate: "summary",
    historySection: "summary",
    fullGuidance: [
      "customer_goals_summary og customer_goals dekker uttalte mål, ønsket effekt og dokumentert utviklingsretning.",
    ],
  },
  high_level_solution_design: {
    schema: text,
    fullAnalysis: true,
    regenerate: "design",
    historySection: "design",
    fullGuidance: [
      "high_level_solution_design er en tydelig merket anbefaling som svarer på kilden; det er ikke et nytt kundekrav.",
    ],
  },
  high_level_architecture_mermaid: {
    schema: text,
    fullAnalysis: true,
    regenerate: "design",
    historySection: "design",
    fullGuidance: [
      "Mermaid-diagrammet skal være gyldig, enkelt og ha 5–10 high-level noder.",
    ],
  },
  customer_profile: {
    schema: stringArray(),
    fullAnalysis: true,
  },
  customer_goals: {
    schema: stringArray(),
    fullAnalysis: true,
  },
  implicit_requirements: {
    schema: {
      type: "array",
      items: implicitRequirement,
      maxItems: 3,
    },
    fullAnalysis: true,
    regenerate: "needs",
    historySection: "needs",
    fullGuidance: [
      "implicit_requirements: maksimalt 3 viktige underliggende behov; kind skal være Implisitt. Returner færre hvis kilden ikke støtter tre.",
    ],
  },
  prioritized_requirements: {
    schema: {
      type: "array",
      items: prioritizedRequirement,
      maxItems: MAX_CUSTOMER_ANALYSIS_PRIORITIZED_REQUIREMENTS,
    },
    fullAnalysis: true,
    historySection: "needs",
    fullGuidance: [
      "prioritized_requirements: maksimalt 5 styrende eller konkurranseutløsende krav.",
    ],
  },
  ambiguities: {
    schema: stringArray(MAX_CUSTOMER_ANALYSIS_CLARIFICATIONS),
    fullAnalysis: true,
    regenerate: "clarifications",
    historySection: "clarifications",
    fullGuidance: [
      "ambiguities skal inneholde maksimalt 5 konkrete spørsmål, rangert med de mest relevante og konsekvensrike først. Prioriter avklaringer som kan endre omfang, løsningsvalg, risiko, pris eller leveranseevne, og fjern generiske eller overlappende spørsmål.",
      "risks_for_us og risks_for_customer skal ikke blande krav med risiko.",
    ],
  },
  risks: {
    schema: stringArray(6),
    fullAnalysis: true,
    regenerate: "risks",
    historySection: "risks",
    fullGuidance: [
      "risks, risks_for_us og risks_for_customer skal samlet dekke alle eksplisitte avhengigheter som kan påvirke frist, sikkerhet, gevinst eller leveranse. Hvert punkt angir utløser og konsekvens uten duplisering.",
    ],
  },
  risks_for_us: {
    schema: stringArray(6),
    fullAnalysis: true,
    regenerate: "risks",
    historySection: "risks",
  },
  risks_for_customer: {
    schema: stringArray(6),
    fullAnalysis: true,
    regenerate: "risks",
    historySection: "risks",
  },
  likely_evaluation_criteria: {
    schema: stringArray(),
    fullAnalysis: true,
    regenerate: "clarifications",
    historySection: "clarifications",
    fullGuidance: [
      "likely_evaluation_criteria gjengir dokumenterte kriterier og vekter først. Faglig antatte kriterier merkes som tolkning.",
      "Når kilden knytter krav-ID-er til et kriterium, gjengi hele ID-listen uten å utelate eller slå sammen ID-er.",
    ],
  },
  signal_words: {
    schema: stringArray(10),
    fullAnalysis: true,
    regenerate: "keywords",
    historySection: "keywords",
    fullGuidance: [
      "signal_words: bare presise teknologier, standarder, tjenester eller arkitekturkomponenter som kilden faktisk støtter.",
    ],
  },
  expected_solution_direction: {
    schema: stringArray(),
    fullAnalysis: true,
    regenerate: "clarifications",
    historySection: "clarifications",
    fullGuidance: [
      "expected_solution_direction skal svare konkret på de viktigste målene, arkitektur-/integrasjonsbehovene, drifts- og SLA/RCA-modellen samt dokumenterte krav til migrering, akseptanse og kontinuitet.",
    ],
  },
  recommended_services: {
    schema: {
      type: "array",
      items: recommendedService,
      maxItems: 5,
    },
    fullAnalysis: true,
    regenerate: "services",
    historySection: "services",
    fullGuidance: [
      "recommended_services: maksimalt 5, sortert etter usefulness_percent; hver anbefaling trenger kundebehov, evidens og forbehold.",
    ],
  },
  value_opportunities: {
    schema: {
      type: "array",
      items: valueOpportunity,
      minItems: 1,
      maxItems: 4,
    },
    fullAnalysis: true,
    regenerate: "value",
    historySection: "value",
    fullGuidance: [
      "value_opportunities: maksimalt 4, én unik verdikategori per punkt; profit_share_percent er intern analytisk vekting, ikke en kundepåstand, og skal samlet være 100.",
      "Lik prosent på alle verdimuligheter er bare tillatt når kilden faktisk støtter lik betydning. Ellers skal viktigste dokumenterte effekt ha høyest andel.",
    ],
  },
  positioning_recommendations: {
    schema: stringArray(),
    fullAnalysis: true,
    regenerate: "strategy",
    historySection: "strategy",
  },
  executive_summary: {
    schema: text,
    fullAnalysis: true,
    regenerate: "strategy",
    historySection: "strategy",
  },
} as const satisfies Record<
  CustomerAnalysisModelField,
  CustomerAnalysisFieldDefinition
>;

export const CUSTOMER_ANALYSIS_REQUIRED_FIELDS = Object.keys(
  CUSTOMER_ANALYSIS_FIELD_DEFINITIONS,
) as CustomerAnalysisModelField[];

export function buildCustomerAnalysisJsonSchema(
  fields: readonly CustomerAnalysisModelField[] = CUSTOMER_ANALYSIS_REQUIRED_FIELDS,
) {
  return {
    type: "object",
    additionalProperties: false,
    properties: Object.fromEntries(
      fields.map((field) => [
        field,
        CUSTOMER_ANALYSIS_FIELD_DEFINITIONS[field].schema,
      ]),
    ),
    required: [...fields],
  };
}

export function buildCustomerAnalysisFieldGuidance() {
  const promptOrder: CustomerAnalysisModelField[] = [
    "customer_profile_summary",
    "customer_goals_summary",
    "high_level_solution_design",
    "ambiguities",
    "likely_evaluation_criteria",
    "implicit_requirements",
    "prioritized_requirements",
    "value_opportunities",
    "recommended_services",
    "signal_words",
    "high_level_architecture_mermaid",
  ];
  return promptOrder.flatMap(
    (field) =>
      (
        CUSTOMER_ANALYSIS_FIELD_DEFINITIONS[
          field
        ] as CustomerAnalysisFieldDefinition
      ).fullGuidance ?? [],
  );
}

// Exported for section-regeneration contract tests.
// fallow-ignore-next-line unused-export
export function sectionFieldNames(section: CustomerAnalysisSection) {
  return CUSTOMER_ANALYSIS_REQUIRED_FIELDS.filter(
    (field) =>
      (
        CUSTOMER_ANALYSIS_FIELD_DEFINITIONS[
          field
        ] as CustomerAnalysisFieldDefinition
      ).regenerate === section,
  );
}

const regenerationSections: Record<
  CustomerAnalysisSection,
  { label: string; guidance: string[] }
> = {
  summary: {
    label: "Oppsummering",
    guidance: [
      "Rediger kun lederoppsummeringen av kunden.",
      "customer_profile_summary skal forklare kundesituasjonen, modenhet, rammer og relevant kontekst.",
      "customer_goals_summary skal forklare kundens mål, ønsket effekt og utviklingsretning.",
    ],
  },
  strategy: {
    label: "Strategi",
    guidance: [
      "Rediger kun tilbudsteamets operative strategi og anbefalte posisjonering.",
      "executive_summary skal være arbeidsteksten som brukes videre i tilbudet.",
      "positioning_recommendations skal være konkrete anbefalinger til hvordan tilbudet bør spisses.",
    ],
  },
  clarifications: {
    label: "Avklaringer",
    guidance: [
      "Rediger kun avklaringer og foreløpig retning mellom strategi og design.",
      "ambiguities skal være maksimalt 5 konkrete åpne spørsmål, rangert med de mest relevante og konsekvensrike først.",
      "Prioriter spørsmål som kan endre omfang, løsningsvalg, risiko, pris eller leveranseevne. Fjern generiske og overlappende spørsmål.",
      "expected_solution_direction skal beskrive retningen kildene peker mot før endelig design.",
      "likely_evaluation_criteria skal gjengi dokumenterte kriterier og vekter før faglige tolkninger.",
    ],
  },
  design: {
    label: "Design",
    guidance: [
      "Rediger kun anbefalt high-level design og arkitekturdiagram.",
      "high_level_solution_design skal være en konkret, erfaren skyarkitekt-anbefaling.",
      "high_level_architecture_mermaid skal være ren Mermaid-kode som starter med flowchart eller graph.",
    ],
  },
  risks: {
    label: "Risiko",
    guidance: [
      "Rediger kun risiko og usikkerhet.",
      "risks_for_us beskriver leverandørens og tilbudsteamets risiko.",
      "risks_for_customer beskriver kundens drifts-, sikkerhets-, overgangs-, kostnads- og etterlevelsesrisiko.",
      "risks skal være en kort samlet kompatibilitetsliste basert på de to delte feltene.",
    ],
  },
  needs: {
    label: "Behov",
    guidance: [
      "Rediger kun underliggende behov og implisitte krav.",
      "Returner inntil 3 viktige, tekstnære tolkninger. Ikke fyll listen uten kildestøtte.",
      "Ikke inkluder eksplisitte krav som bare hører hjemme i kravlisten.",
    ],
  },
  keywords: {
    label: "Nøkkelord",
    guidance: [
      "Rediger kun gjenbrukte nøkkelord.",
      "Bruk konkrete teknologier, standarder, tjenester eller arkitekturkomponenter som kilden støtter.",
      "Utelat dokumenttitler, kravnumre og generiske plattform- eller konsulentord.",
    ],
  },
  services: {
    label: "Anbefalte tjenester",
    guidance: [
      "Rediger kun anbefalte tjenester.",
      "Anbefal bare tjenester fra kandidatlisten, og returner [] når ingen passer.",
      "Sorter etter usefulness_percent synkende. Hver anbefaling trenger kundebehov, evidens og forbehold.",
    ],
  },
  value: {
    label: "Verdi",
    guidance: [
      "Rediger kun verdimuligheter.",
      "Bruk hver verdikategori maksimalt én gang og ikke kombiner kategorier i samme punkt.",
      "Fordel profit_share_percent til 100 basert på dokumenterte signaler, ikke en pen standardfordeling.",
    ],
  },
};

export function customerAnalysisRegenerationContract(
  section: CustomerAnalysisSection,
) {
  const fields = sectionFieldNames(section);
  return {
    ...regenerationSections[section],
    fields,
    schema: buildCustomerAnalysisJsonSchema(fields),
  };
}

export function mergeCustomerAnalysisSectionPatch(input: {
  analysis: CustomerAnalysisResult;
  section: CustomerAnalysisSection;
  patch: Partial<CustomerAnalysisResult>;
}) {
  const merged: Record<string, unknown> = { ...input.analysis };
  const patch: Record<string, unknown> = input.patch;
  for (const field of sectionFieldNames(input.section)) {
    if (Object.hasOwn(patch, field)) {
      merged[field] = patch[field];
    }
  }
  return merged as unknown as CustomerAnalysisResult;
}
