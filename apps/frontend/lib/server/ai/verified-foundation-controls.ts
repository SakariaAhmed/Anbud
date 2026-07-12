export type VerifiedFoundationFact = {
  text: string;
};

function compact(value: string, maxLength = 220) {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length <= maxLength
    ? text
    : `${text.slice(0, maxLength - 3).trim()}...`;
}

function documentedFactText(
  facts: VerifiedFoundationFact[],
  pattern: RegExp,
) {
  return facts
    .filter((fact) => pattern.test(fact.text))
    .map((fact) => compact(fact.text))
    .slice(0, 6)
    .join(" ");
}

function continuityControl(facts: VerifiedFoundationFact[]) {
  const source = documentedFactText(
    facts,
    /\b(SLA|RTO|RPO|failover|disaster recovery|beredskap|backup|gjenoppretting|tilgjengelighet|nedetid|tjenestenivå)\b/i,
  );
  return source
    ? `Kontinuitet må styres mot dokumentert kildegrunnlag: ${source}`
    : "";
}

export function buildVerifiedFoundationControls(
  facts: VerifiedFoundationFact[],
) {
  const deliverables = documentedFactText(
    facts,
    /\b(D[1-9]|deliverable|milepæl|frist|deadline)\b/i,
  );
  const migration = documentedFactText(
    facts,
    /\b(\d+\s+(?:applications?|applikasjoner)|Wave\s*\d+|bølge\s*\d+|shared services|customer-facing|analytics|archive)\b/i,
  );
  const commercial = documentedFactText(
    facts,
    /\b(EUR|NOK|budget|budsjett|Net\s*\d+|payment terms|betalingsvilkår|pricing|pris|fixed implementation|monthly managed service fee|accelerated)\b/i,
  );
  const risks = documentedFactText(
    facts,
    /\b(SOC|OT telemetry|penalty|Oracle|refactor|refaktor|rehost|replatform|merger|blackout|meter data|API|renewal|eldre|legacy|teknisk gjeld|filbaserte|nøkkelperson|begrenset intern kapasitet|driftsavbrudd|nedetid)\b/i,
  );

  return [
    deliverables
      ? `Leveranseplanen må styres mot dokumentert kildegrunnlag: ${deliverables}`
      : "",
    migration
      ? `Migreringsplanen må styres mot dokumentert kildegrunnlag: ${migration}`
      : "",
    continuityControl(facts),
    commercial
      ? `Kommersielle føringer må styres mot dokumentert kildegrunnlag: ${commercial}`
      : "",
    risks
      ? `Avklarings- og risikodrivere fra verifisert kildegrunnlag: ${risks}`
      : "",
  ].filter(Boolean);
}
