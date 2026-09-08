import { createHash } from "node:crypto";

export const analysisSectionKinds = ["summary", "strategy", "clarifications", "design", "risks", "needs", "keywords", "services", "value"].map((section) => `section_${section}`);
export const hashInput = (input) => createHash("sha256").update(JSON.stringify(input)).digest("hex");
export function frozenInvocation(fixture, kind, { model, evaluation } = {}) {
  const input = structuredClone(fixture.input);
  if (model) input.model = model;
  if (kind === "executive_summary") {
    if (!evaluation) throw new Error("Completed frozen baseline evaluation is required.");
    input.solutionEvaluation = structuredClone(evaluation);
  }
  if (kind === "chat") return { ...input, recentMessages: [], question: "Hvilke krav oppfyller løsningsbeskrivelsen, hvilke bryter den med, og hva mangler dokumentasjon? Oppgi eksakte kravreferanser og foreslå de viktigste avklaringene." };
  if (analysisSectionKinds.includes(kind)) return { ...input, section: kind.slice("section_".length) };
  if (["customer_analysis", "customer_analysis_v3", "high_level_design", "solution_evaluation", "executive_summary"].includes(kind)) return input;
  return { ...input, artifactType: kind, solutionEvaluation: null };
}

export function assertComparableInputs({ fixture, kind, before, after, evaluation }) {
  const expected = frozenInvocation(fixture, kind, { evaluation });
  const expectedHash = hashInput(expected);
  const baselineV1 = hashInput(fixture.input);
  function matches(run, allowV1) {
    const evidenceHash = run.evidenceInputSha256 ?? run.fullInputSha256;
    if (evidenceHash === expectedHash) return true;
    // Only the first six baseline operations used the old hash. The candidate
    // still must match the exact reconstructed operation, never merely differ.
    return allowV1 && !run.evidenceInputSha256 && ["high_level_design", "losningsutkast", "tilbudsstrategi", "verdiargumentasjon", "anbefalt_arkitektur", "gjennomforing_og_risiko"].includes(kind) && run.fullInputSha256 === baselineV1;
  }
  if (!matches(before, true) || !matches(after, false)) throw new Error("Paired operation inputs differ from frozen evidence.");
  return expected;
}
