import "server-only";

import { Annotation, END, START, StateGraph } from "@langchain/langgraph";

import type {
  DocumentSnippetRetrievalResult,
  RetrievalQuality,
} from "@/lib/server/document-chunks";
import type { ChatSourceReference } from "@/lib/types";

export type RagWorkflowIntent =
  | "chat"
  | "customer_analysis"
  | "requirement_answer"
  | "solution_evaluation"
  | "artifact_generation";

export type RagQueryPlan = {
  standalone_query: string;
  exact_terms: string[];
  subqueries: string[];
  filters?: {
    project_id?: string;
    source_ids?: string[];
    roles?: string[];
    chunk_kinds?: string[];
  };
};

export type RagWorkflowState = {
  projectId: string;
  userInput: string;
  intent: RagWorkflowIntent;
  queryPlan?: RagQueryPlan;
  retrieval?: DocumentSnippetRetrievalResult;
  retrievalQuality?: RetrievalQuality;
  answer?: string;
  citations?: ChatSourceReference[];
  retryCount: number;
  errors: string[];
};

export type ScopedRagTools = {
  rewriteQuery: (state: RagWorkflowState) => Promise<Partial<RagWorkflowState>>;
  retrieve: (state: RagWorkflowState) => Promise<Partial<RagWorkflowState>>;
  generate: (state: RagWorkflowState) => Promise<Partial<RagWorkflowState>>;
  askClarifyingQuestion?: (
    state: RagWorkflowState,
  ) => Promise<Partial<RagWorkflowState>>;
  validateCitations?: (
    state: RagWorkflowState,
  ) => Promise<Partial<RagWorkflowState>>;
  persist?: (state: RagWorkflowState) => Promise<Partial<RagWorkflowState>>;
};

export function validateCitationReferences(input: {
  citations: ChatSourceReference[];
  retrieval: DocumentSnippetRetrievalResult | null | undefined;
}) {
  const retrievedKeys = new Set(
    (input.retrieval?.snippets ?? []).map((snippet) =>
      [
        snippet.sourceType,
        snippet.sourceId,
        snippet.reference,
        snippet.pageStart ?? "",
        snippet.pageEnd ?? "",
      ].join(":"),
    ),
  );

  return input.citations.every((citation) =>
    retrievedKeys.has(
      [
        citation.source_type,
        citation.source_id,
        citation.reference,
        citation.page_start ?? "",
        citation.page_end ?? "",
      ].join(":"),
    ),
  );
}

export async function runDeterministicRagWorkflow(
  initialState: RagWorkflowState,
  tools: ScopedRagTools,
) {
  let state = {
    ...initialState,
    retryCount: initialState.retryCount ?? 0,
    errors: initialState.errors ?? [],
  };

  state = { ...state, ...(await tools.rewriteQuery(state)) };
  state = { ...state, ...(await tools.retrieve(state)) };
  state.retrievalQuality =
    state.retrievalQuality ?? state.retrieval?.telemetry.quality;

  if (!state.retrievalQuality?.sufficient && state.retryCount < 1) {
    state = { ...state, retryCount: state.retryCount + 1 };
    state = { ...state, ...(await tools.rewriteQuery(state)) };
    state = { ...state, ...(await tools.retrieve(state)) };
    state.retrievalQuality =
      state.retrievalQuality ?? state.retrieval?.telemetry.quality;
  }

  if (!state.retrievalQuality?.sufficient && tools.askClarifyingQuestion) {
    state = { ...state, ...(await tools.askClarifyingQuestion(state)) };
  } else {
    state = { ...state, ...(await tools.generate(state)) };
  }

  if (tools.validateCitations) {
    state = { ...state, ...(await tools.validateCitations(state)) };
  }
  if (tools.persist) {
    state = { ...state, ...(await tools.persist(state)) };
  }

  return state;
}

export function createLangGraphRagWorkflow(tools: ScopedRagTools) {
  const StateAnnotation = Annotation.Root({
    projectId: Annotation<string>(),
    userInput: Annotation<string>(),
    intent: Annotation<RagWorkflowIntent>(),
    queryPlan: Annotation<RagQueryPlan | undefined>(),
    retrieval: Annotation<DocumentSnippetRetrievalResult | undefined>(),
    retrievalQuality: Annotation<RetrievalQuality | undefined>(),
    answer: Annotation<string | undefined>(),
    citations: Annotation<ChatSourceReference[] | undefined>(),
    retryCount: Annotation<number>({
      reducer: (_left, right) => right ?? 0,
      default: () => 0,
    }),
    errors: Annotation<string[]>({
      reducer: (left, right) => [...(left ?? []), ...(right ?? [])],
      default: () => [],
    }),
  });

  const graph = new StateGraph(StateAnnotation)
    .addNode("rewriteQuery", async (state: RagWorkflowState) =>
      tools.rewriteQuery(state),
    )
    .addNode("hybridRetrieve", async (state: RagWorkflowState) =>
      tools.retrieve(state),
    )
    .addNode("gradeRetrieval", async (state: RagWorkflowState) => ({
      retrievalQuality: state.retrieval?.telemetry.quality,
    }))
    .addNode("incrementRetry", async (state: RagWorkflowState) => ({
      retryCount: (state.retryCount ?? 0) + 1,
    }))
    .addNode("generate", async (state: RagWorkflowState) =>
      tools.generate(state),
    )
    .addNode("askClarifyingQuestion", async (state: RagWorkflowState) =>
      tools.askClarifyingQuestion
        ? tools.askClarifyingQuestion(state)
        : {
            answer:
              "Kildegrunnlaget er for svakt til å gi et trygt svar. Presiser spørsmålet eller legg til relevant dokumentasjon.",
          },
    )
    .addNode("validateCitations", async (state: RagWorkflowState) =>
      tools.validateCitations
        ? tools.validateCitations(state)
        : {
            errors:
              state.citations && !validateCitationReferences({
                citations: state.citations,
                retrieval: state.retrieval,
              })
                ? ["En eller flere kildehenvisninger finnes ikke i retrieval-resultatet."]
                : [],
          },
    )
    .addNode("persist", async (state: RagWorkflowState) =>
      tools.persist ? tools.persist(state) : {},
    )
    .addEdge(START, "rewriteQuery")
    .addEdge("rewriteQuery", "hybridRetrieve")
    .addEdge("hybridRetrieve", "gradeRetrieval")
    .addConditionalEdges(
      "gradeRetrieval",
      (state: RagWorkflowState) => {
        if (state.retrievalQuality?.sufficient) {
          return "generate";
        }
        return state.retryCount < 1 ? "incrementRetry" : "askClarifyingQuestion";
      },
      ["generate", "incrementRetry", "askClarifyingQuestion"],
    )
    .addEdge("incrementRetry", "rewriteQuery")
    .addEdge("generate", "validateCitations")
    .addEdge("askClarifyingQuestion", "validateCitations")
    .addEdge("validateCitations", "persist")
    .addEdge("persist", END);

  return graph.compile();
}
