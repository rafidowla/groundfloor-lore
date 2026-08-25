# Lore load testing harness — Sprint C4

**Dev-team tool. NOT operator-facing.** Used by the Lore team to
characterize daemon limits before making SLA claims to enterprise
customers.

## Quick start

```bash
# Make sure a daemon is running (isolated test daemon recommended).
export BEARER=$(jq -r '.bearer' ~/.lore/auth.json)

# Hot single-write sustained:
node scripts/load-tests/load-test-runner.mjs hot-write --N=500 --concurrency=4

# Bulk batched write (Sprint Z path):
node scripts/load-tests/load-test-runner.mjs bulk-write --N=20 --batch=200

# Streaming ingest (Sprint S warm lane):
node scripts/load-tests/load-test-runner.mjs streaming-ingest --N=200

# Recall ranking (Sprint R):
node scripts/load-tests/load-test-runner.mjs recall-mixed --N=200 --concurrency=4
```

## Scenarios

| Name | What it exercises |
|---|---|
| `hot-write` | POST /api/node — outbox hot-lane + Sprint C3 quota |
| `bulk-write` | POST /api/nodes/bulk — Sprint Z batched loader |
| `streaming-ingest` | /api/stream/connect + publish + close — Sprint S warm lane |
| `recall-mixed` | POST /api/recall — Sprint R ranking + embed cache |

## Output

JSON with throughput + latency percentiles:

```json
{
  "scenario": "hot-write",
  "durationMs": 12345,
  "requests": 500,
  "errors": 0,
  "errorRate": 0,
  "throughputRps": 40.5,
  "latency": { "p50": 18.2, "p95": 41.7, "p99": 88.3, "mean": 22.1, "min": 11.0, "max": 132.4 }
}
```

## Adding a scenario

Drop `scripts/load-tests/scenarios/<name>.mjs` that default-exports
`async (opts) => { ... }`. The harness passes `{ base, bearer,
workspace, N, concurrency, recorder }`. Call `recorder.observe(ms)`
per success and `recorder.error(err)` per failure. The harness
summarises everything.

## Constraints

- Always use an isolated test daemon. Do NOT point at your real
  developer workspace — the harness floods writes.
- Pick an ephemeral workspace name (default: `load-test-<timestamp>`).
- Concurrency is naive Promise.all; no rate shaping. Use small
  concurrency to start — Lore's rate limiter (default 5000 generic
  rps) will reject above its threshold.
