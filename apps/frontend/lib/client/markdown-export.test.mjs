import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../../", import.meta.url));
const jiti = createJiti(import.meta.url, { alias: { "@": root }, jsx: { runtime: "automatic" }, fsCache: false });
const { MarkdownViewer } = jiti("../../components/projects/markdown-viewer.tsx");
const render = (content) => renderToStaticMarkup(React.createElement(MarkdownViewer, { content }));

test("export renderer preserves nested headings, emphasis, lists and GFM tables", () => {
  const html = render("### Leveranse\n\n**Viktig**\n\n1. Første\n2. Andre\n\n| Krav | Svar |\n| --- | --- |\n| K-05 | Må avklares |");
  assert.match(html, /<h3>Leveranse<\/h3>/);
  assert.match(html, /<strong>Viktig<\/strong>/);
  assert.match(html, /<ol>/);
  assert.match(html, /<table>/);
  assert.match(html, /<td>K-05<\/td>/);
});

test("export renderer excludes raw HTML and executable Markdown links", () => {
  const html = render('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n[unsafe](javascript:alert%281%29)\n\n[safe](https://example.com)');
  assert.doesNotMatch(html, /<script|onerror|javascript:/);
  assert.match(html, /href="https:\/\/example.com\/?"/);
});
