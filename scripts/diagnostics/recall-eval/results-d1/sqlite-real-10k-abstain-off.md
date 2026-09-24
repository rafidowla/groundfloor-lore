# recall-eval baseline — sqlite / real / 10000 code rows

Generated: 2026-09-23T15:42:57.388Z
Fixture: ../logs-d1m/cache/fixture-f4b536ccd6b5d820 (reused=true), counts: {"knowledge":80,"notes":300,"code":10000,"edges":36,"edgesWritten":36}
Timings: fixture 2ms, eval 6161ms, total 7209ms

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
| mean pairwise Jaccard of top-10 (unrelated questions) | 0.021 |
| gibberish zero-hit rate | 0.0% |
| pooled hit@3 (terse+chatty, n=48) | 100.0% (48/48) |

## D1 — calibration / abstention (abstain=off, gibberish file=gibberish.json)

| metric | value |
|---|---|
| real questions abstained (of 48 terse+chatty phrasings) | 0 |
| exact-identifier rescue overrides (across all sets) | 0 |
| gibberish abstained % | 0.0% |
| gibberish zero-hit % | 0.0% |
| calibration status(es) seen | pending, ok |
| null_median (mean across questions) | 0.790 |
| null_scale (mean across questions) | 0.024 |
| calibration build cost | fixture 2ms (includes 128-probe fit; single-flight cached across the run) |
| mean recall() latency | 37.6ms |

| identifiers present (n=20) rank1 / hit@3 / found@10 | 85.0% / 90.0% / 95.0% |
| identifiers present abstained % / rescued | 0.0% / 0 |
| identifiers absent (n=12, no pass bar) zero-hit % / abstained % / rescued | 0.0% / 0.0% / 0 |


## Real vs. gibberish top_score quantiles

| set | p0 | p10 | p25 | p50 | p75 | p90 | p100 |
|---|---|---|---|---|---|---|---|
| real (n=24) | 0.845 | 0.853 | 0.869 | 0.888 | 0.905 | 0.916 | 0.919 |
| gibberish (n=60) | 0.761 | 0.772 | 0.779 | 0.786 | 0.797 | 0.806 | 0.814 |

