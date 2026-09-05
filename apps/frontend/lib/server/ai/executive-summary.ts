import "server-only";

import { createJsonCompletion } from "@/lib/server/ai/completion";
import {
  compactText,
  summarizeCustomerAnalysis,
  summarizeSolutionEvaluation,
} from "@/lib/server/ai/context";
import { FAST_MODEL, FAST_REASONING_EFFORT } from "@/lib/server/ai/model-config";
import { capNormalizedList } from "@/lib/server/document-intelligence/text-normalization";
import { buildDelimitedContext, buildExecutiveSummaryPrompt } from "@/lib/server/prompts";
import type {
  CustomerAnalysisResult,
  ExecutiveSummaryResult,
  SolutionEvaluationResult,
} from "@/lib/types";

function normalizeExecutiveSummaryResult(
  result: Partial<ExecutiveSummaryResult> | null | undefined,
): ExecutiveSummaryResult {
  const source = result ?? {};
  const score = source.likely_score_assessment ?? {
    quality: "",
    delivery_confidence: "",
    risk: "",
    competitiveness: "",
  };

  return {
    source_solution_evaluation_present: Boolean(
      source.source_solution_evaluation_present,
    ),
    executive_summary: compactText(source.executive_summary ?? "", 1600),
    fit_to_customer_needs: compactText(source.fit_to_customer_needs ?? "", 1600),
    likely_score_assessment: {
      quality: compactText(score.quality ?? "", 500),
      delivery_confidence: compactText(score.delivery_confidence ?? "", 500),
      risk: compactText(score.risk ?? "", 500),
      competitiveness: compactText(score.competitiveness ?? "", 500),
    },
    strengths: capNormalizedList(source.strengths ?? [], { max: 4 }),
    weaknesses: capNormalizedList(source.weaknesses ?? [], { max: 4 }),
  };
}

export async function generateExecutiveSummary(input: {
  projectName: string;
  customerAnalysis: CustomerAnalysisResult | null;
  solutionEvaluation: SolutionEvaluationResult;
  model?: string;
}) {
  const userPrompt = [
    "Lag en separat lederoppsummering basert på den ferdige løsningsvurderingen.",
    "Dette er en egen dataflyt: lederoppsummeringen skal være en ny kondensert ledertekst, ikke en kopi av vurderingens executive_summary.",
    "Returner kun gyldig JSON.",
    "",
    buildDelimitedContext("Prosjekt", `Prosjektnavn: ${input.projectName}`),
    input.customerAnalysis
      ? buildDelimitedContext(
          "Kundeanalyse",
          summarizeCustomerAnalysis(input.customerAnalysis),
        )
      : "",
    buildDelimitedContext(
      "Løsningsvurdering",
      summarizeSolutionEvaluation(input.solutionEvaluation),
    ),
    input.solutionEvaluation.architecture_comparison
      ? buildDelimitedContext(
          "Arkitektursammenligning",
          JSON.stringify(input.solutionEvaluation.architecture_comparison),
        )
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  const result = await createJsonCompletion<ExecutiveSummaryResult>({
    system: buildExecutiveSummaryPrompt(),
    user: userPrompt,
    temperature: 0.12,
    model: input.model ?? FAST_MODEL,
    reasoningEffort: FAST_REASONING_EFFORT,
    promptCacheKey: "executive-summary",
  });

  return normalizeExecutiveSummaryResult(result);
}
