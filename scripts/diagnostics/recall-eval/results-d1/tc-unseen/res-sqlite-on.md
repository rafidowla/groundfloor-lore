# recall-eval baseline — sqlite / real / 10000 code rows

Generated: 2026-09-23T22:49:54.434Z
Config: candidateFloor=(default) lexicalBase=(default)
Fixture: $F/logs-e1v/cache-sqlite-on/fixture-f4b536ccd6b5d820 (reused=true), counts: {"knowledge":80,"notes":300,"code":10000,"edges":36,"edgesWritten":36}
Timings: fixture 1ms, eval 9456ms, total 10553ms

## Baseline numbers

| metric | value |
|---|---|
| hit@1 (chatty) | 38.6% |
| hit@3 (chatty) | 45.5% |
| MRR (chatty) | 0.431 |
| hit@1 (terse) | 59.1% |
| hit@3 (terse) | 70.5% |
| MRR (terse) | 0.648 |
| terse/chatty top-3 agreement (mean Jaccard) | 21.8% |
| terse/chatty top-3 exact-set-equal | 9.1% |
| anchor in both top-3 (expected node ranks <=3 under BOTH phrasings) | 36.4% |
| top-1 equal (terse vs chatty) | 25.0% |
| prefix stability chatty (top-10@10 == first10@50) | 86.4% |
| prefix stability terse | 72.7% |
| prefix stability BOTH phrasings | 65.9% |
| mean pairwise Jaccard of top-10 (unrelated questions) | 0.042 |
| gibberish zero-hit rate | 100.0% |
| recall() latency p50 / p90 / p95 / p99 (n=294) | 24.9ms / 31.1ms / 33.4ms / 40.6ms |
| pooled hit@3 (terse+chatty, n=88) | 58.0% (51/88) |

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
| calibration build cost | fixture 1ms (includes 128-probe fit; single-flight cached across the run) |
| mean recall() latency | 32.2ms |
| distractors zero-hit % (n=34, no pass bar) | 41.2% |
| distractors abstained % | 41.2% |
| identifiers present (n=12) rank1 / hit@3 / found@10 | 58.3% / 75.0% / 100.0% |
| identifiers present abstained % / rescued | 0.0% / 1 |
| identifiers absent (n=12, no pass bar) zero-hit % / abstained % / rescued | 16.7% / 16.7% / 0 |


## Real vs. gibberish top_score quantiles

| set | p0 | p10 | p25 | p50 | p75 | p90 | p100 |
|---|---|---|---|---|---|---|---|
| real (n=44) | 0.841 | 0.844 | 0.848 | 0.854 | 0.864 | 0.888 | 0.901 |
| gibberish (n=60) | n/a | n/a | n/a | n/a | n/a | n/a | n/a |
| distractors (n=34) | 0.841 | 0.842 | 0.846 | 0.853 | 0.864 | 0.866 | 0.870 |

## Identifiers / rare-term (review round 2 item 1)

| metric | value |
|---|---|
| n | 12 |
| rank1 | 58.3% |
| hit@3 | 75.0% |
| found@10 | 100.0% |
| MRR | 0.716 |
