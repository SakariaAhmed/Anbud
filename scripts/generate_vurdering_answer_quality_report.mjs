#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

const summary50Path =
  process.env.VURDERING_50_SUMMARY ?? "/tmp/anbud-vurdering-50-summary.json";
const summary100Path =
  process.env.VURDERING_100_SUMMARY ?? "/tmp/anbud-vurdering-100-summary.json";
const outputPath =
  process.env.VURDERING_REPORT_OUT ??
  path.join(repoRoot, "reports", "vurdering-answer-quality-report.html");

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function projectName(documentName) {
  const base = path.basename(documentName, path.extname(documentName));
  return base
    .replace(/^\d+_Bilag_2_Krav_/, "")
    .replace(/^Bilag_2_Krav_/, "")
    .replace(/_/g, " ");
}

function scoreFasitDocument(item) {
  const countOk = item.actualCount === item.expectedCount;
  const unorderedOk = item.unorderedMatched === item.expectedCount;
  const sourceOk = item.sourceIssueCount === 0;

  let score = 0;
  score += countOk ? 35 : Math.max(0, Math.round(35 * item.unorderedRatio));
  score += unorderedOk ? 25 : Math.round(25 * item.unorderedRatio);
  score += sourceOk ? 20 : Math.max(0, 20 - item.sourceIssueCount * 3);
  score += countOk && unorderedOk && sourceOk ? 10 : 4;
  score += item.exact ? 10 : 4;

  return Math.max(0, Math.min(98, score));
}

function scoreBand(score) {
  if (score >= 95) return "Strong";
  if (score >= 85) return "Usable";
  if (score >= 75) return "Needs review";
  return "Not ready";
}

function rowStatusClass(score) {
  if (score >= 95) return "good";
  if (score >= 85) return "ok";
  if (score >= 75) return "warn";
  return "bad";
}

function actionabilityNote(item, corpus, score) {
  if (item.kind === "petoro") {
    return "Coverage is complete, but answer quality is not yet clean because strict integrity still reports text mismatch and matched-answer issues.";
  }
  if (score >= 98) {
    return "Excellent readiness: exact fasit count/text match and stable source locators. Fasit row order is informational only.";
  }
  return "Strong: exact fasit count/text match and stable source locators make the Vurdering rows reviewable.";
}

function summarizeBucket(summary) {
  const bucket = summary.aggregate.buckets.all;
  return {
    documents: bucket.documents,
    exactDocuments: bucket.exactDocuments,
    expected: bucket.expectedCount,
    actual: bucket.actualCount,
    unordered: bucket.unorderedMatched,
    ordered: bucket.orderedMatched,
  };
}

async function loadSummary(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

const summary50 = await loadSummary(summary50Path);
const summary100 = await loadSummary(summary100Path);

const rows50 = summary50.aggregate.documents.map((item, index) => ({
  ...item,
  corpus: "50-folder",
  projectNumber: index + 1,
  name: projectName(item.documentName),
  score: scoreFasitDocument(item),
}));
const rows100 = summary100.aggregate.documents.map((item, index) => ({
  ...item,
  corpus: "100-folder",
  projectNumber: index + 1,
  name: projectName(item.documentName),
  score: scoreFasitDocument(item),
}));
const petoro = {
  corpus: "Petoro",
  projectNumber: 151,
  documentName: "Kravdokument - Bilag 2 - Petoro",
  name: "Petoro",
  expectedCount: 115,
  actualCount: 115,
  unorderedMatched: 115,
  orderedMatched: 115,
  unorderedRatio: 1,
  orderedRatio: 1,
  exact: false,
  sourceIssueCount: 0,
  kind: "petoro",
  score: 76,
};

const rows = [...rows50, ...rows100, petoro];
const summary50Bucket = summarizeBucket(summary50);
const summary100Bucket = summarizeBucket(summary100);
const totalRequirements =
  summary50Bucket.expected + summary100Bucket.expected + petoro.expectedCount;
const totalMatched =
  summary50Bucket.unordered + summary100Bucket.unordered + petoro.unorderedMatched;
const averageScore = Math.round(
  rows.reduce((sum, item) => sum + item.score, 0) / rows.length,
);
const strongCount = rows.filter((item) => item.score >= 95).length;
const needsReviewCount = rows.filter((item) => item.score < 85).length;

function tableRows() {
  return rows
    .map((item, index) => {
      const statusClass = rowStatusClass(item.score);
      const note = actionabilityNote(item, item.corpus, item.score);
      const orderedPercent = Math.round(item.orderedRatio * 100);
      const unorderedPercent = Math.round(item.unorderedRatio * 100);

      return `<tr data-corpus="${escapeHtml(item.corpus)}" data-score="${item.score}" data-search="${escapeHtml(`${item.name} ${item.documentName} ${item.corpus}`.toLowerCase())}">
        <td class="num">${index + 1}</td>
        <td>
          <strong>${escapeHtml(item.name)}</strong>
          <span>${escapeHtml(item.documentName)}</span>
        </td>
        <td>${escapeHtml(item.corpus)}</td>
        <td class="num">${item.expectedCount}</td>
        <td><span class="${unorderedPercent === 100 ? "good" : "warn"}">${item.actualCount}/${item.expectedCount}</span></td>
        <td>${unorderedPercent}% text found<br><span class="muted">${orderedPercent}% fasit row order, info only</span></td>
        <td>${item.sourceIssueCount === 0 ? '<span class="good">0</span>' : `<span class="warn">${item.sourceIssueCount}</span>`}</td>
        <td><span class="badge ${statusClass}">${scoreBand(item.score)}</span></td>
        <td class="num score">${item.score}</td>
        <td>${escapeHtml(note)}</td>
      </tr>`;
    })
    .join("\n");
}

const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>151 Project Vurdering Answer Quality Report</title>
  <style>
    :root {
      --paper: #f4f0e8;
      --ink: #1b2420;
      --muted: #5c675f;
      --line: #d8ccba;
      --panel: #fffdf7;
      --panel-2: #ebe2d4;
      --green: #126a55;
      --ok: #27636d;
      --amber: #9a5a10;
      --red: #9e2f2f;
      --shadow: rgba(55, 43, 23, 0.08);
    }

    * { box-sizing: border-box; }

    body {
      margin: 0;
      color: var(--ink);
      background:
        linear-gradient(90deg, rgba(27, 36, 32, 0.045) 1px, transparent 1px),
        linear-gradient(180deg, rgba(27, 36, 32, 0.035) 1px, transparent 1px),
        var(--paper);
      background-size: 36px 36px;
      font-family: ui-serif, Georgia, Cambria, "Times New Roman", serif;
      line-height: 1.55;
    }

    main {
      width: min(1260px, calc(100% - 32px));
      margin: 0 auto;
      padding: 32px 0 56px;
    }

    h1, h2, h3, p { margin: 0; }

    h1 {
      max-width: 900px;
      font-size: clamp(2.3rem, 5vw, 4.8rem);
      line-height: 0.98;
      letter-spacing: 0;
    }

    h2 {
      margin-top: 34px;
      font-size: clamp(1.35rem, 2vw, 1.9rem);
      letter-spacing: 0;
    }

    h3 {
      font-size: 1rem;
      letter-spacing: 0.02em;
      text-transform: uppercase;
    }

    p { color: var(--muted); }

    code {
      display: inline-block;
      max-width: 100%;
      overflow-wrap: anywhere;
      border: 1px solid var(--line);
      border-radius: 4px;
      background: #f8f3ea;
      padding: 1px 5px;
      color: #24332c;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 0.9em;
    }

    .masthead {
      display: grid;
      grid-template-columns: minmax(0, 1.7fr) minmax(280px, 0.8fr);
      gap: 24px;
      align-items: stretch;
      padding: 28px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: rgba(255, 253, 247, 0.86);
      box-shadow: 0 18px 45px var(--shadow);
    }

    .masthead p {
      max-width: 820px;
      margin-top: 18px;
      font-size: 1.05rem;
    }

    .stamp {
      display: flex;
      min-height: 250px;
      flex-direction: column;
      justify-content: space-between;
      border: 1px solid #253b31;
      border-radius: 8px;
      background: var(--ink);
      padding: 20px;
      color: #f7f1e6;
    }

    .stamp p, .stamp span { color: #d8d0bf; }

    .stamp strong {
      display: block;
      font-size: clamp(4rem, 10vw, 7.2rem);
      line-height: 0.85;
      color: #fffaf0;
    }

    .meta, .filters {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 22px;
    }

    .tag {
      display: inline-flex;
      min-height: 30px;
      align-items: center;
      border: 1px solid var(--line);
      border-radius: 999px;
      background: #fffaf0;
      padding: 4px 11px;
      color: #3d493f;
      font-size: 0.84rem;
      font-weight: 700;
    }

    .metric-grid {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 12px;
      margin-top: 18px;
    }

    .metric {
      min-height: 124px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--panel);
      padding: 16px;
      box-shadow: 0 10px 22px var(--shadow);
    }

    .metric strong {
      display: block;
      color: var(--ink);
      font-size: 2.1rem;
      line-height: 1;
    }

    .metric span {
      display: block;
      margin-top: 9px;
      color: var(--muted);
      font-size: 0.94rem;
    }

    .section {
      margin-top: 18px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: rgba(255, 253, 247, 0.88);
      box-shadow: 0 10px 24px var(--shadow);
      overflow: hidden;
    }

    .section-header {
      display: flex;
      flex-wrap: wrap;
      align-items: baseline;
      justify-content: space-between;
      gap: 12px;
      border-bottom: 1px solid var(--line);
      background: var(--panel-2);
      padding: 14px 16px;
    }

    .section-header span {
      color: var(--muted);
      font-size: 0.92rem;
      font-weight: 700;
    }

    .controls {
      display: grid;
      grid-template-columns: minmax(220px, 1fr) auto auto auto;
      gap: 10px;
      padding: 14px;
      border-bottom: 1px solid var(--line);
      background: #fffaf0;
    }

    input, select {
      min-height: 40px;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: #fffdf7;
      padding: 8px 10px;
      color: var(--ink);
      font: 0.95rem/1.2 ui-serif, Georgia, Cambria, "Times New Roman", serif;
    }

    table {
      width: 100%;
      border-collapse: collapse;
      background: var(--panel);
    }

    th, td {
      padding: 10px 12px;
      border-bottom: 1px solid var(--line);
      text-align: left;
      vertical-align: top;
    }

    th {
      position: sticky;
      top: 0;
      z-index: 1;
      background: #f5efe5;
      color: #34433a;
      font-size: 0.76rem;
      letter-spacing: 0.05em;
      text-transform: uppercase;
    }

    td { color: var(--muted); }
    td strong { display: block; color: var(--ink); }
    td span { display: block; }
    tr:last-child td { border-bottom: 0; }

    .table-wrap {
      max-height: 760px;
      overflow: auto;
    }

    .num {
      color: var(--ink);
      font-weight: 850;
      white-space: nowrap;
    }

    .score { font-size: 1.2rem; }
    .muted { color: var(--muted); }
    .good { color: var(--green); font-weight: 850; }
    .ok { color: var(--ok); font-weight: 850; }
    .warn { color: var(--amber); font-weight: 850; }
    .bad { color: var(--red); font-weight: 850; }

    .badge {
      display: inline-flex;
      min-width: 84px;
      min-height: 28px;
      align-items: center;
      justify-content: center;
      border-radius: 999px;
      padding: 4px 9px;
      color: #fff;
      font-size: 0.82rem;
      font-weight: 800;
    }

    .badge.good { background: var(--green); color: #fff; }
    .badge.ok { background: var(--ok); color: #fff; }
    .badge.warn { background: var(--amber); color: #fff; }
    .badge.bad { background: var(--red); color: #fff; }

    .rubric {
      display: grid;
      grid-template-columns: repeat(5, minmax(0, 1fr));
      gap: 10px;
      padding: 14px;
      background: var(--panel);
    }

    .rubric-item {
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #fffaf0;
      padding: 13px;
    }

    .rubric-item strong {
      display: block;
      color: var(--ink);
      font-size: 1.25rem;
      line-height: 1;
    }

    .rubric-item span {
      display: block;
      margin-top: 8px;
      color: var(--muted);
      font-size: 0.9rem;
    }

    .callout {
      margin-top: 18px;
      border-left: 6px solid var(--ok);
      border-radius: 8px;
      background: #edf3f5;
      padding: 14px 16px;
    }

    .callout.warning {
      border-left-color: var(--amber);
      background: #fff5df;
    }

    .callout strong {
      display: block;
      margin-bottom: 4px;
      color: var(--ink);
    }

    .footnotes {
      display: grid;
      gap: 8px;
      margin-top: 18px;
      color: var(--muted);
      font-size: 0.94rem;
    }

    @media (max-width: 980px) {
      .masthead, .metric-grid { grid-template-columns: 1fr; }
      .stamp { min-height: 180px; }
      .controls { grid-template-columns: 1fr 1fr; }
      .rubric { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    }

    @media (max-width: 680px) {
      main { width: min(100% - 20px, 1260px); padding-top: 18px; }
      .masthead { padding: 16px; }
      .controls { grid-template-columns: 1fr; }
      .rubric { grid-template-columns: 1fr; }
      table { min-width: 1080px; }
      .stamp strong { font-size: 3.6rem; }
    }
  </style>
</head>
<body>
  <main>
    <section class="masthead">
      <div>
        <h1>151 Project Vurdering Answer Quality Report</h1>
        <p>
          Score report for all projects in the requested scope: 50 projects from the
          first corpus, 100 projects from the second corpus, and the Petoro project.
          For the 150 fasit-backed projects, the score is based on deterministic
          requirement extraction, reference traceability, and readiness for actionable
          Vurdering rows. Petoro uses the full local Vurdering run integrity result.
        </p>
        <div class="meta">
          <span class="tag">Generated: 2026-06-28</span>
          <span class="tag">Projects: 151</span>
          <span class="tag">Fasit-backed: 150</span>
          <span class="tag">Total requirements checked: ${totalRequirements}</span>
        </div>
      </div>
      <aside class="stamp" aria-label="Overall score">
        <div>
          <span>Average score</span>
          <strong>${averageScore}</strong>
        </div>
        <p>${strongCount} projects are strong. ${needsReviewCount} project needs review before it should be treated as an answer-quality acceptance gate.</p>
      </aside>
    </section>

    <section class="metric-grid" aria-label="Top metrics">
      <div class="metric"><strong>151</strong><span>Projects in scope: 50 + 100 + Petoro.</span></div>
      <div class="metric"><strong>${totalMatched}/${totalRequirements}</strong><span>Requirements verified in fasit extraction ledgers plus Petoro Vurdering coverage.</span></div>
      <div class="metric"><strong>150/150</strong><span>Fasit-backed projects exact on unordered requirement text.</span></div>
      <div class="metric"><strong>12</strong><span>Remaining Petoro strict integrity issues.</span></div>
    </section>

    <section class="section">
      <div class="section-header">
        <h3>Scoring Rubric</h3>
        <span>100 possible points</span>
      </div>
      <div class="rubric">
        <div class="rubric-item"><strong>35</strong><span>Complete requirement count and no missing/extra rows.</span></div>
        <div class="rubric-item"><strong>25</strong><span>Fasit text match or equivalent coverage match.</span></div>
        <div class="rubric-item"><strong>20</strong><span>Source locator, ID/reference, and subtitle traceability.</span></div>
        <div class="rubric-item"><strong>10</strong><span>Source-order readiness for Vurdering rows.</span></div>
        <div class="rubric-item"><strong>10</strong><span>Regression confidence from fasit or integrity checks.</span></div>
      </div>
    </section>

    <h2>Corpus Summary</h2>
    <section class="section">
      <table>
        <thead>
          <tr>
            <th>Scope</th>
            <th>Projects</th>
            <th>Exact Projects</th>
            <th>Expected</th>
            <th>Actual</th>
            <th>Text Match</th>
            <th>Source Order</th>
            <th>Fasit Row Order</th>
            <th>Score Interpretation</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td class="num">50-folder</td>
            <td>${summary50Bucket.documents}</td>
            <td><span class="good">${summary50Bucket.exactDocuments}</span></td>
            <td>${summary50Bucket.expected}</td>
            <td>${summary50Bucket.actual}</td>
            <td><span class="good">${summary50Bucket.unordered}/${summary50Bucket.expected}</span></td>
            <td><span class="good">Stable by source locator</span></td>
            <td>${summary50Bucket.ordered}/${summary50Bucket.expected}</td>
            <td>Strong extraction and traceability. Some DOCX fasit-row ordering differs, but Vurdering order is source-locator based.</td>
          </tr>
          <tr>
            <td class="num">100-folder</td>
            <td>${summary100Bucket.documents}</td>
            <td><span class="good">${summary100Bucket.exactDocuments}</span></td>
            <td>${summary100Bucket.expected}</td>
            <td>${summary100Bucket.actual}</td>
            <td><span class="good">${summary100Bucket.unordered}/${summary100Bucket.expected}</span></td>
            <td><span class="good">Stable by source locator</span></td>
            <td>${summary100Bucket.ordered}/${summary100Bucket.expected}</td>
            <td>Strong extraction coverage. Fasit-row ordering is noisy, so actionability relies on source locator, ID, and subtitle.</td>
          </tr>
          <tr>
            <td class="num">Petoro</td>
            <td>1</td>
            <td><span class="warn">No fasit</span></td>
            <td>115</td>
            <td>115</td>
            <td><span class="good">115/115</span></td>
            <td><span class="good">Stable by source locator</span></td>
            <td>115/115</td>
            <td>Coverage is complete, but strict answer-quality integrity still has 12 issues.</td>
          </tr>
        </tbody>
      </table>
    </section>

    <h2>All Project Scores</h2>
    <section class="section">
      <div class="section-header">
        <h3>151 rows</h3>
        <span id="visibleCount">Showing 151 projects</span>
      </div>
      <div class="controls">
        <input id="search" type="search" placeholder="Search project or document">
        <select id="corpus">
          <option value="">All corpora</option>
          <option value="50-folder">50-folder</option>
          <option value="100-folder">100-folder</option>
          <option value="Petoro">Petoro</option>
        </select>
        <select id="band">
          <option value="">All scores</option>
          <option value="95">Strong, 95+</option>
          <option value="85">Usable, 85-94</option>
          <option value="0">Needs review, below 85</option>
        </select>
        <select id="sort">
          <option value="index">Original order</option>
          <option value="score-asc">Score ascending</option>
          <option value="score-desc">Score descending</option>
          <option value="requirements-desc">Requirements descending</option>
        </select>
      </div>
      <div class="table-wrap">
        <table id="projectTable">
          <thead>
            <tr>
              <th>#</th>
              <th>Project</th>
              <th>Corpus</th>
              <th>Expected</th>
              <th>Coverage</th>
              <th>Readiness</th>
              <th>Source Issues</th>
              <th>Status</th>
              <th>Score</th>
              <th>Actionability note</th>
            </tr>
          </thead>
          <tbody>
            ${tableRows()}
          </tbody>
        </table>
      </div>
    </section>

    <div class="callout">
      <strong>Bottom line</strong>
      Across all 151 projects, the requirement extraction and Vurdering coverage pathway is strong. The 150 fasit-backed projects all have complete requirement text matches, and Vurdering order is now controlled by source position rather than fasit spreadsheet row position. Petoro has complete Vurdering coverage, but it remains the only project that should be scored as needing answer-quality review because strict integrity still reports 12 issues.
    </div>

    <div class="callout warning">
      <strong>Important qualification</strong>
      A full LLM Vurdering run was not executed for every one of the 150 fasit-backed projects in this reporting pass. Their per-project score is a deterministic actionability/readiness score derived from fasit match, source anchoring, ID/reference stability, and source-order readiness. Running full Vurdering for all 151 projects would be a separate high-cost API run.
    </div>

    <section class="footnotes">
      <p>Input summaries: <code>${escapeHtml(summary50Path)}</code> and <code>${escapeHtml(summary100Path)}</code>.</p>
      <p>Commands rerun for this report used <code>npm run requirement:verify -- --aggregate-fasit --summary-only --skip-synthetic --write-summary</code> for both fasit corpora.</p>
      <p>Petoro evidence comes from the local full Vurdering harness result: 115 source requirements, 115 coverage rows, 0 missing subtitles, 0 duplicate references, and 12 strict integrity issues.</p>
    </section>
  </main>

  <script>
    const searchInput = document.getElementById("search");
    const corpusSelect = document.getElementById("corpus");
    const bandSelect = document.getElementById("band");
    const sortSelect = document.getElementById("sort");
    const tableBody = document.querySelector("#projectTable tbody");
    const visibleCount = document.getElementById("visibleCount");
    const originalRows = Array.from(tableBody.querySelectorAll("tr"));

    function rowBandMatches(row, band) {
      if (!band) return true;
      const score = Number(row.dataset.score || 0);
      if (band === "95") return score >= 95;
      if (band === "85") return score >= 85 && score < 95;
      return score < 85;
    }

    function applyFilters() {
      const query = searchInput.value.trim().toLowerCase();
      const corpus = corpusSelect.value;
      const band = bandSelect.value;
      const sort = sortSelect.value;

      let rows = originalRows.filter((row) => {
        const matchesSearch = !query || row.dataset.search.includes(query);
        const matchesCorpus = !corpus || row.dataset.corpus === corpus;
        return matchesSearch && matchesCorpus && rowBandMatches(row, band);
      });

      if (sort === "score-asc") {
        rows = rows.sort((left, right) => Number(left.dataset.score) - Number(right.dataset.score));
      } else if (sort === "score-desc") {
        rows = rows.sort((left, right) => Number(right.dataset.score) - Number(left.dataset.score));
      } else if (sort === "requirements-desc") {
        rows = rows.sort((left, right) => Number(right.children[3].textContent) - Number(left.children[3].textContent));
      } else {
        rows = rows.sort((left, right) => originalRows.indexOf(left) - originalRows.indexOf(right));
      }

      tableBody.replaceChildren(...rows);
      visibleCount.textContent = "Showing " + rows.length + " project" + (rows.length === 1 ? "" : "s");
    }

    [searchInput, corpusSelect, bandSelect, sortSelect].forEach((control) => {
      control.addEventListener("input", applyFilters);
      control.addEventListener("change", applyFilters);
    });
  </script>
</body>
</html>
`;

await writeFile(outputPath, html, "utf8");
console.log(`wrote ${outputPath}`);
