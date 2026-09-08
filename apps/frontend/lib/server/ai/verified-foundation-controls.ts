export type VerifiedFoundationFact = {
  text: string;
};

function documentedFactText(
  facts: VerifiedFoundationFact[],
  pattern: RegExp,
) {
  return facts
    .filter((fact) => pattern.test(fact.text))
    .map((fact) => fact.text.replace(/\s+/g, " ").trim())
    // Preserve complete qualifications, but do not repeat a sentence already
    // contained verbatim in another selected source fragment.
    .filter((text, index, texts) => !texts.some((other, otherIndex) =>
      other.includes(text) && (other.length > text.length || otherIndex < index),
    ))
    .slice(0, 6)
    .join(" ");
}

export function documentedMigrationControl(facts: VerifiedFoundationFact[]) {
  const migration = documentedFactText(
    facts,
    /\b(?:waves?|bølge(?:r|ne)?|migrer(?:ing(?:en)?|es)|migrat(?:ion|e[ds]?))\b/i,
  );
  return migration
    ? `Migreringsplanen må styres mot dokumentert kildegrunnlag: ${migration}`
    : "";
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
    documentedMigrationControl(facts),
    continuityControl(facts),
    commercial
      ? `Kommersielle føringer må styres mot dokumentert kildegrunnlag: ${commercial}`
      : "",
    risks
      ? `Avklarings- og risikodrivere fra verifisert kildegrunnlag: ${risks}`
      : "",
  ].filter(Boolean);
}
