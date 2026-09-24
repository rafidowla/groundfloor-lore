# recall-eval baseline — surreal-lance / real / 10000 code rows

Generated: 2026-09-23T12:16:36.677Z
Fixture: /tmp/recall-eval-baseline-surreal-lance/fixture-2e77a69126caddfe (reused=false), counts: {"knowledge":80,"notes":300,"code":10000,"edges":36,"edgesWritten":36}
Timings: fixture 66431ms, eval 15794ms, total 82800ms

## Baseline numbers

| metric | value |
|---|---|
| hit@1 (chatty) | 87.5% |
| hit@3 (chatty) | 100.0% |
| MRR (chatty) | 0.938 |
| hit@1 (terse) | 100.0% |
| hit@3 (terse) | 100.0% |
| MRR (terse) | 1.000 |
| terse/chatty top-3 agreement (mean Jaccard) | 40.4% |
| terse/chatty top-3 exact-set-equal | 8.3% |
| prefix stability (top-10@10 == first10@50) | 58.3% |
| mean pairwise Jaccard of top-10 (unrelated questions) | 0.020 |
| gibberish zero-hit rate | 0.0% |

## Real vs. gibberish top_score quantiles

| set | p0 | p10 | p25 | p50 | p75 | p90 | p100 |
|---|---|---|---|---|---|---|---|
| real (n=24) | 0.845 | 0.853 | 0.869 | 0.888 | 0.905 | 0.916 | 0.919 |
| gibberish (n=60) | 0.761 | 0.772 | 0.779 | 0.786 | 0.797 | 0.806 | 0.814 |
