import "server-only";

import {
  dataApiConfiguration,
  dataApiHeaders,
} from "@/lib/data-api-config";
import { PostgrestClient } from "@/lib/server/postgrest-client";

export function createServiceClient() {
  const configuration = dataApiConfiguration();
  if (!configuration) {
    throw new Error(
      "Missing data API configuration: set DATA_API_URL and DATA_API_SERVICE_ROLE_KEY.",
    );
  }

  return new PostgrestClient(configuration.baseUrl, {
    schema: "public",
    headers: dataApiHeaders(configuration.serviceKey),
  });
}
