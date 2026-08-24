# Document Analysis v3 - stress evaluation

## Outcome

Five fictional, visually verified Norwegian client PDFs were run through the
current v3 local PDF parser, evidence compiler, production prompt, strict
response schema and `gpt-5.6-terra`. The documents cover port operations,
healthcare scheduling, cold-chain logistics, commercial-property energy
management and electric-grid field operations.

The held-out answer key contains 90 manually authored facts and 15 prohibited
claims. It was not included in any production analysis request.

| Client | Facts | Full parser anchors | Deterministic score | Independent judge | Verdict |
|---|---:|---:|---:|---:|---|
| Fjordhavn Kommunale Havn KF | 19 | 84.2% | 86.8% | 9.00/10 | Needs improvement |
| Niva Helsepartner AS | 18 | 72.2% | 97.2% | 9.33/10 | Pass |
| FrostMat Distribusjon AS | 18 | 88.9% | 88.9% | 8.78/10 | Needs improvement |
| Vestbo Eiendom ASA | 17 | 82.4% | 91.2% | 9.22/10 | Needs improvement |
| Nordkraft Nettberedskap AS | 18 | 94.4% | 91.7% | 8.89/10 | Needs improvement |
| **Total / average** | **90** | **84.4%** | **91.1%** | **9.04/10** | **1 pass, 4 need improvement** |

The deterministic comparison found 75 facts present, 14 partial and one
missing. Goals, deadlines, evaluation criteria and risks scored 100%.
Requirements were weakest at 75%, followed by ambiguities at 85%. All five
internal value allocations summed to 100%, and no answer recommended services
when no service catalogue was supplied.

## Material findings

1. FrostMat contains the most consequential error. The source says production
   must be avoided in weeks 47-52, while the answer reverses this into a
   recommended production window. This is a relationship and negation error,
   not a missing keyword.
2. Vestbo incorrectly limits the 12% peak-reduction goal to the seven buildings
   with incomplete baseline data. The source applies the goal more broadly; the
   number seven belongs only to the baseline problem.
3. Nordkraft omits the storm-load volumes of 800 field users and 120 control
   centre users. It also incorrectly associates the 30-minute incident
   notification requirement with an older board decision.
4. Fjordhavn omits the under-five-second update requirement and does not fully
   preserve the 14-versus-18 camera contradiction or the net-30 and 4% price
   adjustment terms.
5. Niva is the strongest answer. Its remaining issues are mild overstatements:
   the contact centre is described as encrypted, and the answer suggests a
   separate clinical-triage capacity that the source does not require.

The canonical context retained every answer-key fact at least partially, but
only 84.4% retained all configured term anchors. All five documents were routed
to the native parser with the diagnostic that parser quality was low but no
structure parser was configured. This environment has neither Docling nor Azure
Document Intelligence configured, so the test exposes the real local-parser
fallback rather than measuring the richer fallback path.

Only 8 of 15 implicit-requirement source excerpts were exact. The automatic
language checker raised 27 conservative punctuation or mojibake flags; the
independent judge nevertheless found the Norwegian generally clear and
professional, with a few anglicisms and grammar issues.

## Recommended follow-up

- Treat negations, blackout windows and contradictory qualifiers as
  first-class evidence relationships, then validate that the answer preserves
  their direction.
- Add a post-generation gate for absolute requirements and paired quantities,
  especially SLA, recovery, scale, retention and commercial terms.
- Configure and re-run the same corpus through the structured Docling fallback,
  or improve local multi-column and pseudo-table reconstruction.
- Validate entity-to-number associations, not only term presence, so values
  such as "7 buildings" cannot migrate to an unrelated goal.
- Require exact excerpts for implicit requirements or omit the excerpt field
  when an exact source span is unavailable.

## Method and budget

Each client PDF is three pages and mixes prose, emails, handwritten-style
notes, contradictions, pseudo-tables and two-column layouts. The answer key is
authored in the source corpus and rendered as a separate six-page PDF. The
corpus generator rejects non-ASCII dash variants, records file hashes and
produces a manifest.

The production answers used the Responses API with low reasoning, strict JSON
Schema and `store: false`. A separate `gpt-5.6-sol` call compared each saved
answer with the held-out key and canonical source. An initial judge rubric
incorrectly treated the required internal `profit_share_percent` allocation as
a client claim; those five verdicts were discarded and the same production
answers were re-judged with a corrected, anchored rubric.

Total API spend was **USD 1.105676 of the USD 15 cap** across 15 calls:

- five production analysis calls: USD 0.293575;
- five discarded judge calls plus five corrected judge calls: USD 0.812101;
- remaining budget: USD 13.894324.

The full local machine-readable report is written to
`reports/document-analysis-stress-eval.json`; reports are ignored because they
contain complete model outputs. The checked-in corpus, PDFs, answer key and
manifest contain fictional data only.

## Reproduce

```bash
python3 scripts/generate_document_analysis_stress_corpus.py
node --test scripts/document_analysis_stress_corpus.test.mjs
node scripts/document_analysis_stress_eval.mjs --dry-run --budget 15
node scripts/document_analysis_stress_eval.mjs --budget 15
```

The evaluator refuses budgets above USD 15 and estimates the maximum cost
before every request. To correct or change only the judge rubric without paying
for new production answers, pass the prior JSON report through
`--reuse-output`.
