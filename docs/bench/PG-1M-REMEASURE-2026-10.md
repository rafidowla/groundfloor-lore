# Postgres at 1M nodes: re-measure on current main (Wave D lane d2)

Date: 2026-10-24/25. Base: `origin/main` 37f9a372 (Lore 3.36.0 plus Wave B/C). Branch `perf/pg-scale-remeasure`.
Question: after 3.36.0 shipped the pg_trgm keyword indexes, the 5 s verbatim count cache and the diff-based link rebuild
(Loop C), what is still slow at 1M nodes, and what can be fixed cheaply?

## Short answer

- **Recall at 1M is 0.29 s p50 (0.45 s p95) on a quiet machine**, 44 ms at 100k. The 1.8 s p50 / 5 s p95 seen in the first
  1M pass was **mostly machine contention** (other work sharing the laptop), not the product; I did not separate cold page cache from load. Compare numbers only
  inside one table; see "Load caveat".
- `count(*)` is no longer a recall cost: 0.05 to 0.06 calls per recall (the 5 s cache), about 1.7 ms/recall averaged.
- **Three contained fixes landed**, each with a clean same-machine A/B at 100k (table below): batched graph delete,
  batched tombstone, bounded-parallel reads in the link rebuild. Delete of 10k nodes: 58 s to 23.5 s (2.5x), repeated twice.
- Still slow at 1M (written up, not fixed, see "Recommendations"): the graph keyword leg for a mid-frequency term
  (168 ms p50, 320 ms in EXPLAIN, grows 10x from 100k to 1M), BM25 `ts_rank` over a common token (170 ms, scans 65% of the
  table), and the link rebuild itself (about 145 nodes/s, so about 1.9 h for 1M nodes, projected not run to completion).

## Machine and setup

| | |
|---|---|
| Host | Apple M5 Max, 18 cpus (`hw.ncpu` 18), 128 GB (`hw.memsize` 137438953472) |
| Postgres | `pgvector/pgvector:pg16` (PostgreSQL 16.14, aarch64) in Docker on macOS, `--cpus=4 --memory=8g --shm-size=2g`, `shared_buffers=2GB`, `effective_cache_size=6GB`, `work_mem=32MB`, `maintenance_work_mem=1GB`, `max_connections=100`, `pg_stat_statements` on |
| Lore | embedded `createLore()` over a real Postgres workspace (`graphEngine` and `vectorEngine` = postgres), Node 22.18, `modelServer:false` |
| Embedder | **fake**, fixed 384-d deterministic vectors, zero latency. Query embedding time is reported separately and excluded from every recall number. No model weights were loaded or downloaded. |
| Corpus | synthetic and deterministic (`scripts/bench/pg-corpus.mts`): Zipf word frequencies, 200 vector clusters (sigma 0.4), six node types, seed 20261024. 100k and 1,000,200 nodes, one verbatim row per node. |
| Seeding | bulk `INSERT ... unnest` on parallel connections with the secondary indexes dropped, then **Lore's own builders recreated every index** (graph keyword GIN, HNSW, tsvector GIN, VACUUM ANALYZE). Schema and index definitions are the product's. |

Docker-on-Mac adds about 0.9 ms per round trip and an expensive fsync per commit. Per-transaction costs (deletes, writes) are
therefore higher here than on bare-metal or server disks; relative changes are what to read.

## Load caveat (read this first)

The first measurement passes (marked "loaded" below) ran while other work shared the machine (other lane agents plus this
lane's own multi-process runs; the 15-minute load average read about 13 on an 18-core host with a 4-cpu database container). The quiet re-runs happened at load
average about 3. The same read-only recall phase went from p50 1,786 ms (loaded) to 302 ms (quiet). Every before/after pair
in this document that is used to claim a product improvement was run **back to back on the quiet machine, alternating code
versions** (b, a, b or d1, d2, d3, d4). Numbers from the loaded passes are kept only as context and are not used for claims.

## Results

### Reads (quiet machine; recall code was not changed by this lane)

| Measurement | 100k | 1M |
|---|---|---|
| Recall end-to-end, depth 1, first-seen queries, p50 / p95 (48 queries) | 44.5 / 96 ms | 302 / 450 ms (second run 288 / 455) |
| Recall by query kind, p50: common 1 term / mid 1 term / rare 1 term / 3-term phrase / 8-term question | 67 / 27 / 11 / 44 / 52 ms | 249 / 208 / 40 / 366 / 407 ms |
| Keyword leg alone (graph `search`), p50: common / mid / rare / phrase | 20.9 / 17.3 / 1.9 / 14.0 ms | 23.9 / **168** / 17.7 / **117** ms |
| `count(*)` calls per recall (cache) | 0.01 | 0.05 to 0.06 (about 1.7 ms/recall) |
| Fake query-embed time per recall | under 0.1 ms | under 0.1 ms (excluded from the above) |
| As-of query (limit 100) p50 | 1.5 ms | 2.0 ms |
| Graph walk (`traverse`) depth 2 / 3 p50, cold slices | 20.6 / 24.8 ms | 2.4 / 3.5 ms (quiet) |
| Recall with depth 2 / 3 (links present) p50 | 209 / 201 ms | not re-run quiet |

Graph-walk caveat: the benchmark graph is sparse (only the nodes the time-boxed rebuild reached have edges: 41k edges at 100k,
268k at 1M), so walks touch 5 to 45 nodes. Real, densely linked graphs will walk further. The edge fetch itself is an index
scan (0.02 ms in EXPLAIN).

### Link-on-arrival (per node, 200 new nodes, flush time included)

| | 100k | 1M |
|---|---|---|
| Per node total | 12.7 ms | 7.9 ms |

(Loaded earlier pass: 38.5 ms and 62.4 ms. Not an A/B of the code change, because `storedVectorLinker` is only touched
through the bounded-parallel point reads; the quiet numbers are the honest ones.)

### Writes: clean A/B on the quiet machine, 100k nodes

Fresh database copy for every run; 10,000-node `nodeDeleteMany` in default (tombstone) mode.

| Run | Code | Wall | ms/node |
|---|---|---|---|
| d1 | main | 58.3 s | 5.8 |
| d2 | this branch | 23.5 s | 2.4 |
| d3 | main | 58.4 s | 5.8 |
| d4 | this branch | 23.5 s | 2.3 |

Link rebuild, 100 s time-boxed windows (edges inserted per second of wall; rebuild starts from an empty graph):

| Run | Code | Nodes done | Edges | Edges/s |
|---|---|---|---|---|
| b1 | main | 14,450 | 70,001 | 679 |
| a1 | this branch | 15,900 | 76,861 | 746 |
| b2 | main | 14,200 | 68,812 | 668 |
| a2 | this branch | 15,200 | 73,566 | 714 |

The rebuild gain is **about +8 to +10%**, small and consistent. It is not the order-of-magnitude fix; see Recommendations.

### 1M, writes (loaded, indicative only)

| | Before (loaded) | After (state of this branch) |
|---|---|---|
| nodeDeleteMany 10k | 358 s (35.8 ms/node) | 66 s (6.6 ms/node) |
| Link rebuild | 36,250 of 1M nodes in 904 s, 182 edges/s, 40 nodes/s | 58,950 of 1M in 423 s, 253 edges/s average, **about 145 nodes/s and 650 edges/s on the fresh-insert part** |
| Rebuild projection at steady rate | 5.5 h | about 1.9 h |

These two columns were not measured under identical load, so the 5.5x delete and 3.6x rebuild jumps overstate the code
change; the quiet 100k A/B above (2.5x delete, 1.1x rebuild) is the defensible figure. The 1M rebuild was time-boxed and
**extrapolated** (projected over the 3 h budget in the first pass, so not run to completion). Neither the 1M rebuild nor the 1M delete was
repeated quiet before/after.

### EXPLAIN (ANALYZE, BUFFERS), 1M, quiet (full plans in `docs/bench/PG-1M-EXPLAIN-2026-10.txt`)

| Statement | Time | Plan |
|---|---|---|
| Graph keyword leg, mid-frequency term (`nodes`, LIMIT 2000, ORDER BY updatedAt) | 320 ms | **ordered Index Scan on `idx_nodes_updatedat`**, 100k buffers: the planner prefers walking recency order and filtering over using the trigram GIN, because the term matches about 29k rows |
| BM25 `ts_rank`, common term | 170 ms | Parallel Seq Scan over about 195k pages (65% of rows match, so the GIN is not worth using); ranking all matches |
| BM25 `ts_rank`, mid term | 10 ms | Bitmap Index Scan on the tsvector GIN |
| BM25, common + mid | 180 ms | Seq scan (OR of tsqueries) |
| HNSW kNN top 20 | 0.5 ms | index scan |
| `count(*)` (cached 5 s) | 40 ms | parallel seq scan of the partition, 11.6k buffers |
| Traverse edge fetch | 0.02 ms | index scans |

## What was fixed (product code)

1. **Batched graph delete** (`PostgresGraph.deleteNodes`, `postgresGraphWrites.deleteNodes`). `nodeDeleteMany` removed graph
   nodes one transaction each: about 7 round trips plus a commit and fsync per node. It now sends the 50-node chunk as one
   transaction (link opt-outs, edges in both directions, nodes) taken under the same per-node write chains in sorted order.
   All-or-nothing; on a throw the service falls back to the old per-node loop, so behaviour and result shape are unchanged.
2. **Batched verbatim tombstone** (`PostgresVerbatimStore.tombstoneMany`). The per-node path did read, embed, then a transaction per
   node; the chunk now does one read, one batched embed (honouring the provider's `embedDocumentBatch` / `maxBatchSize`), and one
   transaction. Already tombstoned ids are skipped, absent ids ignored, falls back per node on a throw.
3. **Link rebuild reads** (`link/boundedMap.ts`, used by `linkDiff.edgesTouching` and `storedVectorLinker`). The diff read the
   edges of each batch node, both sides, and the stored vector of each candidate, strictly one after another. These reads
   now run with a concurrency of 4 and results are merged in the original order, so the diff output is identical.

No new env var or setting; `docs/CONFIGURATION.md` is unchanged. No response shape or error code changed.

## Embedding throughput (fake provider only)

Never downloaded weights. The benchmark wraps a fake provider with fixed per-call latency and runs 2,000 items through Lore's batching:

| Provider latency | Wall | Latency floor | Overhead |
|---|---|---|---|
| 0 ms | 51 to 145 ms (about 39k items/s) | 0 | the whole cost of batching and concurrency |
| 50 ms per batch (63 batches) | 3,270 ms | 3,150 ms | 120 ms (3.8%) |
| 200 ms per batch | 12,720 ms | 12,600 ms | 120 ms (1%) |
| 5 ms per item | 10,130 ms | 10,000 ms | 130 ms (1.3%) |

Lore's own batching adds a roughly constant 0.1 s per 2,000 items. The in-process embedding bottleneck seen in the October H2H run is
therefore the model call, not the wrapper. **A real number needs the roadmap item 5 server measurement**: run the same corpus through
the real embedding model on the target server hardware (CPU or GPU), at batch sizes 8, 32, 64, report items/s and p95 batch
latency, and compare with the fixed latency floor above. This was not run here.

## Recommendations (not implemented, larger or architectural)

1. **Graph keyword leg, mid-frequency terms (168 ms at 1M, 10x worse than at 100k).** Cause: ordering by `updatedAt DESC`
   with a LIMIT lets the planner walk the recency index and filter. Options: (a) rank the trigram/tags matches first with a
   `MATERIALIZED` CTE capped at the limit, then order; (b) a smaller set via the tsvector GIN already on `verbatim`. Needs a
   result-order parity test, hence not a quick fix. Recommended: (a).
2. **BM25 `ts_rank` over a common token (170 ms).** `ts_rank` has to score every match. Options: drop tokens whose document
   frequency exceeds about 20% from the BM25 query (they carry no ranking signal), or use the vector leg alone for all-common
   queries. Recommended: document-frequency stop-list built at index time.
3. **Link rebuild at 1M (about 1.9 h projected).** Dominated by per-batch work plus the configured 200 ms yield per 50-node
   batch (about 30% of wall) and wide kNN result rows. Recommended: lower `LORE_LINK_REBUILD_YIELD_MS` only when the host is idle,
   narrow the kNN rows to ids and scores, and prefetch the next batch's kNN while the current batch writes.
4. **Contention between recall legs on a 4-cpu container.** HNSW alone is 0.5 ms; the 387 ms seen inside a loaded recall is
   leg contention. Production sizing, not code.
5. **Startup inline index rebuild vs the 30 s `statement_timeout`.** An inline GIN or HNSW rebuild at 1M can exceed it. Run index
   builds on a session with its own timeout.
6. **Delete remainder.** After batching, the cost is in-database (HNSW, GIN and tombstone-row insert about 5 ms per row on
   Docker); not reducible from application code.

## Reproduce

All scripts are under `scripts/bench/` (bench-only, not shipped; they import `pg` directly, which the architecture check allows
outside `packages/lore/src`).

```
LORE_PG_URL=postgres://postgres:...@127.0.0.1:<port>/<db> npx tsx scripts/bench/pg-seed-1m.mts --n 100000 --root <dir>
LORE_PG_URL=... npx tsx scripts/bench/pg-scale-bench.mts --seed-info <dir>/seed-info.json --label x \
    --phases startup,recall,keyword,rebuild,graph,asof,arrival,delete,batching --rebuild-budget-s 100 --out <dir>
LORE_PG_URL=... npx tsx scripts/bench/pg-explain.mts --seed-info <dir>/seed-info.json --out explain.txt
```

## Caveats

- Container is 4 cpus / 8 GB, far below a production server; absolute numbers will differ. Relative shapes should hold.
- Synthetic Zipf corpus; real text has different token distributions, so the keyword legs may behave differently.
- Fake embedder: no model cost, no model contention for cpu.
- Quiet 1M recall and keyword numbers ran on a warm page cache; the first pass, loaded, was colder.
- The 1M database was mutated between passes (10k nodes deleted once or twice, rebuild edges added, as-of windows set), so
  1M passes are not on identical data.
- The 1M link rebuild and delete were not A/B'd quiet; 1M rebuild is time-boxed and extrapolated.
- Docker on Mac inflates per-commit cost.

## Re-measure on an M1 Pro MacBook after the fixes (2026-10-27 run)

Date: 2026-10-27, 20:48 to 22:31 EDT. Lore `e6324436` (3.37.2 plus a bench seed fix). Same container shape as the M5 Max run
above (4 cpu / 8 GB, `shared_buffers` 2 GB), PostgreSQL 16.15, pgvector 0.8.7, fake embeddings, same synthetic Zipf corpus
(100k and 1M). Purpose: check the keyword CTE route (#251) and the BM25 common-token stop-list against their pre-fix
baselines on slower hardware. Before and after pairs are in-run only. Raw logs (`runs/<size>/`, `runs/1m/2b-keyword-ab-recheck.log`,
load samples) stayed on the MacBook in `~/lore-scale-eval/runs/`; they are not in the repo.

### Machine

| | |
|---|---|
| Host | MacBookPro18,1, Apple M1 Pro (8 performance + 2 efficiency cores), 16 GB, macOS 26.5.1 |
| Docker Desktop | VM 10 cpus / 10 GB; Postgres container `--cpus=4 --memory=8g` |
| Node | 22.23.4 |

Background apps were stopped before the run. Every step began after a 5-minute load below 2; during the measured steps
(keyword-ab, stop-list, recall pairs) the 1-minute load stayed between 1.4 and 2.5. Higher load (up to 6) only appeared during
the seed and the full scale bench.

### Verdict: FAIL on one rule

| Rule (1M, in-run pairs) | Result |
|---|---|
| Recall p50 after lower than before | **Pass**: 457 -> 183 ms (-60%); p95 926 -> 710 ms (-23%). ABBA order, two pairs. |
| keyword-ab `engine` not slower than `old` by more than 10% or 2 ms | **FAIL**: term `linest` 216 -> 559 ms (+159%). The other 10 terms pass. |
| BM25 stop-list after not slower than before | **Pass** (see note on skipped legs) |
| keyword-ab results identical (`same ids`) | **Pass**: 11/11 rows |

Results were identical in every case; only speed differs.

### Analysis

- **Plan choice is unstable near the switch-over.** The rule in `postgresKeywordPlan.ts` picks the CTE when
  `M_est^2 <= 0.5 * cap * N_est` with `cap` = `SEARCH_SCAN_CAP` (2000), so at N = 1M the switch-over is about 31.6k estimated
  matches. `linest` was estimated at 30,453 (just under) while the real count is 41,026, so it took the CTE and ran 2.6x slower.
  The planner's estimate for a term moves between ANALYZE runs, so terms near 31.6k flip between plans from run to run.
- **Re-check confirms it** (4 terms near the boundary, 11 reps, run after the scale bench deleted 10,000 nodes and Postgres
  re-analysed): `linest` now estimated 60,556 and routed correctly (old 230.5 -> engine 229.0 ms), while `because` fell from
  60,755 to 30,035, took the CTE and went 190.5 -> 256.1 ms (+34%, also over the limit). `land` stayed on the CTE and won
  (308 -> 171 ms). A right flip saves up to about 2x; a wrong one costs 1.3 to 2.6x. The re-check started after the 20-minute
  load-wait cap, at a 5-minute load of 2.16.
- **CTE cost does not follow match count alone.** `linest` CTE ran 562 ms at 41k matches, while `ityfo` CTE ran 234 ms at 45k.
  Hypothesis, not verified: the trigram bitmap recheck volume differs between terms. No EXPLAIN was taken for it.
- **At 1M the engine route was within +-2% of old for every other term**, and correctly avoided the CTE for common words where
  it would be 7x to 200x slower (`would` 542 vs 76 ms, `and` 3,180 vs 15 ms). The clear CTE wins were at 100k (`keep`, 3,011
  matches: 275 -> 77 ms); at 1M only `land` benefited, by 2%.
- **Most of the 1M recall gain comes from the stop-list**, not the CTE: common-word queries went 374 -> 105 ms p50, while
  mid-frequency single-term p50 did not move (284 -> 299 ms; p95 improved 1,397 -> 472 ms).
- **A follow-up fix to the switch rule is open and being decided.** Nothing is prescribed here, and no code was changed in this run.

### Recall by query kind (first-seen queries, depth 1, 48 queries, average of two runs per side, p50 / p95 ms)

| | 100k before | 100k after | 1M before | 1M after |
|---|---|---|---|---|
| **Overall** | 64.4 / 122.3 | 45.1 / 103.1 | 457.3 / 926.3 | **182.6 / 709.8** |
| common-1term | 86.2 / 112.5 | 60.7 / 122.4 | 373.8 / 752.3 | 105.2 / 158.5 |
| mid-1term | 39.8 / 56.2 | 40.9 / 58.3 | 284.1 / 1396.6 | 299.1 / 471.6 |
| phrase-3term | 63.0 / 185.4 | 39.6 / 137.5 | 567.0 / 789.9 | 337.9 / 760.0 |
| question-8term | 76.3 / 122.3 | 52.7 / 103.1 | 617.4 / 1017.0 | 375.0 / 760.9 |
| rare-1term | 15.4 / 17.7 | 17.2 / 19.2 | 83.1 / 104.8 | 52.3 / 79.7 |

Order was before1, after1, after2, before2. At 1M, before1 ran first after the seed, so its rare-term figure was partly cold; the
warm before2 still gave overall p50 462 ms, so the gap is not a cache effect.

### keyword-ab at 1M (p50 ms, 7 reps)

| term | matches | engine plan | old | cte | engine | engine vs old |
|---|---|---|---|---|---|---|
| cenessgu | 182 | ordered-walk | 33.3 | 32.5 | 32.7 | -2% |
| iveestwor | 10,005 | ordered-walk | 88.1 | 93.1 | 89.1 | +1% |
| land | 30,123 | cte | 169.0 | 167.0 | 165.6 | -2% |
| **linest** | **41,026** | **cte** | **215.7** | 562.5 | **558.5** | **+159%** |
| ityfo | 45,197 | ordered-walk | 197.2 | 234.2 | 197.4 | 0% |
| because | 49,611 | ordered-walk | 177.3 | 261.5 | 177.5 | 0% |
| would | 119,649 | ordered-walk | 76.1 | 541.5 | 76.6 | +1% |
| way | 164,957 | ordered-walk | 55.5 | 703.8 | 55.3 | 0% |
| you | 233,400 | ordered-walk | 41.5 | 949.8 | 41.7 | 0% |
| was | 422,344 | ordered-walk | 25.7 | 1,625.2 | 26.1 | +2% |
| and | 901,100 | ordered-walk | 15.5 | 3,180.0 | 15.3 | -1% |

At 100k all 11 terms passed.

### BM25 common-token stop-list (average of 2 rounds, ms)

| query | 100k before | 100k after | 1M before | 1M after |
|---|---|---|---|---|
| common-only | 29.5 | 0.0 (0 hits) | 295.8 | 0.0 (0 hits) |
| all-common | 31.5 | 0.0 (0 hits) | 317.1 | 0.0 (0 hits) |
| mixed (common + mid) | 31.9 | 2.5 | 319.6 | 15.6 |
| mixed-2 | 33.3 | 2.5 | 338.8 | 14.7 |
| rare-only | 2.7 | 2.8 | 17.2 | 17.4 |

Stop-list build: 212 ms at 100k, 497 ms at 1M (30 common words). By design, queries made only of common words now return
**no BM25 hits** (40 before), so the two common-only rows are the leg being skipped, not a faster query. Mixed queries return the
same 40 hits about 20x faster.

### Graph walk, delete, link rebuild (full scale bench, fixes on)

| | 100k | 1M |
|---|---|---|
| Recall p50 / p95 (scale bench's own pass) | 46.1 / 101.1 ms | 184.9 / 700.3 ms |
| Keyword leg p50: common / mid / rare / phrase | 33.7 / 28.3 / 5.7 / 18.9 ms | 36.0 / 166.8 / 32.3 / 157.5 ms |
| Graph traverse p50, depth 1 / 2 / 3 | 2.7 / 6.3 / 14.9 ms | 4.4 / 8.1 / 17.0 ms |
| As-of query (limit 100) p50 | 2.1 ms | 3.5 ms |
| Link on arrival (200 new nodes) | 12.8 ms/node | 38.7 ms/node |
| Delete 10,000 nodes | 40.7 s (4.1 ms/node) | 86.3 s (8.6 ms/node) |
| Link rebuild | full: 100k nodes in 222 s (450 nodes/s), 431k edges | 600 s budget: 120k of 1M nodes (199 nodes/s, 175/s steady), 543k edges; full rebuild projected about 95 min |

Recall with links at depth 2 / 3 was 79.4 / 109.2 ms at 100k; the 1M pair (424.7 / 79.1 ms) is not comparable, since depth 2 ran
first and warmed the caches.

Write-side scaling, 100k -> 1M: link-on-arrival 12.8 -> 38.7 ms/node (3.0x), full link rebuild about 450 -> 175 nodes/s steady
(projected about 95 min at 1M; the M5 Max run above projected about 1.9 h, but that is cross-machine and not comparable), delete 4.1 -> 8.6 ms/node (2.1x). The 1M
rebuild was time-boxed and projected, not run to completion; the 1M delete ran on a database that had already been mutated.

### Size, time and memory

| | 100k | 1M |
|---|---|---|
| Seed wall time | 45 s | 11 m 00 s (bulk load 144 s, HNSW index 381 s) |
| DB size after seed | 718 MB | 6.9 GB |
| Peak Postgres container memory | 1.18 GiB | 5.65 GiB |
| Peak Node memory (any step) | 643 MB (seed) | 701 MB (seed) |
| Full scale bench wall time | 5 m 15 s | 13 m 46 s |

### Cross-machine (informational only)

| | M5 Max, pre-fix | M1 Pro, before | M1 Pro, after |
|---|---|---|---|
| 1M recall p50 / p95 | 302 / 450 ms | 457 / 926 ms | 183 / 710 ms |
| 100k recall p50 / p95 | 44.5 / 96 ms | 64.4 / 122.3 ms | 45.1 / 103.1 ms |

On the same pre-fix code the M1 Pro is about 1.5x slower than the M5 Max. Cross-machine numbers mix hardware, Postgres minor
version, and code changes, so only the in-run before/after pairs are used for claims. After the fixes the M1 Pro beats the M5 Max
pre-fix median at 1M (183 vs 302 ms) but not its p95 (710 vs 450 ms): the slowest recalls still come from mid-frequency and
multi-term queries.
