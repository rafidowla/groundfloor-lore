# recall-eval baseline — surreal-lance / real / 10000 code rows

Generated: 2026-09-23T19:57:53.317Z
Config: candidateFloor=50 lexicalBase=(default)
Fixture: <local>/logs-e3/cache/sl/fixture-2e77a69126caddfe (reused=true), counts: {"knowledge":80,"notes":300,"code":10000,"edges":36,"edgesWritten":36}
Timings: fixture 1ms, eval 27116ms, total 29203ms

## Baseline numbers

| metric | value |
|---|---|
| hit@1 (chatty) | 87.5% |
| hit@3 (chatty) | 100.0% |
| MRR (chatty) | 0.938 |
| hit@1 (terse) | 100.0% |
| hit@3 (terse) | 100.0% |
| MRR (terse) | 1.000 |
| terse/chatty top-3 agreement (mean Jaccard) | 43.7% |
| terse/chatty top-3 exact-set-equal | 12.5% |
| anchor in both top-3 (expected node ranks <=3 under BOTH phrasings) | 100.0% |
| top-1 equal (terse vs chatty) | 87.5% |
| prefix stability chatty (top-10@10 == first10@50) | 100.0% |
| prefix stability terse | 100.0% |
| prefix stability BOTH phrasings | 100.0% |
| mean pairwise Jaccard of top-10 (unrelated questions) | 0.023 |
| gibberish zero-hit rate | 0.0% |
| recall() latency p50 / p90 / p95 / p99 (n=336) | 98.3ms / 130.5ms / 222.3ms / 246.5ms |
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
| calibration build cost | fixture 1ms (includes 128-probe fit; single-flight cached across the run) |
| mean recall() latency | 80.7ms |

| identifiers present (n=20) rank1 / hit@3 / found@10 | 100.0% / 100.0% / 100.0% |
| identifiers present abstained % / rescued | 0.0% / 0 |
| identifiers absent (n=12, no pass bar) zero-hit % / abstained % / rescued | 0.0% / 0.0% / 0 |
| queries[] variant hit@1 / hit@3 / MRR (terse + queries:[chatty]) | 100.0% / 100.0% / 1.000 |
| queries[] variant real-abstained % | 0.0% |
| queries[] variant gibberish zero-hit % | 0.0% |

## Real vs. gibberish top_score quantiles

| set | p0 | p10 | p25 | p50 | p75 | p90 | p100 |
|---|---|---|---|---|---|---|---|
| real (n=24) | 0.845 | 0.853 | 0.869 | 0.888 | 0.905 | 0.916 | 0.919 |
| gibberish (n=60) | 0.758 | 0.772 | 0.779 | 0.786 | 0.797 | 0.806 | 0.814 |


## Negatives (D3 §5.3)

| set | n | topScore null | top-1 lexical-only | top-3 lexical-only slots |
|---|---|---|---|---|
| offtopic | 20 | 0 | 1 | 7/60 |
| unanswerable | 12 | 0 | 2 | 5/36 |

## Identifiers / rare-term (review round 2 item 1)

| metric | value |
|---|---|
| n | 20 |
| rank1 | 100.0% |
| hit@3 | 100.0% |
| found@10 | 100.0% |
| MRR | 1.000 |
