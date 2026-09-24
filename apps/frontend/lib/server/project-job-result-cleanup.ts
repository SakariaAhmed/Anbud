import "server-only";

import { createServiceClient } from "@/lib/server/data-api";
import { decryptJson, encryptJson } from "@/lib/server/crypto";
import { projectJobResultForRead } from "@/lib/server/project-job-result-projection";
import type { ProjectJobResult } from "@/lib/types";

type ResultRow = { id: string; status: string; updated_at: string; result_json: unknown };

// Operator-only maintenance. The serving read projection remains mandatory until
// every environment and retained backup has been cleaned or expired.
export async function cleanHistoricalProjectJobResults(options: {
  apply?: boolean;
  client?: ReturnType<typeof createServiceClient>;
} = {}) {
  const client = options.client ?? createServiceClient();
  const counts = { scanned: 0, affected: 0, updated: 0, conflicts: 0 };
  let afterId: string | null = null;
  while (true) {
    let query = client.from("project_jobs").select("id,status,updated_at,result_json")
      .in("status", ["completed", "failed"]).not("result_json", "is", null)
      .order("id", { ascending: true }).limit(100);
    if (afterId) query = query.gt("id", afterId);
    const { data, error } = await query;
    if (error) throw new Error("Kunne ikke lese historiske jobbresultater.");
    const rows = (data ?? []) as ResultRow[];
    if (!rows.length) break;
    for (const row of rows) {
      counts.scanned++;
      const result = decryptJson<ProjectJobResult | null>(row.result_json, null);
      if (!result) throw new Error("Et historisk jobbresultat kunne ikke dekrypteres. Ingen endring ble gjort i denne raden.");
      const projected = projectJobResultForRead(result);
      if (JSON.stringify(projected) === JSON.stringify(result)) continue;
      counts.affected++;
      if (!options.apply) continue;
      // Compare the exact ciphertext as well as lifecycle state. Do not overwrite
      // a worker's newer result if it changed after the maintenance read.
      const updated = await client.rpc("clean_project_job_result", {
        p_job_id: row.id,
        p_expected_status: row.status,
        p_expected_updated_at: row.updated_at,
        p_expected_result: row.result_json,
        p_result: encryptJson(projected),
      });
      if (updated.error) throw new Error("Kunne ikke rense et historisk jobbresultat.");
      if (updated.data === true) counts.updated++;
      else counts.conflicts++;
    }
    afterId = rows[rows.length - 1].id;
  }
  return counts;
}
