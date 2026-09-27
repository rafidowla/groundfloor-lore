# D9 shared-model-server measurements (Lore 3.24, slice C3b)

Measured (reported, not gated) per [D9-shared-model-server.md](../design/D9-shared-model-server.md) §6.
This is a measurement, not a release gate — no pass/fail threshold (see "No tuning" below).

## Machine

- Chip: Apple M5 Max
- CPUs: 18
- RAM: 128 GB
- OS: darwin 25.5.0
- Node: v22.18.0

## Command

```
node scripts/perf/d9-shared-models-bench.mjs
```

## Method

4 hosts (plain `node`, compiled dist via `tsc` + `tsc-alias` into a
throwaway `.bench-dist/` inside the worktree, deleted afterward — the same
pattern as `test/model-server-dist-spawn-unit.ts`), each with its own
`dataDir` but the same `LORE_HOME` (env-keyed model-server sharing is
independent of `dataDir`, D9 §5.1). Each host bulk-ingests the same
deterministic ~300-note corpus, then runs 60 recalls (`rerank: true`
per-call, same mechanism as `test/d8-rerank-e2e.ts`) from a fixed
20-query list cycled 3x, then holds idle for RSS sampling
(`ps -o rss= -p <pid>`).

Scenario **A** = `LORE_MODEL_SERVER=1` (shared); scenario **B** =
`LORE_MODEL_SERVER=0` (in-process). Each scenario ran 3 times, alternating
A,B,A,B,A,B. Every run gets a fresh temp `LORE_HOME` (copy-on-write clone
of a seed home holding the re-rank model, so a fresh copy also means a fresh model-server key
— no cross-run contamination). Scenario A's model server is stopped
(`lore models server stop`, falling back to SIGTERM on its own pidfile pid
if that fails) immediately after each run.

The re-rank model comes from `LORE_TEST_RERANK_MODEL_DIR` (copied) or a
one-off `lore models fetch-rerank` into the seed home; the embedding model
from the legacy `transformers` cache in `node_modules`.

**Scenario A assertion** (every host reports `mode:'shared'`, exactly one
server pid across all 4 hosts): PASSED on all 3 runs.

## Results — per run

Scenario A (shared):

| run | total RSS (MB) | recall p50 (ms) | recall p90 (ms) | first-call median (ms) | first-call worst (ms) | rerank busy | rerank timeout | recalls |
|---|---|---|---|---|---|---|---|---|
| A1 | 2010.6 | 82.5 | 129.4 | 2713 | 2724 | 0 | 0 | 240 |
| A2 | 2025.2 | 101.1 | 107.2 | 2759 | 2771 | 0 | 0 | 240 |
| A3 | 1990.4 | 115.1 | 131.6 | 2914 | 2925 | 0 | 0 | 240 |
| **median** | **2010.6** | **101.1** | **129.4** | **2759** | **2771** | | | |

Scenario B (in-process):

| run | total RSS (MB) | recall p50 (ms) | recall p90 (ms) | first-call median (ms) | first-call worst (ms) | rerank busy | rerank timeout | recalls |
|---|---|---|---|---|---|---|---|---|
| B1 | 3817.0 | 81.0 | 118.7 | 2924 | 2973 | 0 | 0 | 240 |
| B2 | 3986.2 | 107.9 | 149.8 | 3099 | 3102 | 0 | 0 | 240 |
| B3 | 3978.8 | 116.3 | 159.2 | 2927 | 2961 | 0 | 0 | 240 |
| **median** | **3978.8** | **107.9** | **149.8** | **2927** | **2973** | | | |

## A vs B delta (medians)

| metric | A | B | delta |
|---|---|---|---|
| Total idle RSS (4 hosts + server) | 2010.6 MB | 3978.8 MB | -1968.3 MB (-49.5%) |
| Recall p50 | 101.1 ms | 107.9 ms | -6.3% |
| Recall p90 | 129.4 ms | 149.8 ms | -13.6% |
| First-call latency (median host) | 2759 ms | 2927 ms | — |
| First-call latency (worst host) | 2771 ms | 2973 ms | — |
| of which `createLore()` (median host) | 18 ms | 2911 ms | — |
| Rerank fail-open rate (busy+timeout / total) | 0.00% | 0.00% | — |

## Reading

- Total idle RSS is the sum of all 4 host processes' `ps` RSS plus (scenario
  A only) the shared `lore-models` server's own `ps` RSS. The server's
  self-reported `status.rssBytes` is recorded separately per run in the raw
  JSON as a cross-check against the `ps` figure.
- Recall p50/p90 pool all 240 recall timings (4 hosts × 60 recalls) within a
  run before taking the percentile; the table's "median" row is the median
  of the 3 per-run percentiles, not a re-pooled percentile across runs.
- First-call latency is measured from each host's `createLore()` start to
  its first single-note ingest-embed completing, so it includes model load
  wherever it happens: during `createLore()` or the first embed in-process
  (scenario B), or spawning the shared server and loading the model there
  (scenario A). The raw JSON also splits it into `createLoreMs` and
  `firstIngestMs`. Re-rank model load is not in it; it lands on each
  host's first recall.

No noise or anomalies observed across the 6 runs.

## Findings (hand-written after the run)

- **Memory:** 4 hosts sharing one server use about 2.0 GB less than 4 hosts
  each loading their own models (-49.5%), consistent across all 3 pairs.
- **Recall latency:** within noise (p50 -6%, p90 -14%).
- **First call:** about the same (~2.8 s shared vs ~2.9 s in-process). In
  process the embedding model loads inside `createLore()` (~2.9 s); shared,
  `createLore()` returns in ~18 ms and the load moves to the first embed,
  in the server. An earlier draft of this bench started the clock after
  `createLore()` and reported shared as ~84x slower — that was a
  measurement error, fixed before these numbers.
- **Re-rank fail-open: 0% in both modes.** The previous run (server cap = 2,
  the per-process `LORE_RECALL_RERANK_MAX_CONCURRENT` default) measured
  **2.5%** busy in shared mode (4–7 of 240 recalls per run) vs 0%
  in-process: in-process, 4 hosts got 2 slots each; shared, all 4 hosts
  shared the server's 2. Owner decision: the server now has its own cap,
  `LORE_MODEL_SERVER_RERANK_MAX_CONCURRENT` (default 4, falling back to an
  explicitly set `LORE_RECALL_RERANK_MAX_CONCURRENT`). These numbers are
  with that change.
- Absolute latencies in this run are lower than the previous run's for
  both scenarios (quieter machine); compare A vs B within a run, not
  across runs.
- The benchmark drives 4 hosts recalling back-to-back simultaneously, which
  is heavier than normal interactive use.

## No tuning

Per the brief for this slice: if shared mode came out slower on recall
p50/p90 by more than ~10%, or rerank busy was >0 in A but 0 in B, this
script and this doc report the numbers as measured. No production code
(model server, rerank stage, or otherwise) was changed by this slice to
improve them — that decision belongs to the feature owner, not this
measurement. The server re-rank cap change above was an owner decision
taken after the first run.

## Raw data

Per-run JSON (host RSS, per-host recall timings, modelStatus, assertions):
`<BENCH_OUT_DIR>/run-<A|B><1|2|3>.json` (outside the repo, not committed).
