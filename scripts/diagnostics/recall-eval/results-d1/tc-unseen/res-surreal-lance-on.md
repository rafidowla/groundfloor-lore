# recall-eval baseline — surreal-lance / real / 10000 code rows

Generated: 2026-09-23T22:50:49.577Z
Config: candidateFloor=(default) lexicalBase=(default)
Fixture: $F/logs-e1v/cache-sl-on/fixture-2e77a69126caddfe (reused=true), counts: {"knowledge":80,"notes":300,"code":10000,"edges":36,"edgesWritten":36}
Timings: fixture 2ms, eval 36010ms, total 37577ms

## Baseline numbers

| metric | value |
|---|---|
| hit@1 (chatty) | 40.9% |
| hit@3 (chatty) | 47.7% |
| MRR (chatty) | 0.460 |
| hit@1 (terse) | 61.4% |
| hit@3 (terse) | 70.5% |
| MRR (terse) | 0.655 |
| terse/chatty top-3 agreement (mean Jaccard) | 23.4% |
| terse/chatty top-3 exact-set-equal | 9.1% |
| anchor in both top-3 (expected node ranks <=3 under BOTH phrasings) | 36.4% |
| top-1 equal (terse vs chatty) | 27.3% |
| prefix stability chatty (top-10@10 == first10@50) | 88.6% |
| prefix stability terse | 70.5% |
| prefix stability BOTH phrasings | 65.9% |
| mean pairwise Jaccard of top-10 (unrelated questions) | 0.046 |
| gibberish zero-hit rate | 100.0% |
| recall() latency p50 / p90 / p95 / p99 (n=294) | 108.3ms / 122.7ms / 128.1ms / 132.2ms |
| pooled hit@3 (terse+chatty, n=88) | 59.1% (52/88) |

## D1 — calibration / abstention (abstain=on, gibberish file=gibberish.json)

| metric | value |
|---|---|
| real questions abstained (of 88 terse+chatty phrasings) | 15 |
| exact-identifier rescue overrides (across all sets) | 1 |
| gibberish abstained % | 100.0% |
| gibberish zero-hit % | 100.0% |
| calibration status(es) seen | ok |
| null_median (mean across questions) | 0.790 |
| null_scale (mean across questions) | 0.024 |
| calibration build cost | fixture 2ms (includes 128-probe fit; single-flight cached across the run) |
| mean recall() latency | 122.5ms |
| distractors zero-hit % (n=34, no pass bar) | 41.2% |
| distractors abstained % | 41.2% |
| identifiers present (n=12) rank1 / hit@3 / found@10 | 83.3% / 91.7% / 100.0% |
| identifiers present abstained % / rescued | 0.0% / 1 |
| identifiers absent (n=12, no pass bar) zero-hit % / abstained % / rescued | 16.7% / 16.7% / 0 |


## Real vs. gibberish top_score quantiles

| set | p0 | p10 | p25 | p50 | p75 | p90 | p100 |
|---|---|---|---|---|---|---|---|
| real (n=44) | 0.840 | 0.844 | 0.847 | 0.854 | 0.864 | 0.888 | 0.901 |
| gibberish (n=60) | n/a | n/a | n/a | n/a | n/a | n/a | n/a |
| distractors (n=34) | 0.841 | 0.844 | 0.846 | 0.854 | 0.864 | 0.866 | 0.870 |

## Identifiers / rare-term (review round 2 item 1)

| metric | value |
|---|---|
| n | 12 |
| rank1 | 83.3% |
| hit@3 | 91.7% |
| found@10 | 100.0% |
| MRR | 0.887 |
