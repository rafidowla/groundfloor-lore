# recall-eval baseline — surreal-lance / real / 10000 code rows

Generated: 2026-09-23T13:14:09.247Z
Config: candidateFloor=50 lexicalBase=rrf
Fixture: <local>/d3diag/cache/fixture-2e77a69126caddfe (reused=true), counts: {"knowledge":80,"notes":300,"code":10000,"edges":36,"edgesWritten":36}
Timings: fixture 1ms, eval 18366ms, total 20114ms

## Baseline numbers

| metric | value |
|---|---|
| hit@1 (chatty) | 87.5% |
| hit@3 (chatty) | 100.0% |
| MRR (chatty) | 0.938 |
| hit@1 (terse) | 100.0% |
| hit@3 (terse) | 100.0% |
| MRR (terse) | 1.000 |
| terse/chatty top-3 agreement (mean Jaccard) | 45.0% |
| terse/chatty top-3 exact-set-equal | 12.5% |
| anchor in both top-3 (expected node ranks <=3 under BOTH phrasings) | 100.0% |
| top-1 equal (terse vs chatty) | 87.5% |
| prefix stability chatty (top-10@10 == first10@50) | 100.0% |
| prefix stability terse | 100.0% |
| prefix stability BOTH phrasings | 100.0% |
| mean pairwise Jaccard of top-10 (unrelated questions) | 0.023 |
| gibberish zero-hit rate | 0.0% |
| recall() latency p50 / p90 / p95 / p99 (n=220) | 99.1ms / 117.3ms / 126.7ms / 138.1ms |

## Real vs. gibberish top_score quantiles

| set | p0 | p10 | p25 | p50 | p75 | p90 | p100 |
|---|---|---|---|---|---|---|---|
| real (n=24) | 0.845 | 0.853 | 0.869 | 0.888 | 0.905 | 0.916 | 0.919 |
| gibberish (n=60) | 0.758 | 0.772 | 0.779 | 0.786 | 0.797 | 0.806 | 0.814 |

## Negatives (D3 §5.3)

| set | n | topScore null | top-1 lexical-only | top-3 lexical-only slots |
|---|---|---|---|---|
| offtopic | 20 | 2 | 6 | 15/60 |
| unanswerable | 12 | 0 | 5 | 12/36 |
