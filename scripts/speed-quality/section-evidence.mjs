import { isDeepStrictEqual } from "node:util";

// A section judge sees only the actual section. Changes outside that contract
// are a deterministic failure, not something a language model may overlook.
export function inspectSectionEvidence(original, result, fields, resultFields = fields) {
  if (!original || !result || !fields.length) throw new Error("Missing section evidence.");
  const allowed = new Set([...resultFields, "section_histories"]);
  const changedOutsideSection = [];
  for (const key of new Set([...Object.keys(original), ...Object.keys(result)])) {
    if (!allowed.has(key) && !isDeepStrictEqual(original[key], result[key])) {
      changedOutsideSection.push(key);
    }
  }
  const evidence = {};
  for (const field of fields) {
    if (!Object.hasOwn(result, field)) throw new Error(`Missing regenerated field: ${field}`);
    evidence[field] = result[field];
  }
  return { evidence, changedOutsideSection };
}

export function sectionEvidence(original, result, fields, resultFields = fields) {
  const inspected = inspectSectionEvidence(original, result, fields, resultFields);
  if (inspected.changedOutsideSection.length) throw new Error(`Regeneration changed unrelated field: ${inspected.changedOutsideSection.join(", ")}`);
  return inspected.evidence;
}
