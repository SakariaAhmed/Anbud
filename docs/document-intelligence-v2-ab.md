# Document Intelligence v2 A/B

Generated: 2026-07-14T17:47:54.409Z

Model: `gpt-5-mini`

Estimated cumulative OpenAI spend: **$0.3126 / $15.00** (66099 new input, 13614 new output tokens), based on [official GPT-5 mini pricing](https://developers.openai.com/api/docs/models/gpt-5-mini).

Denne kjøringen sammenligner produksjonens gamle sidebaserte strukturkart med
identisk råtekst og lokal layout v2. Den første forsøksregelen komprimerte ett
mellomstort dokument og ga svakere dekning. Regelen ble derfor forkastet før
denne endelige kjøringen: primærdokumenter opptil 18 000 tegn beholder nå lokal
råtekst og struktur.

## Aggregate

- Local layout v2 parse: 58 ms average.
- Evidence compile overhead: 7.35 ms average.
- Local v2 context was 6.3% larger because it retained source-rich table structure.
- Compiled evidence selected: 0/3 documents.
- Generation latency: prod 28667 ms, local v2 24323 ms.

| Judge dimension | Prod | Local v2 | Delta |
|---|---:|---:|---:|
| coverage | 8.67 | 8.67 | 0.00 |
| faithfulness | 8.33 | 8.5 | 0.17 |
| specificity | 7.83 | 7.83 | 0.00 |
| source_traceability | 8.67 | 8.83 | 0.16 |

## Documents

| File | Mode | Evidence | Context change | Prod generation | Local v2 generation |
|---|---|---:|---:|---:|---:|
| 063_Bilag_2_Krav_DokumentVern_Forvaltning_IKS.pdf | local_layout_native | 101 | -5.5% | 27338 ms | 23515 ms |
| 083_Bilag_2_Krav_LastVindu_Terminal_SA.pdf | local_layout_native | 78 | -6.2% | 33694 ms | 23321 ms |
| 093_Bilag_2_Krav_StreamArkiv_Produksjon_AS.pdf | local_layout_native | 97 | -7.2% | 24968 ms | 26134 ms |

## Method

- The production side reconstructs the previous page-level PDF structure map.
- Local v2 receives the same raw text plus the new local line/table structure.
- The same model and output contract generated both candidates.
- Two counterbalanced judge orders reduce position bias.

The checked-in canary runs with `node scripts/document_intelligence_ab_eval.mjs`.
For the private hard corpus, set `DOCUMENT_INTELLIGENCE_HARD_CORPUS_ROOT` to its
`PDF` directory and add `--hard-corpus`; no machine-specific path is required.

## Limitations

- Azure Document Intelligence was not called because no local endpoint/key was configured.
- The same GPT-5 mini model generated both candidates and judged two counterbalanced orders.
- The raw PDF text is intentionally identical; the comparison isolates the local parser structure map and adaptive evidence selection.
- The corpus contains three known low-scoring Norwegian PDFs from the existing 50-document parser bake-off.
