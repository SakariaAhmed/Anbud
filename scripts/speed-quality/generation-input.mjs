import { createHash } from "node:crypto";

export const analysisSectionKinds = ["summary", "strategy", "clarifications", "design", "risks", "needs", "keywords", "services", "value"].map((section) => `section_${section}`);
export const hashInput = (input) => createHash("sha256").update(JSON.stringify(input)).digest("hex");
export function frozenInvocation(fixture, kind, { model, evaluation, chatHistoryMode = "empty", chatQuestionMode = "standard" } = {}) {
  if (!["empty", "route-current"].includes(chatHistoryMode)) throw new Error("Unknown frozen chat history mode.");
  if (!["standard", "late-operational-requirements"].includes(chatQuestionMode)) throw new Error("Unknown frozen chat question mode.");
  const input = structuredClone(fixture.input);
  if (model) input.model = model;
  if (kind === "executive_summary") {
    if (!evaluation) throw new Error("Completed frozen baseline evaluation is required.");
    input.solutionEvaluation = structuredClone(evaluation);
  }
  if (kind === "chat") {
    const question = chatQuestionMode === "late-operational-requirements"
      ? "Hva kreves om opplæring, underleverandører, sletting ved exit og driftsmøter, og hva bekrefter løsningsbeskrivelsen? Skill krav, avvik og manglende dokumentasjon."
      : "Hvilke krav oppfyller løsningsbeskrivelsen, hvilke bryter den med, og hva mangler dokumentasjon? Oppgi eksakte kravreferanser og foreslå de viktigste avklaringene.";
    const recentMessages = chatHistoryMode === "route-current" ? [{ id: "pending-user", project_id: fixture.projectId, role: "user", content: question, context_snapshot: {}, created_at: "2026-09-08T00:00:00.000Z" }] : [];
    return { ...input, recentMessages, question };
  }
  if (analysisSectionKinds.includes(kind)) return { ...input, section: kind.slice("section_".length) };
  if (["customer_analysis", "customer_analysis_v3", "high_level_design", "solution_evaluation", "executive_summary"].includes(kind)) return input;
  return { ...input, artifactType: kind, solutionEvaluation: null };
}

export function assertComparableInputs({ fixture, kind, before, after, evaluation }) {
  const chatHistoryMode = before.chatHistoryMode ?? "empty";
  if (chatHistoryMode !== (after.chatHistoryMode ?? "empty")) throw new Error("Paired chat history modes differ.");
  const chatQuestionMode = before.chatQuestionMode ?? "standard";
  if (chatQuestionMode !== (after.chatQuestionMode ?? "standard")) throw new Error("Paired chat question modes differ.");
  const expected = frozenInvocation(fixture, kind, { evaluation, chatHistoryMode, chatQuestionMode });
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
