# Retrieval regression corpus

The original 116 Norwegian cases search the ten checked-in fictional complex-tender documents together: 60 exact IDs, 36 development paraphrases and 20 frozen held-out paraphrases. These are retrieval regressions, not an answer-quality or unseen-corpus benchmark. Do not adjust retrieval using held-out failures.

`embeddings.json` contains actual `text-embedding-3-small` responses, recorded through the existing budget proxy. Keys hash the model and exact input; values encode the original vector as float32 little-endian base64. No source documents, prompts, API keys or generated answers are stored in this file. The input documents are the public fictional fixtures already in this repository. Changed inputs or models require explicit recording; replay never falls back to the provider. CI also fails if any fixture is missing, any chunk lacks an embedding, or a question does not exercise the real hybrid SQL RPC.

Run with Node 22 and a loopback disposable pgvector instance (never a production URL):

```sh
cd apps/frontend
npm run rag:eval:sql -- --database-url "$DOCUMENT_CHUNKS_SQL_TEST_DATABASE_URL"
```

Recording is explicit and paid. Start `scripts/speed-quality/budget-proxy.mjs` with the authorized cumulative ledger, the existing private key file and a small phase cap. Then set `OPENAI_BASE_URL` to its loopback `/v1` URL and pass `--record-embeddings` to the recorded evaluation. Never use recording in CI or commit credentials. A replay reports zero provider requests.

The mandatory recorded gate preserves its measured no-reranker baseline and requires rank one for **every** ID case. `--gate --release-gate` enforces the separate 95% conceptual/held-out recall target and MRR ≥0.7. The initial semantic baseline does not pass that release target. Neither gate scores groundedness or citation correctness; budgeted model evaluation must report those separately before release.

### Mixed-source supplement

`--extended-suite` searches the original ten documents together with five checked-in fictional stress documents and four Hålandsvik PDF/DOCX parser snapshots. It measures 20 questions with exact source/page/heading labels, five follow-ups, 23 unamended hierarchical IDs, two amendment questions and five missing IDs. The original holdout is unchanged. Current regression floors retain each group's measured baseline; they do not replace the stricter release quality target.

The Hålandsvik snapshot records source file SHA-256 and parser identity. Regenerate it explicitly with `node scripts/freeze_rag_tender_snapshot.mjs`; this uses the existing local parsers with Docling disabled and makes no model calls. Review parser changes independently. The retrieval gate reads the committed snapshot and checks its source hashes, so CI does not need OCR or an extra PDF dependency.

Recorded embeddings for the supplement use the same explicit recording command with `--extended-suite`. Replay must report zero provider requests and no missing inputs. A supporting subtype is part of the source fingerprint and must match storage; the gate records memory fallback and refuses incomplete embedding fixtures. Exact-ID scores include the persisted register path, not only SQL keyword ranking.
