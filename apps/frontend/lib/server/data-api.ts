import "server-only";

import { PostgrestClient } from "@supabase/postgrest-js";

import {
  dataApiConfiguration,
  dataApiHeaders,
} from "@/lib/data-api-config";

export function createServiceClient() {
  const configuration = dataApiConfiguration();
  if (!configuration) {
    throw new Error(
      "Missing data API configuration: set DATA_API_URL and DATA_API_SERVICE_ROLE_KEY, or both SUPABASE variables.",
    );
  }

  return new PostgrestClient(configuration.baseUrl, {
    schema: "public",
    headers: dataApiHeaders(configuration.serviceKey),
  });
}
