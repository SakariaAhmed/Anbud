# Norwegian OCR verification — 24 September 2026

This follow-up fixes the accent loss observed in the earlier
[ingestion verification](azure-entra-ingestion-verification-2026-09-24.md).
It changes recognition, without substituting words or rewriting original PDFs.

## Cause and selected change

The pinned Docling 2.99.0 runtime automatically selected RapidOCR's default
recognition model. It extracted `maneder` and `Leverandoren` from the frozen
scan. The application's text normalization retained Unicode; it was not the
cause. Merely supplying Norwegian language codes to this Docling version does
not select a Norwegian-capable RapidOCR model.

An isolated experiment with Docling 2.103.0's Latin-language model still produced
`mäneder`, lost `ø`, and corrupted the control code. That candidate was rejected;
neither the Docling upgrade nor its added ONNX dependency is included.

The existing Docling Tesseract integration with `nor,eng` reads the frozen
regression and holdout text exactly. The application now selects that engine and
language pair when OCR is enabled. The production Docker target installs
Tesseract and the Norwegian/English recognition data at build time, before its
existing Perl removal. Runtime recognition requires no network access. Explicit
OCR-off and the existing workflow's decision about when to OCR remain in place.

The CLI compatibility retry retains language, OCR-off and model-directory
settings. Its existing timeout classification also matched `--document-timeout`
inside every failed command, suppressing legitimate compatibility retries. It
now uses the process timeout status. Regressions exercise a real child process,
option rejection, an actual timeout, missing recognition data, automatic OCR and
explicit on/off overrides. Timeouts and missing data do not retry another engine.

## Evidence and repeatability

The [frozen fixtures](../test-data/ocr/expected.json) are fictional image-only
PDFs, with no hidden text layer. The original regression scan is unchanged. A
separate two-page holdout was frozen before testing either candidate: Helvetica,
Times, slight rotation, upper/lowercase Æ/Ø/Å, mixed English/Norwegian, exact
numbers/IDs, and `Far får`, `Bare bære`, `For før`. No fixture or expected wording
was adjusted to make a candidate pass.

The application parser evaluation passes all three pages, comparing complete
source-map text per page after whitespace normalization only. Raw text contains
every expected line; source references, page numbers and original PDF bytes are
preserved. The born-digital tender control produces identical Markdown and JSON
with OCR disabled before and after adding Tesseract. Results, versions, hashes
and rejected attempts are in the
[evidence register](norwegian-ocr-evidence-2026-09-24.json).

Run the same application-level check against a built `runner-docling` image:

```sh
node apps/frontend/scripts/verify_norwegian_ocr.mjs <image>
```

It pins the supplied local image ID, disables network access, runs as UID 1001,
and fails on changed letters, numbers, page attribution or original bytes. It
does not call AI services or write application/customer data.

## Verification boundary

936 frontend, 129 repository and 46 workflow regressions passed without skips,
including disposable PostgreSQL/pgvector and parser golden checks. Lint,
production application build/type checks, secret scan, workflow boundaries,
project-job schema and release-contract checks passed.

The initial recognition comparison used the existing Debian Bookworm / Python
3.12 / Docling 2.99.0 image with Tesseract 5.3.0 and language packages 4.1.0-2
added. The current application's parser ran outside that container and supplied
the actual conversion arguments. This isolates the OCR change from unrelated
Python/package upgrades. These three synthetic scan pages establish the observed
regression and holdout behavior, not character-perfect OCR for every scan, font,
language, handwriting or degradation level.

No production rollout, source backfill or new cloud-ingestion run occurred. The
normal protected release remains required; already-ingested text is unchanged
until explicitly reprocessed. This follow-up made zero paid AI calls, leaving
the prior total at **$1.562117** of the authorized $2.
