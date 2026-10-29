import "server-only";

import { NextResponse } from "next/server";

import { requireProjectPermission } from "@/lib/server/authorization";
import { resolveOpenAIModelOverride } from "@/lib/server/ai/model-config";
import { enforceProjectRouteRateLimit } from "@/lib/server/api-responses";
import { readJsonObject } from "@/lib/server/request-body";

type ProjectRouteContext = { params: Promise<{ id: string }> };

type ProjectAiRouteRateLimit = {
  scopePrefix: string;
  message: string;
  limit: number;
  windowMs: number;
  fallbackLimit?: number;
};

type ProjectAiRoutePreflight =
  | {
      id: string;
      model: string | undefined;
      response: null;
    }
  | {
      id: string;
      model: undefined;
      response: NextResponse;
    };

type ProjectAiJsonRoutePreflight =
  | {
      id: string;
      model: string | undefined;
      body: Record<string, unknown>;
      response: null;
    }
  | {
      id: string;
      model: undefined;
      body: undefined;
      response: NextResponse;
    };

export async function prepareProjectAiRoute(
  request: Request,
  context: ProjectRouteContext,
  rateLimit: ProjectAiRouteRateLimit,
): Promise<ProjectAiRoutePreflight> {
  const { id: projectId } = await context.params;
  await requireProjectPermission(projectId, "project.update");
  const { id, response } = await enforceProjectRouteRateLimit(
    request,
    context,
    {
      ...rateLimit,
      fallbackLimit:
        rateLimit.fallbackLimit ?? Math.max(1, Math.floor(rateLimit.limit / 4)),
    },
  );
  if (response) {
    return { id, model: undefined, response };
  }

  const model = await resolveOpenAIModelOverride(
    request.headers.get("x-openai-model"),
  );
  return { id, model, response: null };
}

export async function prepareProjectAiJsonRoute(
  request: Request,
  context: ProjectRouteContext,
  input: ProjectAiRouteRateLimit,
): Promise<ProjectAiJsonRoutePreflight> {
  const preflight = await prepareProjectAiRoute(request, context, input);
  if (preflight.response) {
    return { ...preflight, body: undefined };
  }

  const contentType = request.headers.get("content-type") ?? "";
  if (contentType && !contentType.toLowerCase().includes("application/json")) {
    return {
      id: preflight.id,
      model: undefined,
      body: undefined,
      response: NextResponse.json(
        { error: "Forespørselen må sendes som JSON." },
        { status: 415 },
      ),
    };
  }

  return { ...preflight, body: await readJsonObject(request) };
}
