# recall-eval baseline — surreal-lance / real / 10000 code rows

Generated: 2026-09-23T17:50:47.493Z
Fixture: <local>/d/logs-d1m/cache/fixture-2e77a69126caddfe (reused=true), counts: {"knowledge":80,"notes":300,"code":10000,"edges":36,"edgesWritten":36}
Timings: fixture 1ms, eval 23900ms, total 25339ms

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
| gibberish zero-hit rate | 100.0% |
| pooled hit@3 (terse+chatty, n=48) | 100.0% (48/48) |

## D1 — calibration / abstention (abstain=on, gibberish file=gibberish-heldout.json)

| metric | value |
|---|---|
| real questions abstained (of 48 terse+chatty phrasings) | 0 |
| exact-identifier rescue overrides (across all sets) | 12 |
| gibberish abstained % | 100.0% |
| gibberish zero-hit % | 100.0% |
| calibration status(es) seen | ok |
| null_median (mean across questions) | 0.790 |
| null_scale (mean across questions) | 0.024 |
| calibration build cost | fixture 1ms (includes 128-probe fit; single-flight cached across the run) |
| mean recall() latency | 87.9ms |
| distractors zero-hit % (n=24, no pass bar) | 91.7% |
| distractors abstained % | 91.7% |
| identifiers present (n=20) rank1 / hit@3 / found@10 | 80.0% / 85.0% / 90.0% |
| identifiers present abstained % / rescued | 0.0% / 12 |
| identifiers absent (n=12, no pass bar) zero-hit % / abstained % / rescued | 50.0% / 50.0% / 0 |
| queries[] variant hit@3 | 100.0% |
| queries[] variant real-abstained % | 0.0% |
| queries[] variant gibberish zero-hit % | 100.0% |

## Real vs. gibberish top_score quantiles

| set | p0 | p10 | p25 | p50 | p75 | p90 | p100 |
|---|---|---|---|---|---|---|---|
| real (n=24) | 0.845 | 0.853 | 0.869 | 0.888 | 0.905 | 0.916 | 0.919 |
| gibberish (n=60) | n/a | n/a | n/a | n/a | n/a | n/a | n/a |
| distractors (n=24) | 0.849 | 0.849 | 0.849 | 0.859 | 0.859 | 0.859 | 0.859 |
