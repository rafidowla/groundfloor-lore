# recall-eval baseline — sqlite / real / 10000 code rows

Generated: 2026-09-23T22:13:24.484Z
Config: candidateFloor=(default) lexicalBase=(default)
Fixture: <cache-root>/sqlite/fixture-f4b536ccd6b5d820 (reused=true), counts: {"knowledge":80,"notes":300,"code":10000,"edges":36,"edgesWritten":36}
Timings: fixture 1ms, eval 12549ms, total 13526ms

## Baseline numbers

| metric | value |
|---|---|
| hit@1 (chatty) | 71.6% |
| hit@3 (chatty) | 79.1% |
| MRR (chatty) | 0.769 |
| hit@1 (terse) | 85.1% |
| hit@3 (terse) | 89.6% |
| MRR (terse) | 0.883 |
| terse/chatty top-3 agreement (mean Jaccard) | 26.7% |
| terse/chatty top-3 exact-set-equal | 3.0% |
| anchor in both top-3 (expected node ranks <=3 under BOTH phrasings) | 73.1% |
| top-1 equal (terse vs chatty) | 62.7% |
| prefix stability chatty (top-10@10 == first10@50) | 73.1% |
| prefix stability terse | 44.8% |
| prefix stability BOTH phrasings | 34.3% |
| mean pairwise Jaccard of top-10 (unrelated questions) | 0.028 |
| gibberish zero-hit rate | 100.0% |
| recall() latency p50 / p90 / p95 / p99 (n=445) | 23.3ms / 29.6ms / 32.5ms / 36.6ms |
| pooled hit@3 (terse+chatty, n=134) | 84.3% (113/134) |

## D1 — calibration / abstention (abstain=on, gibberish file=gibberish-heldout.json)

| metric | value |
|---|---|
| real questions abstained (of 134 terse+chatty phrasings) | 7 |
| exact-identifier rescue overrides (across all sets) | 12 |
| gibberish abstained % | 100.0% |
| gibberish zero-hit % | 100.0% |
| calibration status(es) seen | ok |
| null_median (mean across questions) | 0.790 |
| null_scale (mean across questions) | 0.024 |
| calibration build cost | fixture 1ms (includes 128-probe fit; single-flight cached across the run) |
| mean recall() latency | 28.2ms |
| distractors zero-hit % (n=52, no pass bar) | 71.2% |
| distractors abstained % | 71.2% |
| identifiers present (n=20) rank1 / hit@3 / found@10 | 85.0% / 90.0% / 95.0% |
| identifiers present abstained % / rescued | 0.0% / 12 |
| identifiers absent (n=12, no pass bar) zero-hit % / abstained % / rescued | 100.0% / 100.0% / 0 |


## Real vs. gibberish top_score quantiles

| set | p0 | p10 | p25 | p50 | p75 | p90 | p100 |
|---|---|---|---|---|---|---|---|
| real (n=67) | 0.842 | 0.850 | 0.856 | 0.877 | 0.892 | 0.903 | 0.919 |
| gibberish (n=60) | n/a | n/a | n/a | n/a | n/a | n/a | n/a |
| distractors (n=52) | 0.842 | 0.846 | 0.849 | 0.859 | 0.867 | 0.870 | 0.878 |

## Negatives (D3 §5.3)

| set | n | topScore null | top-1 lexical-only | top-3 lexical-only slots |
|---|---|---|---|---|
| offtopic | 20 | 19 | 0 | 0/60 |
| unanswerable | 12 | 12 | 0 | 0/36 |

## Identifiers / rare-term (review round 2 item 1)

| metric | value |
|---|---|
| n | 20 |
| rank1 | 85.0% |
| hit@3 | 90.0% |
| found@10 | 95.0% |
| MRR | 0.875 |
