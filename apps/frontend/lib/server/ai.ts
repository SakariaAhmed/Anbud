import "server-only";

import OpenAI from "openai";

import { BidCustomerAnalysis, ComplianceStatus, RequirementType } from "@/lib/types";

export interface RequirementSuggestion {
  code: string;
  category: string;
  requirement_type: RequirementType;
  scope_summary: string;
  source_reference: string;
  source_excerpt: string;
}

export interface ComplianceSuggestion {
  requirement_code: string;
  status: ComplianceStatus;
  found_in: string | null;
  answer_excerpt: string;
  notes: string;
}

let cachedClient: OpenAI | null | undefined;

function getOpenAiApiKey(): string {
  return process.env.OPENAI_API_KEY ?? "";
}

function getOpenAiModel(): string {
  return process.env.OPENAI_MODEL ?? "gpt-5-mini";
}

function buildPromptTemplate(input: {
  role: string;
  task: string[];
  rules: string[];
  outputContract: string[];
  exampleOutput: string;
}) {
  return [
    "### Role",
    input.role,
    "",
    "### Task",
    ...input.task,
    "",
    "### Rules",
    ...input.rules.map((rule) => `- ${rule}`),
    "",
    "### Output contract",
    ...input.outputContract.map((rule) => `- ${rule}`),
    "",
    "### Example output",
    input.exampleOutput,
  ].join("\n");
}

function buildDelimitedContext(label: string, content: string) {
  return `### ${label}\n"""\n${content.trim()}\n"""`;
}

function buildRequirementExtractionPrompt() {
  return buildPromptTemplate({
    role: "Du er en nøktern dokumentanalytiker for anbuds- og compliance-arbeid.",
    task: [
      "Les Bilag 1 og identifiser konkrete krav som leverandøren må eller bør besvare.",
      "Trekk ut én rad per selvstendig krav.",
      "Bruk kildehenvisningen som finnes i dokumentet, for eksempel side- eller seksjonsmarkører.",
    ],
    rules: [
      "Instruksjoner kommer først og dokumentkontekst kommer separat i brukerinnholdet.",
      "Trekk bare ut eksplisitte krav. Ikke lag krav av overskrifter eller generell bakgrunnstekst.",
      "Ikke trekk ut metadatafelt eller etiketter som egne krav, for eksempel linjer som bare sier Type, Kategori, Status, Referanse, Ref., Kilde eller Bilag.",
      "Ikke trekk ut rene tabellceller, korte etiketter eller formatlinjer som ikke inneholder et selvstendig krav.",
      "Sett requirement_type til Må for obligatoriske krav og Bør for anbefalte eller ønskede krav.",
      "Hvis kilde ikke kan bestemmes sikkert, bruk tom streng i source_reference.",
      "Returner tom liste hvis ingen krav kan identifiseres, i stedet for å gjette.",
      "Svar kun i gyldig JSON som matcher output-kontrakten.",
    ],
    outputContract: [
      "Returner ett JSON-objekt med nøkkelen requirements.",
      "Hver requirement skal ha feltene category, requirement_type, scope_summary, source_reference og source_excerpt.",
      'category skal være en kort kategori som "Sikkerhet", "Drift", "Server", "Nettverk", "Tjeneste" eller "Generelt".',
      'requirement_type skal være enten "Må" eller "Bør".',
    ],
    exampleOutput:
      '{"requirements":[{"category":"Sikkerhet","requirement_type":"Må","scope_summary":"Leverandør skal dokumentere ISO 27001-sertifisering","source_reference":"Bilag 1 – side 14","source_excerpt":"Leverandør skal dokumentere ISO 27001-sertifisering."}]}',
  });
}

function buildCustomerAnalysisPrompt() {
  return buildPromptTemplate({
    role: "Du er en nøktern dokumentanalytiker for anbuds- og compliance-arbeid.",
    task: [
      "Les Bilag 1 og lag en kort kundeanalyse for en skyarkitekt som skal forstå hva som betyr mest.",
      "Analyser kun det som er støttet av dokumentet.",
      "Prioriter innsikt som hjelper brukeren å svare presist og avdekke uklarheter.",
    ],
    rules: [
      "Returner konkrete punkter, ikke lange avsnitt.",
      "Hvis konteksten er svak, returner færre punkter i stedet for å spekulere.",
      "Bruk positive instrukser ved usikkerhet: velg tom liste fremfor antagelser.",
      "Svar kun i gyldig JSON som matcher output-kontrakten.",
    ],
    outputContract: [
      "Returner ett JSON-objekt med nøklene customer_priorities, clarifications og value_angles.",
      "Alle tre feltene skal være lister med korte tekstpunkter.",
      "Hver liste skal ha 0 til 6 punkter.",
    ],
    exampleOutput:
      '{"customer_priorities":["Høy driftssikkerhet for kritiske tjenester"],"clarifications":["Avklar om kunden krever dedikert driftsmodell eller standardisert AMS-tjeneste"],"value_angles":["Vektlegg standardisering, sikkerhet og lavere driftskostnad"]}',
  });
}

function buildCompliancePrompt() {
  return buildPromptTemplate({
    role: "Du er en nøktern dokumentanalytiker for anbuds- og compliance-arbeid.",
    task: [
      "Sammenlign kravene fra Bilag 1 med innholdet i Bilag 2.",
      "Klassifiser hvert krav som Besvart, Delvis besvart eller Ikke besvart.",
      "Oppgi hvor i Bilag 2 svaret finnes når dokumentet gir en tydelig seksjons- eller kapittelreferanse.",
    ],
    rules: [
      "Bruk bare kravene og Bilag 2-konteksten som er gitt.",
      "Hvis svarmatching er svak eller indirekte, bruk Delvis besvart eller Ikke besvart. Ikke gjett.",
      "Hvis found_in ikke kan bestemmes, bruk null.",
      "Hvis answer_excerpt ikke kan trekkes ut pålitelig, bruk tom streng.",
      "Returner én rad per kravkode som ble gitt i inputen.",
      "Svar kun i gyldig JSON som matcher output-kontrakten.",
    ],
    outputContract: [
      "Returner ett JSON-objekt med nøkkelen compliance_matrix.",
      "Hver rad skal ha requirement_code, status, found_in, answer_excerpt og notes.",
      'status skal være enten "Besvart", "Delvis besvart" eller "Ikke besvart".',
    ],
    exampleOutput:
      '{"compliance_matrix":[{"requirement_code":"Krav 17","status":"Besvart","found_in":"Bilag 2 – kapittel 3.2","answer_excerpt":"Atea AMS leverer standardisert driftsovervåking og hendelseshåndtering.","notes":"Svaret dekker hovedkravet direkte."}]}',
  });
}

function getClient(): OpenAI | null {
  if (cachedClient !== undefined) {
    return cachedClient;
  }

  const apiKey = getOpenAiApiKey();
  cachedClient = apiKey ? new OpenAI({ apiKey }) : null;
  return cachedClient;
}

function safeJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function normalizeText(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }

  return value.replace(/\s+/g, " ").trim();
}

function normalizeRequirementType(value: unknown): RequirementType {
  return value === "Bør" ? "Bør" : "Må";
}

function normalizeComplianceStatus(value: unknown): ComplianceStatus {
  if (value === "Besvart" || value === "Delvis besvart" || value === "Ikke besvart") {
    return value;
  }

  return "Ikke besvart";
}

function normalizeList(values: unknown): string[] {
  if (!Array.isArray(values)) {
    return [];
  }

  return values
    .map((value) => normalizeText(value))
    .filter(Boolean)
    .slice(0, 6);
}

function isMetadataOnlyLine(text: string) {
  const value = normalizeText(text).toLowerCase();
  if (!value) {
    return true;
  }

  return /^(type|kravtype|kategori|status|ref\.?|referanse|kilde|kildegrunnlag|funnet i dokument|bilag)\s*:\s*\S+/.test(
    value
  );
}

function isValidRequirementCandidate(text: string) {
  const value = normalizeText(text);
  if (!value) {
    return false;
  }

  if (value.length < 20) {
    return false;
  }

  if (isMetadataOnlyLine(value)) {
    return false;
  }

  return /(skal|må|bør|must|shall|required|should)/i.test(value);
}

function inferCategory(text: string) {
  const value = text.toLowerCase();
  if (/(iso|security|sikkerhet|iam|identitet|mfa|zero trust|krypter)/.test(value)) return "Sikkerhet";
  if (/(server|compute|vm|lagring|storage|backup)/.test(value)) return "Server";
  if (/(drift|support|incident|overvåk|managed|ams|sla)/.test(value)) return "Drift";
  if (/(nettverk|network|firewall|vpn|wan|lan)/.test(value)) return "Nettverk";
  if (/(tidslinje|deadline|frist|milepæl|kapittel)/.test(value)) return "Tidsplan";
  if (/(pris|commercial|kommersiell|kostnad)/.test(value)) return "Kommersielt";
  return "Generelt";
}

function tokenizeRequirement(text: string) {
  return Array.from(new Set(text.toLowerCase().match(/[a-zæøå0-9]{4,}/gi) ?? [])).slice(0, 8);
}

function buildFallbackRequirements(text: string): RequirementSuggestion[] {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const results: RequirementSuggestion[] = [];
  let currentReference = "";

  for (const line of lines) {
    if (line.startsWith("[[SIDE:")) {
      const page = line.match(/\[\[SIDE:(\d+)\]\]/)?.[1];
      currentReference = page ? `Bilag 1 – side ${page}` : "";
      continue;
    }

    if (/^(kapittel|section|del|vedlegg)\b/i.test(line) || /^\d+(\.\d+)*\s+\S+/.test(line)) {
      currentReference = line;
      continue;
    }

    if (!isValidRequirementCandidate(line)) {
      continue;
    }

    const requirementType: RequirementType = /(bør|should)/i.test(line) && !/(skal|must|shall|required)/i.test(line) ? "Bør" : "Må";
    results.push({
      code: `Krav ${results.length + 1}`,
      category: inferCategory(line),
      requirement_type: requirementType,
      scope_summary: line.slice(0, 240),
      source_reference: currentReference,
      source_excerpt: line.slice(0, 500),
    });

    if (results.length >= 40) {
      break;
    }
  }

  return results;
}

function buildFallbackCustomerAnalysis(text: string): BidCustomerAnalysis {
  const lowered = text.toLowerCase();
  const priorities: string[] = [];
  const clarifications: string[] = [];
  const valueAngles: string[] = [];

  if (/(sikkerhet|iso|compliance|mfa|krypter)/.test(lowered)) {
    priorities.push("Kunden legger tydelig vekt på sikkerhet og etterlevelse.");
    valueAngles.push("Vektlegg sikkerhetskontroller, standardisering og dokumentert etterlevelse.");
  }
  if (/(drift|ams|support|overvåk|incident|sla)/.test(lowered)) {
    priorities.push("Kunden forventer stabil drift og tydelig operasjonell leveranse.");
    valueAngles.push("Vis hvordan standardisert drift kan redusere risiko og øke forutsigbarhet.");
  }
  if (/(kostnad|pris|effektiv|optimalisering)/.test(lowered)) {
    priorities.push("Kunden er opptatt av kostnadskontroll og effektiv leveranse.");
    valueAngles.push("Knytt svaret til produktivitet, standardisering og kostnadsbesparelse.");
  }

  clarifications.push("Avklar hvilke deler av leveransen som er absolutte minstekrav versus ønskede tillegg.");
  if (/(kapittel|vedlegg|bilag)/.test(lowered)) {
    clarifications.push("Bekreft om det finnes vedlegg eller referansedokumenter som påvirker kravtolkningen.");
  }

  return {
    customer_priorities: priorities.slice(0, 6),
    clarifications: clarifications.slice(0, 6),
    value_angles: valueAngles.slice(0, 6),
    generated_at: new Date().toISOString(),
  };
}

function buildFallbackCompliance(requirements: RequirementSuggestion[], bilag2Text: string): ComplianceSuggestion[] {
  const lowered = bilag2Text.toLowerCase();
  const lines = bilag2Text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  return requirements.map((requirement) => {
    const tokens = tokenizeRequirement(requirement.scope_summary);
    const matches = lines.filter((line) =>
      tokens.some((token) => line.toLowerCase().includes(token.toLowerCase()))
    );
    const coverage = tokens.filter((token) => lowered.includes(token.toLowerCase())).length;

    let status: ComplianceStatus = "Ikke besvart";
    if (coverage >= Math.max(2, Math.ceil(tokens.length * 0.6)) && matches.length) {
      status = "Besvart";
    } else if (coverage >= 1 && matches.length) {
      status = "Delvis besvart";
    }

    const foundIn = matches.find((line) => /^(kapittel|section|del)\b/i.test(line)) ?? null;
    return {
      requirement_code: requirement.code,
      status,
      found_in: foundIn,
      answer_excerpt: matches[0]?.slice(0, 500) ?? "",
      notes:
        status === "Besvart"
          ? "Fallback-vurdering basert på tydelig teksttreff i Bilag 2."
          : status === "Delvis besvart"
            ? "Fallback-vurdering basert på svake eller indirekte teksttreff i Bilag 2."
            : "Ingen tydelige teksttreff funnet i Bilag 2.",
    };
  });
}

async function createJsonCompletion(systemPrompt: string, userContext: string) {
  const client = getClient();
  if (!client) {
    return null;
  }

  const completion = await client.chat.completions.create({
    model: getOpenAiModel(),
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: systemPrompt,
      },
      {
        role: "user",
        content: userContext,
      },
    ],
  });

  return completion.choices[0]?.message?.content ?? "{}";
}

export async function extractRequirementsFromBilag1(rawText: string): Promise<RequirementSuggestion[]> {
  const text = rawText.trim();
  if (!text) {
    return [];
  }

  const userContext = [
    "Trekk ut krav fra følgende Bilag 1.",
    buildDelimitedContext("Context", text.slice(0, 48000)),
  ].join("\n\n");

  try {
    const raw = await createJsonCompletion(buildRequirementExtractionPrompt(), userContext);
    if (!raw) {
      return buildFallbackRequirements(text);
    }

    const payload = safeJson<{ requirements?: Array<Record<string, unknown>> }>(raw, {});
    const items = Array.isArray(payload.requirements) ? payload.requirements : [];

    return items
      .map((item, index) => ({
        code: `Krav ${index + 1}`,
        category: normalizeText(item.category) || "Generelt",
        requirement_type: normalizeRequirementType(item.requirement_type),
        scope_summary: normalizeText(item.scope_summary).slice(0, 240),
        source_reference: normalizeText(item.source_reference).slice(0, 120),
        source_excerpt: normalizeText(item.source_excerpt).slice(0, 500),
      }))
      .filter((item) => isValidRequirementCandidate(item.scope_summary))
      .slice(0, 50);
  } catch {
    return buildFallbackRequirements(text);
  }
}

export async function createCustomerAnalysis(rawText: string): Promise<BidCustomerAnalysis> {
  const text = rawText.trim();
  if (!text) {
    return {
      customer_priorities: [],
      clarifications: [],
      value_angles: [],
      generated_at: new Date().toISOString(),
    };
  }

  const userContext = [
    "Lag en kundeanalyse basert på følgende Bilag 1.",
    buildDelimitedContext("Context", text.slice(0, 48000)),
  ].join("\n\n");

  try {
    const raw = await createJsonCompletion(buildCustomerAnalysisPrompt(), userContext);
    if (!raw) {
      return buildFallbackCustomerAnalysis(text);
    }

    const payload = safeJson<Record<string, unknown>>(raw, {});
    return {
      customer_priorities: normalizeList(payload.customer_priorities),
      clarifications: normalizeList(payload.clarifications),
      value_angles: normalizeList(payload.value_angles),
      generated_at: new Date().toISOString(),
    };
  } catch {
    return buildFallbackCustomerAnalysis(text);
  }
}

export async function matchBilag2AgainstRequirements(
  requirements: RequirementSuggestion[],
  bilag2Text: string
): Promise<ComplianceSuggestion[]> {
  const text = bilag2Text.trim();
  if (!requirements.length) {
    return [];
  }

  if (!text) {
    return requirements.map((requirement) => ({
      requirement_code: requirement.code,
      status: "Ikke besvart",
      found_in: null,
      answer_excerpt: "",
      notes: "Bilag 2 er ikke lastet opp.",
    }));
  }

  const requirementsJson = JSON.stringify(
    requirements.map((requirement) => ({
      requirement_code: requirement.code,
      category: requirement.category,
      requirement_type: requirement.requirement_type,
      scope_summary: requirement.scope_summary,
      source_reference: requirement.source_reference,
    }))
  );

  const userContext = [
    "Vurder kravene opp mot følgende Bilag 2.",
    buildDelimitedContext("Requirements", requirementsJson),
    buildDelimitedContext("Context", text.slice(0, 48000)),
  ].join("\n\n");

  try {
    const raw = await createJsonCompletion(buildCompliancePrompt(), userContext);
    if (!raw) {
      return buildFallbackCompliance(requirements, text);
    }

    const payload = safeJson<{ compliance_matrix?: Array<Record<string, unknown>> }>(raw, {});
    const items = Array.isArray(payload.compliance_matrix) ? payload.compliance_matrix : [];

    return items.map((item) => ({
      requirement_code: normalizeText(item.requirement_code),
      status: normalizeComplianceStatus(item.status),
      found_in: normalizeText(item.found_in) || null,
      answer_excerpt: normalizeText(item.answer_excerpt).slice(0, 500),
      notes: normalizeText(item.notes).slice(0, 280),
    }));
  } catch {
    return buildFallbackCompliance(requirements, text);
  }
}
