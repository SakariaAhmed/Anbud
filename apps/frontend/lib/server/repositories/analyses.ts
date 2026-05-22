import "server-only";

export {
  getCustomerAnalysis,
  getExecutiveSummary,
  getSolutionEvaluation,
  saveCustomerAnalysis,
  saveExecutiveSummary,
  saveSolutionEvaluation,
} from "@/lib/server/repositories/supabase-store";
