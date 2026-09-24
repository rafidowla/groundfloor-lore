# recall-eval baseline — sqlite / real / 100000 code rows

Generated: 2026-09-23T13:33:58.630Z
Fixture: /var/folders/c_/wq1jc0xn3yz3kcl00ff68bch0000gn/T/recall-eval-wKILDK/fixture-8b692b1d01256e81 (reused=false), counts: {"knowledge":80,"notes":300,"code":100000,"edges":36,"edgesWritten":36}
Timings: fixture 581849ms, eval 34132ms, total 616029ms

## Baseline numbers

| metric | value |
|---|---|
| hit@1 (chatty) | 87.5% |
| hit@3 (chatty) | 100.0% |
| MRR (chatty) | 0.938 |
| hit@1 (terse) | 100.0% |
| hit@3 (terse) | 100.0% |
| MRR (terse) | 1.000 |
| terse/chatty top-3 agreement (mean Jaccard) | 37.1% |
| terse/chatty top-3 exact-set-equal | 4.2% |
| prefix stability (top-10@10 == first10@50) | 79.2% |
| mean pairwise Jaccard of top-10 (unrelated questions) | 0.020 |
| gibberish zero-hit rate | 0.0% |
| pooled hit@3 (terse+chatty, n=48) | 100.0% (48/48) |

## D1 — calibration / abstention (abstain=off, gibberish file=gibberish.json)

| metric | value |
|---|---|
| real questions abstained (of 48 terse+chatty phrasings) | 0 |
| gibberish abstained % | 0.0% |
| gibberish zero-hit % | 0.0% |
| calibration status(es) seen | ok |
| null_median (mean across questions) | 0.790 |
| null_scale (mean across questions) | 0.024 |
| calibration build cost | fixture 581849ms (includes 128-probe fit; single-flight cached across the run) |
| mean recall() latency | 258.6ms |



## Real vs. gibberish top_score quantiles

| set | p0 | p10 | p25 | p50 | p75 | p90 | p100 |
|---|---|---|---|---|---|---|---|
| real (n=24) | 0.845 | 0.853 | 0.869 | 0.888 | 0.905 | 0.916 | 0.919 |
| gibberish (n=60) | 0.763 | 0.772 | 0.780 | 0.787 | 0.798 | 0.808 | 0.815 |

