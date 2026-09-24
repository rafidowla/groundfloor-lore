# recall-eval baseline — surreal-lance / real / 10000 code rows

Generated: 2026-09-23T22:51:27.226Z
Config: candidateFloor=(default) lexicalBase=(default)
Fixture: $F/logs-e1v/cache-sl-tc/fixture-2e77a69126caddfe (reused=true), counts: {"knowledge":80,"notes":300,"code":10000,"edges":36,"edgesWritten":36}
Timings: fixture 1ms, eval 35890ms, total 37377ms

## Baseline numbers

| metric | value |
|---|---|
| hit@1 (chatty) | 38.6% |
| hit@3 (chatty) | 45.5% |
| MRR (chatty) | 0.438 |
| hit@1 (terse) | 59.1% |
| hit@3 (terse) | 68.2% |
| MRR (terse) | 0.633 |
| terse/chatty top-3 agreement (mean Jaccard) | 23.0% |
| terse/chatty top-3 exact-set-equal | 9.1% |
| anchor in both top-3 (expected node ranks <=3 under BOTH phrasings) | 34.1% |
| top-1 equal (terse vs chatty) | 25.0% |
| prefix stability chatty (top-10@10 == first10@50) | 90.9% |
| prefix stability terse | 72.7% |
| prefix stability BOTH phrasings | 68.2% |
| mean pairwise Jaccard of top-10 (unrelated questions) | 0.064 |
| gibberish zero-hit rate | 100.0% |
| recall() latency p50 / p90 / p95 / p99 (n=294) | 108.6ms / 121.8ms / 124.7ms / 131.3ms |
| pooled hit@3 (terse+chatty, n=88) | 56.8% (50/88) |

## D1 — calibration / abstention (abstain=on, gibberish file=gibberish.json)

| metric | value |
|---|---|
| real questions abstained (of 88 terse+chatty phrasings) | 19 |
| exact-identifier rescue overrides (across all sets) | 1 |
| gibberish abstained % | 100.0% |
| gibberish zero-hit % | 100.0% |
| calibration status(es) seen | ok |
| null_median (mean across questions) | 0.790 |
| null_scale (mean across questions) | 0.024 |
| calibration build cost | fixture 1ms (includes 128-probe fit; single-flight cached across the run) |
| mean recall() latency | 122.1ms |
| distractors zero-hit % (n=34, no pass bar) | 41.2% |
| distractors abstained % | 41.2% |
| identifiers present (n=12) rank1 / hit@3 / found@10 | 83.3% / 91.7% / 100.0% |
| identifiers present abstained % / rescued | 0.0% / 1 |
| identifiers absent (n=12, no pass bar) zero-hit % / abstained % / rescued | 91.7% / 91.7% / 0 |


## Real vs. gibberish top_score quantiles

| set | p0 | p10 | p25 | p50 | p75 | p90 | p100 |
|---|---|---|---|---|---|---|---|
| real (n=44) | 0.840 | 0.845 | 0.849 | 0.854 | 0.870 | 0.888 | 0.901 |
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
