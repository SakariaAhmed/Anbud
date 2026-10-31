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
