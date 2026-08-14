import "server-only";

import { createClient } from "@supabase/supabase-js";

export { createServiceClient } from "@/lib/server/data-api";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function createSupabaseStorageClient() {
  return createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}
