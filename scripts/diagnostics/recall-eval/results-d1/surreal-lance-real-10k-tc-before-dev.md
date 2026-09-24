# recall-eval baseline — surreal-lance / real / 10000 code rows

Generated: 2026-09-23T20:06:17.513Z
Config: candidateFloor=(default) lexicalBase=(default)
Fixture: <local>/logs-e1/cache/sl/fixture-2e77a69126caddfe (reused=true), counts: {"knowledge":80,"notes":300,"code":10000,"edges":36,"edgesWritten":36}
Timings: fixture 1ms, eval 31698ms, total 33237ms

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
| anchor in both top-3 (expected node ranks <=3 under BOTH phrasings) | 100.0% |
| top-1 equal (terse vs chatty) | 87.5% |
| prefix stability chatty (top-10@10 == first10@50) | 58.3% |
| prefix stability terse | 33.3% |
| prefix stability BOTH phrasings | 16.7% |
| mean pairwise Jaccard of top-10 (unrelated questions) | 0.020 |
| gibberish zero-hit rate | 100.0% |
| recall() latency p50 / p90 / p95 / p99 (n=329) | 101.0ms / 120.8ms / 128.6ms / 140.0ms |
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
| mean recall() latency | 96.3ms |
| distractors zero-hit % (n=24, no pass bar) | 91.7% |
| distractors abstained % | 91.7% |
| identifiers present (n=20) rank1 / hit@3 / found@10 | 85.0% / 90.0% / 95.0% |
| identifiers present abstained % / rescued | 0.0% / 12 |
| identifiers absent (n=12, no pass bar) zero-hit % / abstained % / rescued | 50.0% / 50.0% / 0 |
| queries[] variant hit@1 / hit@3 / MRR (terse + queries:[chatty]) | 100.0% / 100.0% / 1.000 |
| queries[] variant real-abstained % | 0.0% |
| queries[] variant gibberish zero-hit % | 100.0% |

## Real vs. gibberish top_score quantiles

| set | p0 | p10 | p25 | p50 | p75 | p90 | p100 |
|---|---|---|---|---|---|---|---|
| real (n=24) | 0.845 | 0.853 | 0.869 | 0.888 | 0.905 | 0.916 | 0.919 |
| gibberish (n=60) | n/a | n/a | n/a | n/a | n/a | n/a | n/a |
| distractors (n=24) | 0.849 | 0.849 | 0.849 | 0.859 | 0.859 | 0.859 | 0.859 |

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
