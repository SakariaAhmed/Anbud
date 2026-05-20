import { NextResponse } from "next/server";

import {
  DEFAULT_OPENAI_MODEL,
  WORKSPACE_MODEL_IDS,
  listAvailableOpenAIModels,
  type OpenAIModelSummary,
} from "@/lib/server/ai";

export async function GET() {
  try {
    const availableModels = await listAvailableOpenAIModels();
    const modelsById = new Map(
      availableModels.map((model) => [model.id, model]),
    );
    const models = WORKSPACE_MODEL_IDS.map((modelId) =>
      modelsById.get(modelId),
    ).filter((model): model is OpenAIModelSummary => Boolean(model));

    return NextResponse.json(
      {
        default_model: DEFAULT_OPENAI_MODEL,
        models,
      },
      {
        headers: {
          "Cache-Control": "private, max-age=900",
        },
      },
    );
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Kunne ikke hente modeller.",
      },
      { status: 500 },
    );
  }
}
