#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHmac, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const frontendRoot = path.join(repoRoot, "apps", "frontend");

function parseArgs() {
  const args = process.argv.slice(2);
  const parsed = {
    baseUrl: "http://127.0.0.1:3000",
    projectId: "",
    path: "",
    output: "",
    iterations: 3,
    tab: "evaluation",
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = args[index + 1];
    if (arg === "--base-url" && next) {
      parsed.baseUrl = next;
      index += 1;
    } else if (arg === "--project-id" && next) {
      parsed.projectId = next;
      index += 1;
    } else if (arg === "--path" && next) {
      parsed.path = next;
      index += 1;
    } else if (arg === "--output" && next) {
      parsed.output = next;
      index += 1;
    } else if (arg === "--iterations" && next) {
      parsed.iterations = Math.max(1, Number(next) || 1);
      index += 1;
    } else if (arg === "--tab" && next) {
      parsed.tab = next;
      index += 1;
    }
  }

  if (!parsed.projectId && !parsed.path) {
    throw new Error("Missing --project-id or --path.");
  }

  return parsed;
}

async function loadEnvFile(filePath) {
  let content = "";
  try {
    content = await readFile(filePath, "utf8");
  } catch {
    return;
  }

  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key] != null) continue;
    process.env[key] = rawValue
      .trim()
      .replace(/^(['"])(.*)\1$/, "$2");
  }
}

function base64Url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function createSessionToken(secret) {
  const payload = `v1:${Date.now()}`;
  const signature = base64Url(
    createHmac("sha256", secret).update(payload).digest(),
  );
  return `${payload}.${signature}`;
}

async function waitForJson(url, timeoutMs = 10_000) {
  const startedAt = Date.now();
  let lastError = null;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return await response.json();
      }
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw lastError ?? new Error(`Timed out waiting for ${url}`);
}

function chromeExecutable() {
  if (process.env.CHROME_PATH) {
    return process.env.CHROME_PATH;
  }
  return "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
}

async function launchChrome() {
  const debugPort = 9222 + Math.floor(Math.random() * 1000);
  const userDataDir = await mkdtemp(path.join(tmpdir(), "anbud-chrome-"));
  const chrome = spawn(
    chromeExecutable(),
    [
      "--headless=new",
      "--disable-background-networking",
      "--disable-default-apps",
      "--disable-dev-shm-usage",
      "--disable-extensions",
      "--disable-gpu",
      "--disable-sync",
      "--metrics-recording-only",
      "--mute-audio",
      "--no-default-browser-check",
      "--no-first-run",
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${userDataDir}`,
      "--window-size=1440,1000",
      "about:blank",
    ],
    { stdio: "ignore" },
  );

  await waitForJson(`http://127.0.0.1:${debugPort}/json/version`);

  return {
    debugPort,
    async close() {
      if (!chrome.killed) {
        chrome.kill("SIGTERM");
      }
      await new Promise((resolve) => {
        chrome.once("exit", resolve);
        setTimeout(resolve, 500);
      });
      for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
          await rm(userDataDir, { recursive: true, force: true });
          return;
        } catch (error) {
          if (attempt === 4) throw error;
          await new Promise((resolve) => setTimeout(resolve, 150));
        }
      }
    },
  };
}

class CdpClient {
  constructor(webSocketUrl) {
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.socket = new WebSocket(webSocketUrl);
    this.ready = new Promise((resolve, reject) => {
      this.socket.addEventListener("open", resolve, { once: true });
      this.socket.addEventListener("error", reject, { once: true });
    });
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id) {
        const callbacks = this.pending.get(message.id);
        if (!callbacks) return;
        this.pending.delete(message.id);
        if (message.error) {
          callbacks.reject(new Error(message.error.message));
        } else {
          callbacks.resolve(message.result ?? {});
        }
        return;
      }
      const handlers = this.listeners.get(message.method) ?? [];
      for (const handler of handlers) handler(message.params ?? {});
    });
  }

  async send(method, params = {}) {
    await this.ready;
    const id = this.nextId;
    this.nextId += 1;
    const promise = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.socket.send(JSON.stringify({ id, method, params }));
    return promise;
  }

  on(method, handler) {
    const handlers = this.listeners.get(method) ?? [];
    handlers.push(handler);
    this.listeners.set(method, handlers);
  }

  close() {
    this.socket.close();
  }
}

async function createPage(debugPort) {
  const response = await fetch(`http://127.0.0.1:${debugPort}/json/new`, {
    method: "PUT",
  });
  if (!response.ok) {
    throw new Error(`Could not create Chrome page: HTTP ${response.status}`);
  }
  const target = await response.json();
  return new CdpClient(target.webSocketDebuggerUrl);
}

function summarizeResources(resources) {
  const byType = new Map();
  for (const resource of resources) {
    const entry = byType.get(resource.type) ?? {
      count: 0,
      encodedBytes: 0,
      decodedBytes: 0,
      transferBytes: 0,
    };
    entry.count += 1;
    entry.encodedBytes += resource.encodedBodyLength ?? 0;
    entry.decodedBytes += resource.decodedBodyLength ?? 0;
    entry.transferBytes += resource.transferSize ?? 0;
    byType.set(resource.type, entry);
  }
  return Object.fromEntries(byType.entries());
}

function tabLabel(tab) {
  const labels = {
    documents: "Dokumenter",
    analysis: "Kundeanalyse",
    bilag1: "Bilag 1-utkast",
    "service-description": "Velg tjenester",
    requirements: "Krav",
    generator: "Løsningsforslag",
    evaluation: "Vurdering",
    delivery: "Fremdriftsplan",
    "executive-summary": "Leder",
  };
  return labels[tab] ?? tab;
}

async function evaluate(client, expression, awaitPromise = false) {
  const result = await client.send("Runtime.evaluate", {
    expression,
    awaitPromise,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text ?? "Runtime evaluation failed");
  }
  return result.result?.value;
}

async function waitForLoad(client) {
  await new Promise((resolve) => {
    const timeout = setTimeout(resolve, 15_000);
    client.on("Page.loadEventFired", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

async function waitForNetworkQuiet(inflight, quietMs = 800, timeoutMs = 10_000) {
  const startedAt = Date.now();
  let quietStartedAt = inflight.size === 0 ? Date.now() : 0;
  while (Date.now() - startedAt < timeoutMs) {
    if (inflight.size === 0) {
      quietStartedAt ||= Date.now();
      if (Date.now() - quietStartedAt >= quietMs) return;
    } else {
      quietStartedAt = 0;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function measureOnce({ baseUrl, routePath, sessionToken, tab }) {
  const chrome = await launchChrome();
  const client = await createPage(chrome.debugPort);
  const resources = new Map();
  const inflight = new Set();
  const failedRequests = [];
  const consoleEvents = [];
  const url = `${baseUrl}${routePath}`;

  try {
    client.on("Network.requestWillBeSent", (event) => {
      inflight.add(event.requestId);
      resources.set(event.requestId, {
        url: event.request.url,
        method: event.request.method,
        type: event.type,
        startedAt: event.timestamp,
        status: null,
        encodedBodyLength: 0,
        decodedBodyLength: 0,
      });
    });
    client.on("Network.responseReceived", (event) => {
      const resource = resources.get(event.requestId);
      if (!resource) return;
      resource.status = event.response.status;
      resource.mimeType = event.response.mimeType;
      resource.fromDiskCache = event.response.fromDiskCache;
      resource.fromPrefetchCache = event.response.fromPrefetchCache;
    });
    client.on("Network.loadingFinished", (event) => {
      inflight.delete(event.requestId);
      const resource = resources.get(event.requestId);
      if (!resource) return;
      resource.encodedBodyLength = event.encodedDataLength ?? 0;
    });
    client.on("Network.loadingFailed", (event) => {
      inflight.delete(event.requestId);
      failedRequests.push({
        requestId: event.requestId,
        errorText: event.errorText,
        canceled: event.canceled,
      });
    });
    client.on("Runtime.consoleAPICalled", (event) => {
      consoleEvents.push({
        type: event.type,
        text: event.args?.map((arg) => arg.value ?? arg.description).join(" "),
      });
    });

    await Promise.all([
      client.send("Page.enable"),
      client.send("Network.enable"),
      client.send("Runtime.enable"),
    ]);
    await client.send("Network.setCookie", {
      name: "bidsite_session",
      value: sessionToken,
      url: baseUrl,
      httpOnly: true,
      secure: false,
      sameSite: "Lax",
    });
    await client.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `
        (() => {
          window.__anbudPerf = { longTasks: [], marks: [] };
          try {
            new PerformanceObserver((list) => {
              for (const entry of list.getEntries()) {
                window.__anbudPerf.longTasks.push({
                  name: entry.name,
                  startTime: entry.startTime,
                  duration: entry.duration
                });
              }
            }).observe({ entryTypes: ["longtask"] });
          } catch {}
          try {
            new PerformanceObserver((list) => {
              for (const entry of list.getEntries()) {
                window.__anbudPerf.marks.push({
                  name: entry.name,
                  startTime: entry.startTime,
                  detail: entry.detail ?? null
                });
              }
            }).observe({ entryTypes: ["mark"] });
          } catch {}
        })();
      `,
    });

    const navigationStartedAt = Date.now();
    await client.send("Page.navigate", { url });
    await waitForLoad(client);
    await waitForNetworkQuiet(inflight);

    let interaction = null;
    if (tab && tab !== "none") {
      const clickLabel = tabLabel(tab);
      interaction = await evaluate(
        client,
        `
          (async () => {
            const targetText = ${JSON.stringify(clickLabel)};
            const button = Array.from(document.querySelectorAll("button"))
              .find((element) => (element.innerText || element.textContent || "").includes(targetText));
            if (!button) {
              return { ok: false, reason: "tab button not found", targetText };
            }
            const start = performance.now();
            const frameGaps = [];
            let lastFrame = start;
            let frames = 0;
            const frameProbe = new Promise((resolve) => {
              function tick(now) {
                frameGaps.push(now - lastFrame);
                lastFrame = now;
                frames += 1;
                if (performance.now() - start >= 1200) {
                  resolve();
                } else {
                  requestAnimationFrame(tick);
                }
              }
              requestAnimationFrame(tick);
            });
            button.click();
            await frameProbe;
            return {
              ok: true,
              targetText,
              durationMs: performance.now() - start,
              frames,
              maxFrameGapMs: Math.max(...frameGaps),
              avgFrameGapMs: frameGaps.reduce((sum, value) => sum + value, 0) / Math.max(1, frameGaps.length),
              location: window.location.href
            };
          })()
        `,
        true,
      );
      await waitForNetworkQuiet(inflight);
    }

    const pageMetrics = await evaluate(
      client,
      `
        (() => {
          const nav = performance.getEntriesByType("navigation")[0];
          const paints = Object.fromEntries(
            performance.getEntriesByType("paint").map((entry) => [entry.name, entry.startTime])
          );
          const resourceEntries = performance.getEntriesByType("resource").map((entry) => ({
            name: entry.name,
            initiatorType: entry.initiatorType,
            transferSize: entry.transferSize,
            encodedBodySize: entry.encodedBodySize,
            decodedBodySize: entry.decodedBodySize,
            duration: entry.duration
          }));
          return {
            location: window.location.href,
            title: document.title,
            nav: nav ? {
              domContentLoadedMs: nav.domContentLoadedEventEnd,
              loadMs: nav.loadEventEnd,
              responseStartMs: nav.responseStart,
              responseEndMs: nav.responseEnd,
              transferSize: nav.transferSize,
              encodedBodySize: nav.encodedBodySize,
              decodedBodySize: nav.decodedBodySize
            } : null,
            paints,
            longTasks: window.__anbudPerf?.longTasks ?? [],
            marks: window.__anbudPerf?.marks ?? [],
            resourceEntries,
            domNodes: document.getElementsByTagName("*").length,
            bodyTextLength: document.body?.innerText?.length ?? 0
          };
        })()
      `,
    );

    const networkResources = [...resources.values()].filter((resource) =>
      resource.url.startsWith(baseUrl) ||
      resource.url.startsWith(`${baseUrl.replace("127.0.0.1", "localhost")}`),
    );

    return {
      navigationWallMs: Date.now() - navigationStartedAt,
      pageMetrics,
      interaction,
      requests: networkResources.map((resource) => ({
        url: resource.url.replace(baseUrl, ""),
        method: resource.method,
        type: resource.type,
        status: resource.status,
        encodedBodyLength: resource.encodedBodyLength,
      })),
      resourceSummary: summarizeResources(networkResources),
      failedRequests,
      consoleEvents: consoleEvents.filter((event) =>
        /client_performance_mark|error|warn/i.test(event.text ?? event.type),
      ),
    };
  } finally {
    client.close();
    await chrome.close();
  }
}

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  return sorted[Math.floor(sorted.length / 2)];
}

function totals(run) {
  const scripts = run.pageMetrics.resourceEntries.filter(
    (entry) => entry.initiatorType === "script",
  );
  return {
    domContentLoadedMs: run.pageMetrics.nav?.domContentLoadedMs ?? null,
    loadMs: run.pageMetrics.nav?.loadMs ?? null,
    responseStartMs: run.pageMetrics.nav?.responseStartMs ?? null,
    navigationWallMs: run.navigationWallMs,
    requestCount: run.requests.length,
    scriptTransferBytes: scripts.reduce(
      (sum, entry) => sum + (entry.transferSize || entry.encodedBodySize || 0),
      0,
    ),
    totalTransferBytes: run.pageMetrics.resourceEntries.reduce(
      (sum, entry) => sum + (entry.transferSize || entry.encodedBodySize || 0),
      0,
    ),
    longTaskCount: run.pageMetrics.longTasks.length,
    longTaskTotalMs: run.pageMetrics.longTasks.reduce(
      (sum, task) => sum + task.duration,
      0,
    ),
    maxLongTaskMs: Math.max(
      0,
      ...run.pageMetrics.longTasks.map((task) => task.duration),
    ),
    interactionMaxFrameGapMs: run.interaction?.maxFrameGapMs ?? null,
    domNodes: run.pageMetrics.domNodes,
  };
}

async function main() {
  const args = parseArgs();
  await loadEnvFile(path.join(repoRoot, ".env"));
  await loadEnvFile(path.join(frontendRoot, ".env.local"));
  const sessionSecret = process.env.APP_SESSION_SECRET?.trim();
  if (!sessionSecret) {
    throw new Error("Missing APP_SESSION_SECRET in env.");
  }

  const sessionToken = createSessionToken(sessionSecret);
  const routePath =
    args.path ||
    `/projects/${encodeURIComponent(args.projectId)}`;
  const runs = [];
  for (let index = 0; index < args.iterations; index += 1) {
    runs.push(
      await measureOnce({
        baseUrl: args.baseUrl.replace(/\/+$/, ""),
        routePath,
        sessionToken,
        tab: args.tab,
      }),
    );
  }

  const runTotals = runs.map(totals);
  const summary = {
    generatedAt: new Date().toISOString(),
    benchmarkId: randomUUID(),
    baseUrl: args.baseUrl,
    projectId: args.projectId,
    path: routePath,
    iterations: args.iterations,
    tab: args.tab,
    medians: Object.fromEntries(
      Object.keys(runTotals[0] ?? {}).map((key) => [
        key,
        median(runTotals.map((run) => run[key])),
      ]),
    ),
    runs: runs.map((run, index) => ({
      index: index + 1,
      totals: runTotals[index],
      resourceSummary: run.resourceSummary,
      failedRequests: run.failedRequests,
      consoleEvents: run.consoleEvents,
      topRequests: [...run.requests]
        .sort((a, b) => b.encodedBodyLength - a.encodedBodyLength)
        .slice(0, 12),
      interaction: run.interaction,
    })),
  };

  const output = JSON.stringify(summary, null, 2);
  if (args.output) {
    await writeFile(path.resolve(repoRoot, args.output), `${output}\n`);
  }
  console.log(output);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
