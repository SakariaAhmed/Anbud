import { closeSync, existsSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";

// Official standard prices, checked 2026-09-08:
// https://developers.openai.com/api/docs/pricing
// Use maximum/cache-write rates, or proven short-context GPT-5.4 rates, plus 10%.
const rates = {
  "gpt-5.4": [5, 22.5],
  "gpt-5.4-mini": [0.75, 4.5],
  "gpt-5.6-terra": [5, 18],
  "gpt-5.6-luna": [0.5, 1.8],
  "text-embedding-3-small": [0.02, 0],
};
// Rechecked against pricing plus both model pages on 2026-09-08. GPT-5.6
// long-context pricing begins above 272K input tokens. Keep the stricter 256K
// input-upper-bound + maximum-output guard and charge all input as cache writes.
const shortRates = { "gpt-5.4": [2.5, 15], "gpt-5.6-terra": [2.5, 12], "gpt-5.6-luna": [0.25, 1.2] };
const fastShortRates = { "gpt-5.4": [5, 30], "gpt-5.6-terra": [5, 24], "gpt-5.6-luna": [0.5, 2.4] };
const fastLongRates = { "gpt-5.6-terra": [10, 36], "gpt-5.6-luna": [1, 3.6] };
export const ACCOUNTING_POLICY = "verified-cache-usage-or-full-reservation-v5";
export const ACCOUNTING_POLICY_V4 = "verified-tiered-usage-or-full-reservation-v4";
export const ACCOUNTING_POLICY_V3 = "verified-bounded-short-usage-or-full-reservation-v3";

// Reconcile only verifiable text-token usage. Unknown, malformed, failed
// transport and in-flight requests retain their complete preflight reservation.
// Keep the historical reservation on disk for every request, including retries.
function accountedForPolicy(row, includeGpt56Short, allowFast = false, allowCached = false) {
  const fallback = row.reservedUsd;
  if (row.status !== 200 || !row.usage || !rates[row.model]) return fallback;
  const embedding = row.model.startsWith("text-embedding-");
  const input = row.usage.prompt_tokens ?? row.usage.input_tokens;
  const output = row.usage.completion_tokens ?? row.usage.output_tokens ?? (embedding ? 0 : undefined);
  if (!Number.isSafeInteger(input) || input < 0 || !Number.isSafeInteger(output) || output < 0 || input > row.inputTokensUpperBound || output > row.outputTokensLimit) return fallback;
  if (!Number.isSafeInteger(row.inputTokensUpperBound) || !Number.isSafeInteger(row.outputTokensLimit)) return fallback;
  if (row.usage.total_tokens !== undefined && row.usage.total_tokens !== input + output) return fallback;
  const [maximumInput, maximumOutput] = rates[row.model];
  const eligibleShort = row.model === "gpt-5.4" && row.priceTier === "bounded-short" || includeGpt56Short && ["gpt-5.6-terra", "gpt-5.6-luna"].includes(row.model) && [undefined, "maximum", "bounded-short"].includes(row.priceTier);
  const short = eligibleShort && row.inputTokensUpperBound + row.outputTokensLimit < 256_000;
  let selectedRates = short ? shortRates[row.model] : [maximumInput, maximumOutput];
  let cacheShort = short;
  if (row.requestedServiceTier === "priority") {
    if (!allowFast || !["priority", "fast", "default"].includes(row.returnedServiceTier)) return fallback;
    if (row.returnedServiceTier !== "default") {
      cacheShort = row.inputTokensUpperBound + row.outputTokensLimit < 256_000;
      selectedRates = cacheShort ? fastShortRates[row.model] : fastLongRates[row.model];
      if (!selectedRates) return fallback;
    }
  } else if (row.requestedServiceTier !== undefined && row.requestedServiceTier !== "default") return fallback;
  const [inputRate, outputRate] = selectedRates;
  let cached = 0;
  let cacheRate = inputRate;
  // Discount only explicitly returned, internally consistent cache reads.
  // Every other input token retains the maximum cache-write rate. Preflight
  // never assumes a cache hit; failed/unknown requests returned above in full.
  const readRates = { "gpt-5.4": [0.25, 0.5], "gpt-5.6-terra": [0.2, 0.4], "gpt-5.6-luna": [0.02, 0.04] };
  const details = row.usage.input_tokens_details ?? row.usage.prompt_tokens_details;
  const ambiguousDetails = row.usage.input_tokens_details && row.usage.prompt_tokens_details;
  if (allowCached && readRates[row.model] && details && !ambiguousDetails) {
    const count = details.cached_tokens;
    const writes = details.cache_write_tokens;
    if (Number.isSafeInteger(count) && count >= 0 && count <= input &&
        (writes === undefined || Number.isSafeInteger(writes) && writes >= 0 && writes <= input - count)) {
      cached = count;
      const fast = row.requestedServiceTier === "priority" && row.returnedServiceTier !== "default";
      cacheRate = readRates[row.model][cacheShort ? 0 : 1] * (fast ? 2 : 1);
    }
  }
  const bound = Math.ceil(((input - cached) * inputRate + cached * cacheRate + output * outputRate) * 1.1) / 1e6;
  return bound >= 0 && bound <= fallback ? bound : fallback;
}
// V2 remains callable solely to audit the explicit policy transition. Neither
// calculation modifies historical rows or their recorded priceTier/reservedUsd.
export const accountedCostUpperBoundV2 = (row) => accountedForPolicy(row, false);
export const accountedCostUpperBoundV3 = (row) => accountedForPolicy(row, true);
export const accountedCostUpperBoundV4 = (row) => accountedForPolicy(row, true, true);
export const accountedCostUpperBound = (row) => accountedForPolicy(row, true, true, true);

export function prepareRequest(endpoint, original, outputLimit = 8000, serviceTier = "default") {
  if (!["default", "priority"].includes(serviceTier)) throw new Error("Unpriced service tier.");
  if (!["/v1/chat/completions", "/v1/responses", "/v1/embeddings"].includes(endpoint)) {
    throw new Error("Unsupported endpoint: only text generation and embeddings are budgeted.");
  }
  if (!rates[original.model]) throw new Error("Model has no verified budget rate.");
  if (!Number.isSafeInteger(outputLimit) || outputLimit < 1 || outputLimit > 16000) {
    throw new Error("Invalid evaluation output limit.");
  }
  const request = structuredClone(original);
  const embedding = endpoint.endsWith("/embeddings");
  const requestedServiceTier = embedding ? "default" : serviceTier;
  if (embedding) delete request.service_tier;
  if (embedding !== request.model.startsWith("text-embedding-")) throw new Error("Model/endpoint mismatch.");
  if (request.tools?.length || request.previous_response_id || request.conversation || request.background) {
    throw new Error("Tools and externally retained context are not budgeted.");
  }
  // Files, images, audio, pre-tokenized embeddings and hidden context need a
  // different input bound. Refuse them instead of estimating from payload size.
  const content = embedding ? request.input : request.messages ?? request.input;
  function validateText(value) {
    if (typeof value === "string") return;
    if (Array.isArray(value)) { value.forEach(validateText); return; }
    if (!value || typeof value !== "object") throw new Error("Only text inputs are budgeted.");
    if (value.type && !["text", "input_text", "message"].includes(value.type)) throw new Error("Only text inputs are budgeted.");
    if (Object.keys(value).some((key) => /image|audio|file|tool|function|video/i.test(key))) throw new Error("Only text inputs are budgeted.");
    if (value.content !== undefined) validateText(value.content);
    else if (typeof value.text !== "string") throw new Error("Only text inputs are budgeted.");
  }
  validateText(content);
  let outputTokens = 0;
  if (!embedding) {
    request.service_tier = requestedServiceTier;
    request.store = false;
    if (endpoint.endsWith("/chat/completions") && request.stream) request.stream_options = { ...request.stream_options, include_usage: true };
    if (request.n !== undefined && request.n !== 1) throw new Error("Multiple outputs are not budgeted.");
    const field = endpoint.endsWith("/responses") ? "max_output_tokens" : "max_completion_tokens";
    const supplied = request[field] ?? request.max_tokens ?? outputLimit;
    if (!Number.isSafeInteger(supplied) || supplied < 1) throw new Error("Invalid output bound.");
    outputTokens = Math.min(supplied, outputLimit);
    request[field] = outputTokens;
    delete request.max_tokens;
  }
  // One token per UTF-8 byte is a conservative text-token upper bound. JSON
  // serialization plus 4096 tokens covers schema and message framing overhead.
  const inputTokens = Buffer.byteLength(JSON.stringify(request), "utf8") + 4096;
  // The UTF-8 upper bound plus all output is below the documented 272K
  // threshold, so eligible models cannot enter the more expensive context tier.
  // Keep 16K headroom beneath that threshold and never revise old reservations.
  const priceTier = shortRates[request.model] && inputTokens + outputTokens < 256_000 ? "bounded-short" : "maximum";
  let selectedRates = priceTier === "bounded-short" ? shortRates[request.model] : rates[request.model];
  if (requestedServiceTier === "priority") {
    selectedRates = inputTokens + outputTokens < 256_000 ? fastShortRates[request.model] : fastLongRates[request.model];
    if (!selectedRates) throw new Error("Fast model/long-context price is not verified.");
  }
  const [inputRate, outputRate] = selectedRates;
  const reservedUsd = Math.ceil((inputTokens * inputRate + outputTokens * outputRate) * 1.1) / 1e6;
  return { request, requestedServiceTier, inputTokens, outputTokens, reservedUsd, priceTier, inputRate, outputRate, requestSha256: createHash("sha256").update(JSON.stringify(request)).digest("hex"), inputSha256: createHash("sha256").update(JSON.stringify({ content, instructions: request.instructions, response_format: request.response_format, text: request.text })).digest("hex") };
}

const moneyMicros = (value) => Math.round(value * 1e6);
const requestsHash = (rows) => createHash("sha256").update(JSON.stringify(rows)).digest("hex");
export function validatedBudgetLimit(ledger) {
  if (!Array.isArray(ledger.requests)) throw new Error("Invalid budget requests.");
  const events = ledger.budgetAuthorizations ?? [];
  if (!Array.isArray(events)) throw new Error("Invalid budget authorizations.");
  let limit = events[0]?.previousLimitUsd ?? ledger.limitUsd;
  if (!(Number.isFinite(limit) && limit > 0 && limit <= 14)) throw new Error("Initial budget must be at most 14 USD.");
  let previousCount = 0;
  const ids = new Set();
  for (const event of events) {
    const count = event.previousRequestCount;
    if (!Number.isSafeInteger(count) || count < previousCount || count > ledger.requests.length ||
        !Number.isFinite(event.additionalBudgetUsd) || event.additionalBudgetUsd <= 0 || event.additionalBudgetUsd > 14 || event.additionalBudgetUsd !== moneyMicros(event.additionalBudgetUsd) / 1e6 ||
        !event.sourceMessageId || !event.sourceThreadId || !event.userStatement || !Number.isFinite(Date.parse(event.observedAt)) ||
        !/^[a-f0-9]{64}$/.test(event.previousLedgerSha256 ?? "") || ids.has(event.sourceMessageId)) throw new Error("Invalid explicit budget authorization.");
    const prefix = ledger.requests.slice(0, count);
    const usedMicros = prefix.reduce((sum, row) => sum + moneyMicros(accountedCostUpperBound(row)), 0);
    if (prefix.some((row) => ["reserved", "pending"].includes(row.status)) || requestsHash(prefix) !== event.previousRequestsSha256 ||
        event.previousLimitUsd !== limit || usedMicros !== moneyMicros(event.accountedUpperBoundAtAuthorizationUsd) ||
        moneyMicros(event.newLimitUsd) !== usedMicros + moneyMicros(event.additionalBudgetUsd)) throw new Error("Budget authorization does not match preserved history.");
    limit = event.newLimitUsd; previousCount = count; ids.add(event.sourceMessageId);
  }
  if (ledger.limitUsd !== limit) throw new Error("Unrecorded budget limit change.");
  return limit;
}

export function openBudgetLedger(file, requestedLimitUsd) {
  if (requestedLimitUsd !== undefined && !(Number.isFinite(requestedLimitUsd) && requestedLimitUsd > 0)) throw new Error("Invalid requested budget.");
  const lock = `${file}.lock`;
  const descriptor = openSync(lock, "wx", 0o600);
  closeSync(descriptor);
  let ledger;
  try {
    ledger = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {
      version: 1, limitUsd: requestedLimitUsd ?? 14, createdAt: new Date().toISOString(), requests: [],
    };
    if (ledger.version !== 1 || requestedLimitUsd !== undefined && ledger.limitUsd !== requestedLimitUsd || !Array.isArray(ledger.requests)) throw new Error("Invalid existing ledger.");
    if (ledger.requests.some((r) => !(r.reservedUsd > 0) || !Number.isFinite(r.reservedUsd))) throw new Error("Invalid reservation.");
    validatedBudgetLimit(ledger);
  } catch (error) { unlinkSync(lock); throw error; }
  ledger.accountingPolicy = ACCOUNTING_POLICY;
  // Keep old recorded derived costs as historical data. The live aggregate is
  // always recomputed under the named policy, never trusted from saved totals.
  function save() {
    const temporary = `${file}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(ledger, null, 2)}\n`, { mode: 0o600, flush: true });
    renameSync(temporary, file);
  }
  // Historical reservations remain intact; verified usage may settle lower.
  // Check committed upper bounds plus all pending/unknown reservations before
  // every call, under the same exclusive process lock.
  function total() { return ledger.requests.reduce((sum, row) => sum + row.reservedUsd, 0); }
  function accountedTotal() { return ledger.requests.reduce((sum, row) => sum + moneyMicros(accountedCostUpperBound(row)), 0) / 1e6; }
  save();
  return {
    reserve({ endpoint, model, inputTokens, outputTokens, reservedUsd, phase, phaseBudgetUsd, requestSha256, inputSha256, priceTier, inputRate, outputRate, requestedServiceTier }) {
      if (!(reservedUsd > 0) || !Number.isFinite(reservedUsd) || reservedUsd !== moneyMicros(reservedUsd) / 1e6 || moneyMicros(accountedTotal()) + moneyMicros(reservedUsd) > moneyMicros(ledger.limitUsd)) throw new Error("Evaluation budget exhausted.");
      if (phaseBudgetUsd !== undefined) {
        if (!phase || !(Number.isFinite(phaseBudgetUsd) && phaseBudgetUsd > 0 && phaseBudgetUsd <= 14)) throw new Error("Invalid phase budget.");
        const used = ledger.requests.filter((row) => row.phase === phase).reduce((sum, row) => sum + moneyMicros(accountedCostUpperBound(row)), 0);
        if (used + moneyMicros(reservedUsd) > moneyMicros(phaseBudgetUsd)) throw new Error("Evaluation phase budget exhausted.");
      }
      const row = { id: randomUUID(), at: new Date().toISOString(), accountingPolicy: ACCOUNTING_POLICY, phase, phaseBudgetUsd, endpoint, model, requestSha256, inputSha256, requestedServiceTier, priceTier, inputRatePerMillion: inputRate, outputRatePerMillion: outputRate, inputTokensUpperBound: inputTokens, outputTokensLimit: outputTokens, reservedUsd, status: "reserved" };
      ledger.requests.push(row);
      save();
      return row.id;
    },
    finish(id, { status, durationMs, usage, completion, firstContentMs, returnedServiceTier }) {
      const row = ledger.requests.find((row) => row.id === id);
      if (!row) throw new Error("Unknown reservation.");
      Object.assign(row, { status, durationMs, usage, completion, firstContentMs, returnedServiceTier });
      row.accountedCostUpperBoundUsd = accountedCostUpperBound(row);
      save();
    },
    authorizeAdditionalBudget(authorization) {
      if (!existsSync(file) || ledger.requests.some((row) => ["reserved", "pending"].includes(row.status))) throw new Error("Cannot refill with pending requests.");
      const previousLedgerSha256 = createHash("sha256").update(readFileSync(file)).digest("hex");
      if (authorization.previousLedgerSha256 !== previousLedgerSha256) throw new Error("Refill authorization targets a different ledger state.");
      const event = { ...authorization, previousRequestCount: ledger.requests.length, previousRequestsSha256: requestsHash(ledger.requests), previousLimitUsd: ledger.limitUsd,
        accountedUpperBoundAtAuthorizationUsd: accountedTotal(), newLimitUsd: (moneyMicros(accountedTotal()) + moneyMicros(authorization.additionalBudgetUsd)) / 1e6 };
      const updated = { ...ledger, limitUsd: event.newLimitUsd, budgetAuthorizations: [...(ledger.budgetAuthorizations ?? []), event] };
      validatedBudgetLimit(updated);
      ledger = updated; save(); return structuredClone(event);
    },
    snapshot() { return structuredClone({ ...ledger, accountingPolicy: ACCOUNTING_POLICY, reservedUsd: total(), accountedUpperBoundUsd: accountedTotal(), remainingUsd: (moneyMicros(ledger.limitUsd) - moneyMicros(accountedTotal())) / 1e6 }); },
    close() { unlinkSync(lock); },
  };
}
