#!/usr/bin/env node
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { once } from "node:events";
import { openBudgetLedger, prepareRequest } from "./budget.mjs";
import { forwardStream } from "./stream-response.mjs";

const args = new Map(process.argv.slice(2).reduce((pairs, value, index, all) => index % 2 ? pairs : [...pairs, [value, all[index + 1]]], []));
const ledgerPath = args.get("--ledger");
const keyFile = args.get("--key-env");
const phase = args.get("--phase");
if (!ledgerPath || !keyFile || !phase) throw new Error("Required: --ledger <file> --key-env <existing env file> --phase <label> [--port 4319] [--output-limit 8000]");
// Read only the API key, never load production database/storage/auth settings.
const match = /^OPENAI_API_KEY\s*=\s*(.+)$/m.exec(readFileSync(keyFile, "utf8"));
const apiKey = match?.[1].trim().replace(/^(['"])(.*)\1$/, "$2");
if (!apiKey) throw new Error("API key is missing.");
const ledger = openBudgetLedger(ledgerPath);
const outputLimit = Number(args.get("--output-limit") ?? 8000);
const server = createServer(async (request, response) => {
  const started = performance.now();
  let reservation;
  try {
    if (request.method === "GET" && request.url === "/budget") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(ledger.snapshot()));
      return;
    }
    if (request.method !== "POST") throw new Error("Only POST is supported.");
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > 2_000_000) throw new Error("Evaluation request too large.");
      chunks.push(chunk);
    }
    const endpoint = new URL(request.url, "http://localhost").pathname;
    const original = JSON.parse(Buffer.concat(chunks).toString());
    // The 32-requirement baseline exceeded the initial 8K evaluation cap in
    // a batch. Use the same sufficient cap for baseline and candidate; retain
    // the failed earlier run and its charge rather than calling it a speed win.
    const evaluationLimit = /solution-evaluation-holistic|requirement-response-batch/.test(String(original.prompt_cache_key ?? "")) ? 16000 : outputLimit;
    const prepared = prepareRequest(endpoint, original, evaluationLimit);
    reservation = ledger.reserve({ ...prepared, endpoint, model: prepared.request.model, phase });
    const upstream = await fetch(`https://api.openai.com${endpoint}`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify(prepared.request),
      signal: AbortSignal.timeout(240_000),
    });
    if (upstream.ok && prepared.request.stream) {
      response.statusCode = upstream.status;
      response.setHeader("content-type", upstream.headers.get("content-type") ?? "text/event-stream");
      response.flushHeaders();
      const metadata = await forwardStream(upstream.body, async (chunk) => {
        if (!response.write(chunk)) await once(response, "drain");
      }, started);
      ledger.finish(reservation, { status: upstream.status, durationMs: Math.round(performance.now() - started), ...metadata });
      response.end();
      return;
    }
    const body = Buffer.from(await upstream.arrayBuffer());
    let usage;
    let completion;
    if (upstream.ok && !prepared.request.stream) {
      const parsed = JSON.parse(body.toString());
      usage = parsed.usage;
      completion = {
        status: parsed.status,
        incompleteReason: parsed.incomplete_details?.reason,
        finishReasons: parsed.choices?.map((choice) => choice.finish_reason),
      };
    }
    ledger.finish(reservation, { status: upstream.status, durationMs: Math.round(performance.now() - started), usage, completion });
    response.statusCode = upstream.status;
    response.setHeader("content-type", upstream.headers.get("content-type") ?? "application/json");
    response.end(upstream.ok ? body : JSON.stringify({ error: { message: `Evaluation provider request failed (HTTP ${upstream.status}).`, type: "evaluation_provider_error" } }));
  } catch {
    if (reservation) ledger.finish(reservation, { status: "uncertain", durationMs: Math.round(performance.now() - started) });
    if (response.headersSent) response.destroy();
    else {
      response.statusCode = 400; // Non-retryable: budget refusal must stop SDK retries.
      response.end(JSON.stringify({ error: { message: "Evaluation request refused or failed; inspect the local budget ledger.", type: "evaluation_budget_error" } }));
    }
  }
});
server.listen(Number(args.get("--port") ?? 4319), "127.0.0.1", () => console.log("Budget proxy listening on loopback; verified usage bounds plus unresolved and new reservations cannot exceed 14 USD."));
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => server.close(() => { ledger.close(); process.exit(0); }));
