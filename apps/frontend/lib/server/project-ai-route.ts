import "server-only";

import { NextResponse } from "next/server";

import { resolveOpenAIModelOverride } from "@/lib/server/ai";
import { enforceProjectRouteRateLimit } from "@/lib/server/api-responses";

type ProjectRouteContext = { params: Promise<{ id: string }> };

type ProjectAiRouteRateLimit = {
  scopePrefix: string;
  message: string;
  limit: number;
  windowMs: number;
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

type ProjectAiJsonRoutePreflight<TBody> =
  | {
      id: string;
      model: string | undefined;
      body: TBody;
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
  const { id, response } = await enforceProjectRouteRateLimit(
    request,
    context,
    rateLimit,
  );
  if (response) {
    return { id, model: undefined, response };
  }

  const model = await resolveOpenAIModelOverride(
    request.headers.get("x-openai-model"),
  );
  return { id, model, response: null };
}

export async function prepareProjectAiJsonRoute<TBody>(
  request: Request,
  context: ProjectRouteContext,
  input: ProjectAiRouteRateLimit & {
    fallbackBody?: TBody;
  },
): Promise<ProjectAiJsonRoutePreflight<TBody>> {
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

  const body =
    "fallbackBody" in input
      ? ((await request.json().catch(() => input.fallbackBody)) as TBody)
      : ((await request.json()) as TBody);

  return { ...preflight, body };
}
