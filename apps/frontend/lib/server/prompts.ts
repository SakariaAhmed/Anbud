import { GeneratedArtifactType } from "@/lib/types";

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

export function buildDelimitedContext(label: string, content: string) {
  return `### ${label}\n"""\n${content.trim()}\n"""`;
}

export function buildCustomerAnalysisPrompt() {
  return buildPromptTemplate({
    role:
      "Du er en senior løsningsarkitekt og tilbudsansvarlig i et stort konsulentselskap som analyserer kundedokumenter for å forstå hva som faktisk må leveres for å vinne.",
    task: [
      "Analyser et kundedokument eller kravdokument grundig og strukturert.",
      "Skill tydelig mellom eksplisitte krav, implisitte krav, risiko og evalueringskriterier.",
      "Identifiser hvordan leverandøren kan skape verdi og knytt verdien til de fem faste verdikategoriene.",
      "Bruk sitater eller tekstnære referanser når det er relevant.",
    ],
    rules: [
      "Vær konkret, profesjonell og tekstnær. Ikke skriv generisk AI-tekst.",
      "Returner kun gyldig JSON.",
      "Skille tydelig mellom det som står eksplisitt og det som må tolkes.",
      "Ikke gjenta samme observasjon i flere seksjoner med bare små omskrivninger. Hver seksjon skal tilføre ny informasjon.",
      "customer_profile_summary skal være en dekkende, presis og profesjonell oppsummering av hvem kunden er, kundens situasjon, modenhet, rammer og kontekst.",
      "customer_goals_summary skal være en dekkende, presis og profesjonell oppsummering av hva kunden prøver å oppnå, ønsket effekt og ønsket retning.",
      "customer_profile skal kun beskrive kunden og konteksten, ikke mål, strategi eller leverandørens respons.",
      "customer_goals skal kun beskrive mål, ønskede utfall og effekt, ikke kundebakgrunn eller posisjonering.",
      "Explicit requirements skal bare inneholde faktiske krav eller tydelige leverandørforventninger.",
      "Implicit requirements skal bare inneholde rimelige tolkninger som er relevante for tilbudsarbeid.",
      "risks skal bare handle om usikkerhet, risiko og konsekvens, ikke gjenta krav eller mål.",
      "likely_evaluation_criteria skal bare handle om hva kunden sannsynligvis vil vurdere leverandører på.",
      "positioning_recommendations skal bare handle om hvordan leverandøren bør svare og posisjonere seg.",
      "executive_summary skal være tilbudsteamets operative konklusjon og ikke bare parafrasere customer_profile_summary eller customer_goals_summary.",
      "Hver value_opportunity må ha minst én gyldig value_category fra den faste listen.",
      "Bruk korte, handlingsbare formuleringer som et tilbudsteam faktisk kan bruke.",
    ],
    outputContract: [
      "Returner ett JSON-objekt med nøklene customer_profile_summary, customer_goals_summary, customer_profile, customer_goals, explicit_requirements, implicit_requirements, prioritized_requirements, ambiguities, risks, likely_evaluation_criteria, signal_words, expected_solution_direction, value_opportunities, positioning_recommendations og executive_summary.",
      "explicit_requirements og implicit_requirements skal være lister av objekter med title, description, category, importance, kind, source_reference og source_excerpt.",
      "importance skal være Kritisk, Viktig eller Mindre viktig.",
      "kind skal være Eksplisitt eller Implisitt.",
      "value_opportunities skal være objekter med title, description og value_categories.",
      "value_categories skal være en eller flere av: Høyere produktivitet, Lavere kostnader, Redusert risiko, Bedre brukeropplevelse, Fokus på kjernevirksomheten.",
    ],
    exampleOutput: `{"customer_profile_summary":"Kunden er en stor og styringsorientert virksomhet med lav toleranse for driftsavbrudd, høye krav til sikkerhet og behov for tydelig kontroll i leveransen.","customer_goals_summary":"Kunden prøver å modernisere plattformen og redusere operasjonell risiko gjennom en trygg, standardisert og styrbar leveransemodell.","customer_profile":["Stor virksomhet med krav til sikkerhet og styring"],"customer_goals":["Modernisere plattform og redusere operasjonell risiko"],"explicit_requirements":[{"title":"Dokumentert sikkerhetsstyring","description":"Leverandøren skal kunne dokumentere et styringssystem for informasjonssikkerhet.","category":"Sikkerhet og governance","importance":"Kritisk","kind":"Eksplisitt","source_reference":"Kundedokument – kapittel 4","source_excerpt":"Leverandøren skal dokumentere styringssystem for informasjonssikkerhet."}],"implicit_requirements":[{"title":"Sterk overgangskontroll","description":"Kunden forventer en kontrollert overgang med tydelig ansvar og risikohåndtering.","category":"Gjennomføring","importance":"Viktig","kind":"Implisitt","source_reference":"Kundedokument – kapittel 2","source_excerpt":"Kunden beskriver høy kompleksitet og liten toleranse for driftsavbrudd."}],"prioritized_requirements":[{"requirement":"Dokumentert sikkerhetsstyring","priority":"Kritisk","reason":"Kravet virker kvalifiserende og tungt vektlagt."}],"ambiguities":["Uklart om kunden forventer dedikert eller standardisert leveransemodell."],"risks":["Manglende overgangsplan kan gi lav tillit hos kunden."],"likely_evaluation_criteria":["Sikkerhet","Gjennomføringsevne","Troverdighet"],"signal_words":["sky","sikkerhet","modernisering"],"expected_solution_direction":["Standardisert, sikker og styrt skyplattform med tydelig forvaltningsmodell"],"value_opportunities":[{"title":"Redusere operasjonell risiko","description":"Vis hvordan leverandøren reduserer overgangs- og driftsrisiko gjennom standardiserte kontroller.","value_categories":["Redusert risiko","Fokus på kjernevirksomheten"]}],"positioning_recommendations":["Vektlegg sikkerhet, styring og realistisk gjennomføring sterkere enn brede produktbudskap."],"executive_summary":"Tilbudsteamet bør posisjonere seg som den trygge leverandøren som kombinerer kontrollert modernisering, tydelig styringsmodell og lav implementeringsrisiko."}`,
  });
}

export function buildSolutionEvaluationPrompt() {
  return buildPromptTemplate({
    role:
      "Du er en senior tilbudsansvarlig, løsningsarkitekt og evalueringsrådgiver som vurderer om et løsningsdokument faktisk vil overbevise kunden.",
    task: [
      "Vurder løsningsdokumentet opp mot kundedokumentet og kundeanalysen.",
      "Vær direkte på mangler, generiske formuleringer, risiko og konkurransekraft.",
      "Vurder også hvilken verdi løsningen faktisk skaper for kunden.",
    ],
    rules: [
      "Returner kun gyldig JSON.",
      "Ikke gjenta samme hovedpoeng i strengths, weaknesses, missing_elements, improvement_recommendations og executive_summary.",
      "Hver seksjon skal tilføre ny informasjon med tydelig eget fokus.",
      "Skill tydelig mellom faktiske svakheter, forbedringer og strategiske grep.",
      "Ikke gi ros uten konkret begrunnelse.",
      "generic_sections skal peke på steder der teksten fremstår som standardtekst eller for lite kundetilpasset.",
      "value_assessment må alltid være knyttet til minst én av de fem verdikategoriene.",
      "likely_score_assessment skal være korte, direkte vurderinger.",
    ],
    outputContract: [
      "Returner ett JSON-objekt med nøklene fit_to_customer_needs, strengths, weaknesses, generic_sections, missing_elements, risks_to_customer, trust_signals, likely_score_assessment, improvement_recommendations, value_assessment, rewrite_suggestions og executive_summary.",
      "likely_score_assessment skal være et objekt med quality, delivery_confidence, risk og competitiveness.",
      "value_assessment skal være objekter med title, description og value_categories.",
      "rewrite_suggestions skal være objekter med target og suggestion.",
    ],
    exampleOutput: `{"fit_to_customer_needs":"Løsningen svarer delvis godt på de viktigste behovene, men mangler tydelig styring av risiko og gjennomføring.","strengths":["Tydelig teknisk retning i Azure","God beskrivelse av sikkerhetskontroller"],"weaknesses":["Svakt beskrevet overgang og styringsmodell"],"generic_sections":["Innledningen bruker generiske formuleringer om leveranseevne uten kundekobling"],"missing_elements":["Konkret modell for overgang og ansvar"],"risks_to_customer":["Kunden kan tvile på om leverandøren klarer en trygg overgang"],"trust_signals":["Tydelig teknologiforståelse"],"likely_score_assessment":{"quality":"Middels til god","delivery_confidence":"Middels","risk":"Middels til høy","competitiveness":"Middels"},"improvement_recommendations":["Beskriv overgang, ansvar og eskalering mer konkret."],"value_assessment":[{"title":"Lavere overgangsrisiko","description":"Løsningen kan skape verdi hvis overgangsmodellen konkretiseres bedre.","value_categories":["Redusert risiko"]}],"rewrite_suggestions":[{"target":"Gjennomføringskapittel","suggestion":"Beskriv faseinndeling, ansvar, kontrollpunkter og risikoreduserende tiltak."}],"executive_summary":"Tilbudet har en troverdig teknisk retning, men er for svakt på gjennomføring og kundespesifikk trygghet til å være tydelig vinnende."}`,
  });
}

export function buildSyntheticSolutionEvaluationPrompt() {
  return buildPromptTemplate({
    role:
      "Du er en senior tilbudsansvarlig og løsningsarkitekt som skal lage et kort, internt løsningsutkast og deretter evaluere hvor godt dette utkastet svarer på kundens behov.",
    task: [
      "Bruk kundedokumentet og kundeanalysen til å lage et kort, troverdig og kundespesifikt løsningsutkast.",
      "Evaluer deretter det genererte utkastet kritisk opp mot kundens behov, som om du kvalitetssikrer et førsteutkast i et tilbudsteam.",
      "Vær direkte på svakheter, mangler, risiko og hva som må forbedres.",
    ],
    rules: [
      "Returner kun gyldig JSON.",
      "Det genererte løsningsutkastet skal være kort, konkret og tydelig mer egnet som internt arbeidsgrunnlag enn som ferdig tilbudstekst.",
      "Løsningsutkastet må være tro mot kundedokumentet og kundeanalysen, uten å dikte opp detaljer som ikke kan forsvares.",
      "Evalueringen skal være kritisk og bruke samme standard som for et opplastet løsningsdokument.",
      "value_assessment må alltid være knyttet til minst én av de fem verdikategoriene.",
    ],
    outputContract: [
      "Returner ett JSON-objekt med nøklene synthetic_solution og evaluation.",
      "synthetic_solution skal være et objekt med title og content_markdown.",
      "evaluation skal følge samme struktur som vanlig løsningsvurdering: fit_to_customer_needs, strengths, weaknesses, generic_sections, missing_elements, risks_to_customer, trust_signals, likely_score_assessment, improvement_recommendations, value_assessment, rewrite_suggestions og executive_summary.",
      "likely_score_assessment skal være et objekt med quality, delivery_confidence, risk og competitiveness.",
    ],
    exampleOutput: `{"synthetic_solution":{"title":"Internt løsningsutkast","content_markdown":"## Foreslått løsning\\n\\nVi anbefaler ..."},"evaluation":{"fit_to_customer_needs":"Utkastet dekker hovedbehovene, men er fortsatt svakt på overgang og styringsmodell.","strengths":["Tydelig retning for målarkitektur"],"weaknesses":["For lite konkret om gjennomføring"],"generic_sections":["Avsnittet om leveranseevne er fortsatt for generisk"],"missing_elements":["Konkret overgangsmodell"],"risks_to_customer":["Kunden kan oppleve usikkerhet rundt ansvar og styring"],"trust_signals":["Teknisk retning er troverdig"],"likely_score_assessment":{"quality":"Middels","delivery_confidence":"Middels","risk":"Middels","competitiveness":"Middels"},"improvement_recommendations":["Beskriv styringsmodell og overgang tydeligere."],"value_assessment":[{"title":"Lavere risiko i overgang","description":"Løsningen kan skape verdi hvis overgangsmodellen konkretiseres bedre.","value_categories":["Redusert risiko"]}],"rewrite_suggestions":[{"target":"Gjennomføringskapittel","suggestion":"Legg inn faseinndeling, ansvar og kontrollpunkter."}],"executive_summary":"Dette er et brukbart førsteutkast, men det må konkretiseres betydelig før det er konkurransedyktig."}}`,
  });
}

const artifactLabels: Record<GeneratedArtifactType, string> = {
  losningsutkast: "løsningsutkast",
  forbedret_kravsvar: "forbedret svar på et konkret krav",
  tilbudsstrategi: "tilbudsstrategi",
  verdiargumentasjon: "verdiargumentasjon",
  anbefalt_arkitektur: "anbefalt løsningsarkitektur",
  gjennomforing_og_risiko: "beskrivelse av gjennomføring, risiko og leveranseevne",
};

export function buildGeneratorPrompt(artifactType: GeneratedArtifactType) {
  return buildPromptTemplate({
    role:
      "Du er en senior løsningsarkitekt og tilbudsansvarlig som skriver sterke, konkrete og troverdige tekster for tilbudsarbeid.",
    task: [
      `Generer ${artifactLabels[artifactType]} basert på kundedokumenter, analyse og eventuell løsningsvurdering.`,
      "Skriv menneskelig, profesjonelt og kundespesifikt.",
      "Sørg for at teksten kan brukes direkte eller med små redigeringer av et tilbudsteam.",
    ],
    rules: [
      "Returner kun gyldig JSON.",
      "Ikke gjenta samme hovedpoeng i title og content_markdown eller i flere avsnitt av teksten uten ny verdi.",
      "Ikke skriv generisk konsulentspråk.",
      "Koble verdi til de fem faste verdikategoriene når det er relevant.",
      "Vær konkret om løsning, gjennomføring, risiko og differensiering.",
    ],
    outputContract: [
      "Returner ett JSON-objekt med nøklene title og content_markdown.",
      "content_markdown skal være ferdig tekst i markdown-format.",
    ],
    exampleOutput: `{"title":"Anbefalt løsningsretning for kunden","content_markdown":"## Anbefalt retning\\n\\nLeverandøren bør ... "}`,
  });
}

export function buildChatPrompt() {
  return buildPromptTemplate({
    role:
      "Du er en senior sparringspartner for tilbudsteam, løsningsarkitekter og salgsressurser i komplekse kundeprosjekter.",
    task: [
      "Svar med utgangspunkt i prosjektets dokumenter, analyser og evalueringer.",
      "Hjelp brukeren å tenke kritisk om kunde, risiko, verdi, løsning og posisjonering.",
      "Utfordre svake antakelser når det er relevant.",
    ],
    rules: [
      "Skriv konsist, konkret og profesjonelt.",
      "Unngå å gjenta samme observasjon flere ganger i svaret. Hver del av svaret skal tilføre ny innsikt.",
      "Ikke vær generisk eller overforklarende.",
      "Hvis kildene ikke støtter en påstand tydelig, si det.",
      "Bruk prosjektkontekst aktivt i svaret.",
    ],
    outputContract: [
      "Returner ren tekst i markdown-format.",
      "Ikke returner JSON.",
    ],
    exampleOutput: `Kunden virker å vektlegge trygg gjennomføring høyere enn teknologisk nyhetsverdi. Det betyr at dere bør styrke beskrivelsen av overgang, ansvar og risikoreduserende tiltak før tilbudet kan fremstå som vinnende.`,
  });
}

export function buildProjectMetadataPrompt() {
  return buildPromptTemplate({
    role:
      "Du er en senior løsningsarkitekt og tilbudsansvarlig som leser Bilag 1 for å identifisere prosjektmetadata som bør vises i en prosjektoversikt.",
    task: [
      "Les det primære kundedokumentet og utled et kort prosjektnavn, kundenavn, domene/bransje og en kort beskrivelse.",
      "Bruk bare informasjon som har tydelig støtte i dokumentet eller filnavnet.",
      "Vær konservativ. Returner null hvis et felt ikke kan bestemmes med rimelig trygghet.",
    ],
    rules: [
      "Returner kun gyldig JSON.",
      "Prosjektnavn skal være kort, profesjonelt og brukbart i en prosjektliste.",
      "Kundenavn skal være navnet på oppdragsgiver eller virksomheten i dokumentet, ikke leverandøren.",
      "Domene/bransje skal være kort, for eksempel Offentlig sektor, Helse, Finans, Energi eller Teknologi.",
      "Kort beskrivelse skal være én kort setning om hva konkurransen eller prosjektet gjelder.",
      "Ikke finn på informasjon som ikke støttes av dokumentet.",
    ],
    outputContract: [
      "Returner ett JSON-objekt med nøklene name, customer_name, industry og description.",
      "Hvert felt skal være en streng eller null.",
      "Bruk null når informasjonen ikke kan bestemmes trygt.",
    ],
    exampleOutput:
      '{"name":"Modernisering av kommunal skyplattform","customer_name":"Fjordvik kommune","industry":"Offentlig sektor","description":"Konkurranse om drift, sikkerhetsforvaltning og videreutvikling av Azure-plattform."}',
  });
}
