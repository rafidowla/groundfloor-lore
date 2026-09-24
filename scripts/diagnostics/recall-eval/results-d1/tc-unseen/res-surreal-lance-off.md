# recall-eval baseline — surreal-lance / real / 10000 code rows

Generated: 2026-09-23T22:50:11.729Z
Config: candidateFloor=(default) lexicalBase=(default)
Fixture: $F/logs-e1v/cache-sl-off/fixture-2e77a69126caddfe (reused=true), counts: {"knowledge":80,"notes":300,"code":10000,"edges":36,"edgesWritten":36}
Timings: fixture 2ms, eval 36640ms, total 38617ms

## Baseline numbers

| metric | value |
|---|---|
| hit@1 (chatty) | 40.9% |
| hit@3 (chatty) | 52.3% |
| MRR (chatty) | 0.481 |
| hit@1 (terse) | 63.6% |
| hit@3 (terse) | 79.5% |
| MRR (terse) | 0.712 |
| terse/chatty top-3 agreement (mean Jaccard) | 16.6% |
| terse/chatty top-3 exact-set-equal | 0.0% |
| anchor in both top-3 (expected node ranks <=3 under BOTH phrasings) | 45.5% |
| top-1 equal (terse vs chatty) | 27.3% |
| prefix stability chatty (top-10@10 == first10@50) | 90.9% |
| prefix stability terse | 63.6% |
| prefix stability BOTH phrasings | 61.4% |
| mean pairwise Jaccard of top-10 (unrelated questions) | 0.045 |
| gibberish zero-hit rate | 0.0% |
| recall() latency p50 / p90 / p95 / p99 (n=294) | 114.1ms / 129.8ms / 133.5ms / 140.5ms |
| pooled hit@3 (terse+chatty, n=88) | 65.9% (58/88) |

## D1 — calibration / abstention (abstain=off, gibberish file=gibberish.json)

| metric | value |
|---|---|
| real questions abstained (of 88 terse+chatty phrasings) | 0 |
| exact-identifier rescue overrides (across all sets) | 0 |
| gibberish abstained % | 0.0% |
| gibberish zero-hit % | 0.0% |
| calibration status(es) seen | pending, ok |
| null_median (mean across questions) | 0.790 |
| null_scale (mean across questions) | 0.024 |
| calibration build cost | fixture 2ms (includes 128-probe fit; single-flight cached across the run) |
| mean recall() latency | 124.6ms |
| distractors zero-hit % (n=34, no pass bar) | 0.0% |
| distractors abstained % | 0.0% |
| identifiers present (n=12) rank1 / hit@3 / found@10 | 83.3% / 91.7% / 100.0% |
| identifiers present abstained % / rescued | 0.0% / 0 |
| identifiers absent (n=12, no pass bar) zero-hit % / abstained % / rescued | 0.0% / 0.0% / 0 |


## Real vs. gibberish top_score quantiles

| set | p0 | p10 | p25 | p50 | p75 | p90 | p100 |
|---|---|---|---|---|---|---|---|
| real (n=44) | 0.813 | 0.838 | 0.845 | 0.853 | 0.858 | 0.887 | 0.901 |
| gibberish (n=60) | 0.761 | 0.772 | 0.779 | 0.786 | 0.797 | 0.806 | 0.814 |
| distractors (n=34) | 0.806 | 0.827 | 0.834 | 0.846 | 0.855 | 0.864 | 0.870 |

## Identifiers / rare-term (review round 2 item 1)

| metric | value |
|---|---|
| n | 12 |
| rank1 | 83.3% |
| hit@3 | 91.7% |
| found@10 | 100.0% |
| MRR | 0.887 |
