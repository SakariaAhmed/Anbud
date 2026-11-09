/**
 * Whether a scheduled worker run has anything to do, checked before the
 * Next server starts. Almost every run is empty, and starting the server
 * takes most of each run's billed time.
 *
 * The worker route (runAvailableProjectJobs) acts only on:
 * - `running` project jobs, which it re-queues when their lease is stale;
 * - `pending` automatic analysis requests, which it dispatches as jobs;
 * - `queued` project jobs, which it claims and runs.
 * With none of these, a run changes nothing. Keep this list in step with
 * that route when it gains another source of work.
 *
 * Resolves `true` (work exists), `false` (no work), or `null` when the answer is
 * unknown; callers start the server for anything other than `false`.
 */

const CHECK_TIMEOUT_MS = 10_000;

const WORK_QUERIES = [
  "project_jobs?select=id&status=in.(queued,running)&limit=1",
  "project_analysis_requests?select=project_id&status=eq.pending&limit=1",
];

/**
 * The internal HTTPS data API the server itself would accept in production
 * (lib/data-api-config.ts). Anything else returns null and the key is not sent.
 */
function internalDataApi(env) {
  const url = env.DATA_API_URL?.trim() || "";
  const serviceKey = env.DATA_API_SERVICE_ROLE_KEY?.trim() || "";
  const suffix = env.DATA_API_ALLOWED_HOST_SUFFIX?.trim().toLowerCase() || "";
  if (!url || !serviceKey || !/^\.internal\.[a-z0-9.-]+$/u.test(suffix)) return null;

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const hostname = parsed.hostname.toLowerCase();
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    !hostname.endsWith(suffix) ||
    hostname.length <= suffix.length
  ) {
    return null;
  }
  return {
    rootUrl: `${parsed.origin}${parsed.pathname}`.replace(/\/+$/u, ""),
    serviceKey,
  };
}

/** A fixed reason code; error messages can quote response bodies. */
class UnknownAnswer extends Error {
  constructor(reason) {
    super(reason);
    this.reason = reason;
  }
}

async function hasRows(dataApi, query, fetchImpl, timeoutMs) {
  let response;
  let rows;
  try {
    response = await fetchImpl(`${dataApi.rootUrl}/${query}`, {
      headers: {
        apikey: dataApi.serviceKey,
        authorization: `Bearer ${dataApi.serviceKey}`,
        accept: "application/json",
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new UnknownAnswer(`http_${response.status}`);
    rows = await response.json();
  } catch (error) {
    if (error instanceof UnknownAnswer) throw error;
    throw new UnknownAnswer(error?.name === "TimeoutError" ? "timeout" : "request_failed");
  }
  if (!Array.isArray(rows)) throw new UnknownAnswer("invalid_response");
  return rows.length > 0;
}

/**
 * @param {{ env?: Record<string, string | undefined>, fetchImpl?: typeof fetch,
 *   timeoutMs?: number, onUnknown?: (reason: string) => void }} [options]
 * @returns {Promise<boolean | null>}
 */
export async function projectJobWorkerHasPendingWork({
  env = process.env,
  fetchImpl = fetch,
  timeoutMs = CHECK_TIMEOUT_MS,
  onUnknown = () => {},
} = {}) {
  const dataApi = internalDataApi(env);
  if (!dataApi) {
    onUnknown("no_internal_data_api");
    return null;
  }

  const answers = await Promise.allSettled(
    WORK_QUERIES.map((query) => hasRows(dataApi, query, fetchImpl, timeoutMs)),
  );
  if (answers.some((answer) => answer.status === "fulfilled" && answer.value)) return true;
  const failure = answers.find((answer) => answer.status === "rejected");
  if (failure) {
    onUnknown(failure.reason instanceof UnknownAnswer ? failure.reason.reason : "request_failed");
    return null;
  }
  return false;
}
