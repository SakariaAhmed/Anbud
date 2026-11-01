import "server-only";

import { compactText } from "@/lib/server/ai/context";

import { buildDelimitedContext } from "@/lib/server/prompts";

import { boundedIntegerEnv } from "@/lib/server/ai/generation-runtime";
import type { ProjectDocumentDetail } from "@/lib/types";

export const REQUIREMENT_COVERAGE_FULL_SOLUTION_MAX_CHARS = boundedIntegerEnv(
  process.env,
  "REQUIREMENT_COVERAGE_FULL_SOLUTION_MAX_CHARS",
  45_000,
  0,
  120_000,
);

/** Requirement answers are written from the supplier's solution document.
 * As in the solution evaluation, one that fits is sent whole in the shared
 * prompt prefix, so a commitment or price reservation late in the document
 * ("Kundestyrte nøkler … prises som tilleggsopsjon") reaches every batch and
 * the repair handoff. A longer one is summarised here and retrieved per batch. */
export function solutionDocumentFitsRequirementPrompt(document: ProjectDocumentDetail) {
  return document.raw_text.length <= REQUIREMENT_COVERAGE_FULL_SOLUTION_MAX_CHARS;
}

export function requirementAnswerSolutionContext(document: ProjectDocumentDetail) {
  return solutionDocumentFitsRequirementPrompt(document)
    ? buildDelimitedContext(`Hele løsningsdokumentet: ${document.title}`, document.raw_text)
    : buildDelimitedContext("Primært løsningsdokument sammendrag", compactText(document.raw_text, 1200));
}
