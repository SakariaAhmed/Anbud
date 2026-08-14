import "server-only";

import { NextResponse } from "next/server";

import { dataApiConfiguration } from "@/lib/data-api-config";
import { defaultAzureBlobStorageBackend } from "@/lib/server/azure-blob-storage";
import { createServiceClient } from "@/lib/server/supabase";

export type HealthStatus = "healthy" | "degraded" | "unhealthy";

export type HealthComponent = {
  name: string;
  status: HealthStatus;
  description: string;
  latency_ms?: number;
  metadata?: Record<string, string | number | boolean | null>;
};

export type HealthFlow = {
  name: string;
  status: HealthStatus;
  depends_on: string[];
};

export type HealthModel = {
  service: string;
  status: HealthStatus;
  checked_at: string;
  runtime: {
    node_env: string;
    uptime_seconds: number;
    region: string | null;
    stamp: string | null;
    version: string | null;
  };
  components: HealthComponent[];
  flows: HealthFlow[];
};

const PROCESS_STARTED_AT = Date.now();
const DATA_API_DEGRADED_AFTER_MS = 750;
const DATA_API_TIMEOUT_MS = 1_500;
const STORAGE_TIMEOUT_MS = 1_500;
const HEALTH_CACHE_HEADERS = {
  "Cache-Control": "no-store",
};

const REQUIRED_ENV = [
  "APP_ENCRYPTION_KEY",
  "APP_ADMIN_ACCESS_PASSWORD_HASH",
  "APP_ADMIN_PRINCIPAL_ID",
  "APP_SESSION_SECRET",
  "OPENAI_API_KEY",
  "PROJECT_JOB_WORKER_TOKEN",
] as const;

function mostSevereStatus(statuses: HealthStatus[]) {
  if (statuses.includes("unhealthy")) {
    return "unhealthy";
  }

  if (statuses.includes("degraded")) {
    return "degraded";
  }

  return "healthy";
}

function statusFromComponents(
  components: HealthComponent[],
  names: string[],
): HealthStatus {
  return mostSevereStatus(
    names.map(
      (name) =>
        components.find((component) => component.name === name)?.status ??
        "unhealthy",
    ),
  );
}

function runtimeComponent(): HealthComponent {
  return {
    name: "runtime",
    status: "healthy",
    description: "Next.js runtime is responding.",
    metadata: {
      uptime_seconds: Math.floor((Date.now() - PROCESS_STARTED_AT) / 1000),
    },
  };
}

function configurationComponent(): HealthComponent {
  const fileStorageBackend =
    process.env.FILE_STORAGE_BACKEND?.trim().toLowerCase() || "supabase";
  const storageBackendValid =
    fileStorageBackend === "azure" || fileStorageBackend === "supabase";
  const storageConfigured =
    !storageBackendValid
      ? false
      : fileStorageBackend === "azure"
      ? Boolean(process.env.AZURE_STORAGE_ACCOUNT_URL?.trim())
      : Boolean(
          process.env.SUPABASE_URL?.trim() &&
            process.env.SUPABASE_SERVICE_ROLE_KEY?.trim(),
        );
  const missingCount =
    REQUIRED_ENV.filter((name) => !process.env[name]?.trim()).length +
    (dataApiConfiguration() ? 0 : 1) +
    (storageConfigured ? 0 : 1);

  return {
    name: "configuration",
    status: missingCount === 0 ? "healthy" : "unhealthy",
    description:
      missingCount === 0
        ? "Required runtime configuration is present."
        : "Required runtime configuration is incomplete.",
    metadata: {
      missing_required_count: missingCount,
      docling_mode: process.env.DOCLING_ENHANCEMENT_MODE?.trim() || "async",
      docling_auto_run: process.env.DOCLING_ASYNC_AUTO_RUN?.trim() || "off",
      data_backend: dataApiConfiguration()?.backend || "unconfigured",
      file_storage_backend: fileStorageBackend,
    },
  };
}

async function withAbortTimeout<T>(
  timeoutMs: number,
  action: (signal: AbortSignal) => PromiseLike<T>,
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await action(controller.signal);
  } finally {
    clearTimeout(timeout);
  }
}

async function dataApiComponent(): Promise<HealthComponent> {
  const configuration = dataApiConfiguration();
  if (!configuration) {
    return {
      name: "data_api",
      status: "unhealthy",
      description: "The data API is not configured.",
    };
  }

  const start = performance.now();

  try {
    const dataApi = createServiceClient();
    const result = await withAbortTimeout(DATA_API_TIMEOUT_MS, (signal) =>
      dataApi
        .from("projects")
        .select("id")
        .limit(1)
        .abortSignal(signal),
    );
    const latencyMs = Math.round(performance.now() - start);

    if (result.error) {
      return {
        name: "data_api",
        status: "unhealthy",
        description: "The data API did not accept a lightweight projects query.",
        latency_ms: latencyMs,
        metadata: {
          error_code: result.error.code || null,
        },
      };
    }

    return {
      name: "data_api",
      status: latencyMs > DATA_API_DEGRADED_AFTER_MS ? "degraded" : "healthy",
      description:
        latencyMs > DATA_API_DEGRADED_AFTER_MS
          ? "The data API is reachable but responding slowly."
          : "The data API is reachable.",
      latency_ms: latencyMs,
      metadata: { backend: configuration.backend },
    };
  } catch (error) {
    const latencyMs = Math.round(performance.now() - start);
    return {
      name: "data_api",
      status: "unhealthy",
      description:
        error instanceof Error && error.name === "AbortError"
          ? "The data API health query timed out."
          : "The data API health query failed.",
      latency_ms: latencyMs,
    };
  }
}

async function fileStorageComponent(): Promise<HealthComponent> {
  const backend = process.env.FILE_STORAGE_BACKEND?.trim().toLowerCase() || "supabase";
  if (backend === "supabase") {
    const configured = Boolean(
      process.env.SUPABASE_URL?.trim() &&
        process.env.SUPABASE_SERVICE_ROLE_KEY?.trim(),
    );
    return {
      name: "file_storage",
      status: configured ? "healthy" : "unhealthy",
      description: configured
        ? "Supabase file storage configuration is present."
        : "Supabase file storage configuration is missing.",
      metadata: { backend },
    };
  }
  if (backend !== "azure") {
    return {
      name: "file_storage",
      status: "unhealthy",
      description: "The file storage backend is invalid.",
    };
  }

  const start = performance.now();
  try {
    await withAbortTimeout(STORAGE_TIMEOUT_MS, (signal) =>
      defaultAzureBlobStorageBackend().probeAccess(signal),
    );
    return {
      name: "file_storage",
      status: "healthy",
      description: "The private Azure Blob container is reachable with managed identity.",
      latency_ms: Math.round(performance.now() - start),
      metadata: { backend },
    };
  } catch (error) {
    return {
      name: "file_storage",
      status: "unhealthy",
      description:
        error instanceof Error && error.name === "AbortError"
          ? "The Azure Blob container probe timed out."
          : "The Azure Blob container probe failed.",
      latency_ms: Math.round(performance.now() - start),
      metadata: { backend },
    };
  }
}

function openAiComponent(): HealthComponent {
  const configured = Boolean(process.env.OPENAI_API_KEY?.trim());

  return {
    name: "openai",
    status: configured ? "healthy" : "unhealthy",
    description: configured
      ? "OpenAI configuration is present."
      : "OpenAI configuration is missing.",
    metadata: {
      model: process.env.OPENAI_MODEL?.trim() || "gpt-5.4",
    },
  };
}

function workerComponent(): HealthComponent {
  const configured = Boolean(process.env.PROJECT_JOB_WORKER_TOKEN?.trim());

  return {
    name: "project_job_worker",
    status: configured ? "healthy" : "unhealthy",
    description: configured
      ? "Project job worker authentication is configured."
      : "Project job worker authentication is missing.",
  };
}

function flowsFromComponents(components: HealthComponent[]): HealthFlow[] {
  const flows: Array<Omit<HealthFlow, "status">> = [
    {
      name: "interactive_project_workspace",
      depends_on: ["runtime", "configuration", "data_api", "file_storage"],
    },
    {
      name: "ai_generation",
      depends_on: ["runtime", "configuration", "data_api", "file_storage", "openai"],
    },
    {
      name: "async_project_jobs",
      depends_on: [
        "runtime",
        "configuration",
        "data_api",
        "file_storage",
        "openai",
        "project_job_worker",
      ],
    },
  ];

  return flows.map((flow) => ({
    ...flow,
    status: statusFromComponents(components, flow.depends_on),
  }));
}

export function createLivenessModel(): HealthModel {
  const components = [runtimeComponent()];
  const flows: HealthFlow[] = [
    {
      name: "http_runtime",
      status: "healthy",
      depends_on: ["runtime"],
    },
  ];

  return {
    service: "bidsite-frontend",
    status: "healthy",
    checked_at: new Date().toISOString(),
    runtime: runtimeMetadata(),
    components,
    flows,
  };
}

export async function createReadinessModel(): Promise<HealthModel> {
  const components = [
    runtimeComponent(),
    configurationComponent(),
    await dataApiComponent(),
    await fileStorageComponent(),
    openAiComponent(),
    workerComponent(),
  ];
  const flows = flowsFromComponents(components);

  return {
    service: "bidsite-frontend",
    status: mostSevereStatus(flows.map((flow) => flow.status)),
    checked_at: new Date().toISOString(),
    runtime: runtimeMetadata(),
    components,
    flows,
  };
}

function healthStatusCode(model: Pick<HealthModel, "status">) {
  return model.status === "unhealthy" ? 503 : 200;
}

export function healthJsonResponse(model: HealthModel) {
  return NextResponse.json(model, {
    status: healthStatusCode(model),
    headers: HEALTH_CACHE_HEADERS,
  });
}

function runtimeMetadata(): HealthModel["runtime"] {
  return {
    node_env: process.env.NODE_ENV || "development",
    uptime_seconds: Math.floor((Date.now() - PROCESS_STARTED_AT) / 1000),
    region:
      process.env.APP_REGION?.trim() ||
      process.env.AZURE_REGION?.trim() ||
      process.env.REGION_NAME?.trim() ||
      null,
    stamp: process.env.APP_STAMP?.trim() || null,
    version: process.env.APP_VERSION?.trim() || process.env.GITHUB_SHA?.trim() || null,
  };
}
