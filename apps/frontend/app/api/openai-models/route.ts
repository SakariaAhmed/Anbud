import { NextResponse } from "next/server";

import {
  DEFAULT_OPENAI_MODEL,
  listAvailableOpenAIModels,
  type OpenAIModelSummary,
} from "@/lib/server/ai";

const WORKSPACE_MODEL_IDS = [
  "gpt-5.5",
  "gpt-5.5-pro",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.4-nano",
  "gpt-5.2",
  "gpt-5.2-pro",
];

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
          "Cache-Control": "no-store",
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
