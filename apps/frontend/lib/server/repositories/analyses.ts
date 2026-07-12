import "server-only";

export {
  getCustomerAnalysis,
  getFreshCustomerAnalysis,
  getExecutiveSummary,
  getFreshExecutiveSummary,
  getFreshSolutionEvaluation,
  getFreshSolutionEvaluationSnapshot,
  getSolutionEvaluation,
  saveCustomerAnalysis,
  saveExecutiveSummary,
  saveSolutionEvaluation,
} from "@/lib/server/repositories/supabase-store";
