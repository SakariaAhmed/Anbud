import { analysisSectionKinds } from "./generation-input.mjs";

export function judgeEvidence(kind, invocation, summaries) {
  const customerOnly = ["customer_analysis", "customer_analysis_v3", "high_level_design", ...analysisSectionKinds].includes(kind);
  const executive = kind === "executive_summary";
  const fullCustomerAnalysis = ["customer_analysis", "customer_analysis_v3"].includes(kind);
  const documents = executive ? [] : [invocation.customerDocument, ...invocation.supportingDocuments, ...(customerOnly ? [] : [invocation.solutionDocument])].filter(Boolean);
  return {
    sourceDocuments: documents.map((d) => ({ title: d.title, role: d.role, text: d.raw_text })),
    derivedContext: {
      customerAnalysis: fullCustomerAnalysis || analysisSectionKinds.includes(kind) ? undefined : summaries.customerAnalysis,
      solutionEvaluation: executive ? summaries.solutionEvaluation : customerOnly ? undefined : invocation.solutionEvaluation,
      architectureComparison: executive ? invocation.solutionEvaluation.architecture_comparison : undefined,
      serviceCandidates: executive ? undefined : invocation.serviceCandidates,
      serviceDocuments: customerOnly || executive ? undefined : invocation.serviceDescriptionDocuments,
      serviceSummaries: customerOnly || executive ? undefined : invocation.serviceDocumentSummaries,
      knowledgeArtifacts: customerOnly || executive ? undefined : invocation.knowledgeArtifacts,
    },
    taskBoundary: executive ? "Summarize only the supplied derived analysis/evaluation; no source documents were supplied to this generator." : customerOnly ? "Analyze customer needs or propose customer architecture. The supplier solution was not supplied, so do not require supplier-deviation assessment. Distinguish recommendations/imperatives from claims about existing delivery." : "Assess the task against its supplied customer and supplier evidence.",
  };
}
