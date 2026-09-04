# Bulk loader (Sprint Z)

The bulk loader is Lore's enterprise-scale ingest path: streaming
upload + async job + substrate-native writers + checkpoint/resume +
per-workspace concurrency. Shipped in v3.5.0 (Sprint Z, sub-chains
Z0 → Z4). This document is the architectural reference + operator
runbook.

Pre-Sprint-Z baseline: `POST /api/nodes/bulk` was capped at 1000
items per call and ~104 rows/sec end-to-end. A 40M-row enterprise
load extrapolated to ~4.4 days. Sprint Z exposes substrate-native
loaders so the same load runs in minutes to hours instead of days.

## The 10-clause contract (Sprint Z principle)

Recorded verbatim. Every change to the bulk-load surface must
preserve every clause; the gate test
`test/sprint-Z-bulk-loader-property.ts` enforces them as Z-D1
through Z-D11.

1. `POST /api/load` accepts streaming uploads (chunked transfer);
   body sizes limited only by configured max (default 10 GB).
2. Returns `{job_id}` immediately; client polls
   `/api/load/jobs/<id>` or registers webhook for completion.
3. Substrate-native loaders used per format (batched bulk-upsert for
   graph, SQLite prepared+transaction for relational, LanceDB Arrow
   add for vectors); per-row INSERT explicitly avoided.
4. Checkpoint every N rows (default 10k); kill → restart resumes
   from checkpoint.
5. Per-item failures reported but don't fail the whole job; final
   job state includes error count + per-error detail.
6. Sprint L workspace_required preserved; every job carries
   workspace; no cross-workspace bulk loads.
7. Sprint O outbox preserved: large-load completion writes a
   `load.done` outbox notification (so external consumers see the
   completion as part of the universal write contract).
8. Sprint E preserved: bulk-loaded rows default skip-on-write
   embed; re-embed via Sprint E re-embed job after load.
9. Per-tenant concurrency cap (default 3 concurrent jobs/tenant);
   4th rejected with 429 + `Retry-After`.
10. Backpressure: if outbox depth or embed queue exceeds threshold,
    new load rejected with 503 (not silent loss).

## The four lanes (enterprise write strategy)

Lore's write surface is now four lanes, each with its own latency
and throughput contract:

| Lane | Entry point | Latency target | Throughput target | When to use |
|---|---|---|---|---|
| **Hot** | `POST /api/node` | < 30 ms | ~50 rps | Interactive single-row writes; outbox replicator picks up async. |
| **Warm** | `POST /api/nodes/bulk` (cap 1000) | < 2 s/batch | ~100-500 rps | Background fan-out for app code that produces small batches. |
| **Cool** | Sprint E re-embed CLI (`lore embed reembed`) | minutes | unbounded (background) | Model upgrades, vector rebuilds. |
| **Bulk** | `POST /api/load` (Sprint Z) | minutes-hours per job | 100k rows < 5 min target | One-shot enterprise loads, replay imports, dataset bootstrap. |

The bulk lane is the only lane that exposes substrate-native loaders
end-to-end. The hot/warm lanes preserve the W9 contract (outbox-first,
per-item failure reporting) and bound payload size at 10 MB.

## API surface

### `POST /api/load?workspace=X&format=jsonl&target=node[&embed=skip]`

Streaming chunked upload. Body is consumed via `pipe()` into a temp
file under `<LORE_HOME>/workspaces/<name>/.lore/tmp/load-<job_id>.<fmt>`.
Returns 202 + `{job_id}` immediately (before the body has finished
arriving — the body keeps streaming into the temp file).

Query params (route owner: `packages/lore/src/mcp/http/routes/load.ts`):

- `workspace` (required) — Sprint L invariant; 400 if missing.
- `format` — one of `jsonl`, `csv`, `arrow`. Z1 ships JSONL; CSV +
  Arrow flagged in the audit for follow-on sprints.
- `target` — `node`, `edge`, `verbatim`. Determines which adapter
  the dispatcher binds.
- `embed` — `skip` (default), `queued`, `inline`. Per Sprint Z
  principle clause 8, bulk loads default to `skip` to avoid
  saturating the embed lane; the operator runs
  `lore embed reembed --workspace X --since <load_id>` to backfill
  vectors after the load.

Body size: capped at `LORE_LOAD_MAX_BYTES` (default 10 GB). Distinct
from the 10 MB `MAX_BODY_BYTES` cap on every other JSON-body route.

Response shape:

```jsonc
HTTP/1.1 202 Accepted
{
  "job_id": "<uuid>",
  "workspace": "atlas",
  "format": "jsonl",
  "target": "node",
  "state": "received",
  "checkpoint_rows": 10000,
  "created_at": "2026-05-24T..."
}
```

Backpressure / rejection cases:

- 400 — workspace missing (Sprint L).
- 413 — body exceeds `LORE_LOAD_MAX_BYTES`.
- 429 — per-workspace concurrency cap reached (Sprint Z3); the
  response includes `Retry-After: 30`.
- 503 — outbox lag exceeds threshold (Sprint O backpressure shared
  helper); the response includes `Retry-After`.

### `GET /api/load/jobs/<id>`

Read job state. Returns:

```jsonc
{
  "id": "<uuid>",
  "workspace": "atlas",
  "format": "jsonl",
  "target": "node",
  "state": "running",          // received|running|complete|failed|cancelled
  "rows_processed": 43000,
  "rows_failed": 12,
  "checkpoint_row": 40000,     // last checkpointed row (Z3)
  "errors": [{"rowIndex": 17, "errorMessage": "..."}],  // up to 100
  "created_at": "...",
  "started_at": "...",
  "finished_at": null
}
```

### `GET /api/load/jobs?workspace=X[&state=running]`

List recent jobs in the workspace, optionally filtered by state.
Default limit 50, sorted by `created_at DESC`.

### `POST /api/load/jobs/<id>/cancel`

Mark a `received` or `running` job as `cancelled`. The HTTP handler
flips store status immediately (so a `received` job is never claimed)
and signals the in-process runner. The runner polls at each parsed
row — the same cooperative style as `reconnect.ts` `shouldAbort` —
rolls back unflushed dispatcher buffers, and **must not** stamp
`complete`. Rows already flushed at a progress/checkpoint boundary
stay durable (same as a crash); remaining buffered graph/sqlite/lance
rows are dropped and never written.

## Per-substrate adapter design

The `BulkLoaderAdapter` interface
(`packages/lore/src/bulkLoader/types.ts`) is the contract every
substrate-native loader implements. Lifecycle:

```
begin(opts)  →  writeBatch(rows) × N  →  checkpoint() × M  →  commit() | rollback()
```

Three adapters shipped in Z2 (SQLite, the prior local graph engine's
adapter, LanceDB). The Surreal graph
adapter was added later, in that engine's removal effort's Phase 3c, once
SurrealDB became a workspace's graph-engine option; the prior adapter
itself was then deleted in Phase 3d, once that engine was removed entirely
(2026-08-21, see `docs/KUZU_REMOVAL.md`). Three adapters exist today:
SQLite, LanceDB, and Surreal (graph). SQLite and LanceDB are
unconditional (every workspace has exactly one of each). The **graph**
row routes to the Surreal adapter — `bulkLoader/selectGraphAdapter.ts`
picks it by a capability probe on the live graph handle, not by an
assumed class, so a graph handle exposing neither surface (e.g. cloud's
`DataplaneGraph`) fails closed per-row instead of being miscast onto an
adapter it doesn't support.

### SQLite (`bulkLoader/sqliteAdapter.ts`, 234 LOC)

SQLite has no `COPY FROM` statement — but `db.prepare(INSERT) +
db.transaction(rows)` floor-measured at **1.23M rps** in the Z0
audit (4-col TEXT/PK, WAL mode, in-process). The adapter wraps the
caller-supplied row stream in `db.transaction(rows => stmt.run(...))`.

- `begin()` opens prepared INSERT + transaction wrapper.
- `writeBatch()` invokes the transaction with the batch. Per-row
  UNIQUE violations are recorded in `errors[]` rather than failing
  the batch (matches the W9 per-item-failure pattern).
- `checkpoint()` COMMITs and BEGINs a new transaction; returns the
  last row index.
- `commit()` final COMMIT; `rollback()` ROLLBACK.

Resume: `INSERT OR REPLACE` makes replay idempotent — a kill mid-batch
leaves the SQLite WAL at the pre-transaction snapshot, and resume
from `checkpoint_row` writes the same rows again with no duplicates.

> **Historical note:** an adapter for the prior local graph engine (333
> LOC, source file since deleted) shipped in Z2 alongside SQLite and
> LanceDB, used when the workspace's graph engine was that one. It
> probed for `COPY FROM` on that engine's embedded binding, falling back
> to a prepared `MERGE (n:LoreNode {id: $id}) SET n += $props` when
> unsupported. It was deleted in that engine's removal effort's Phase 3d
> along with the rest of it (see `docs/KUZU_REMOVAL.md`); the Surreal
> adapter below is the only graph adapter today.

### surreal (`bulkLoader/surrealAdapter.ts`, 242 LOC)

The only graph adapter. SurrealDB has no bulk `COPY`-equivalent this
adapter needs to probe for — every SurrealDB build Lore supports has
the same write verbs, so `begin()` is a no-op. Instead of hand-rolling
SurrealQL, the adapter reuses the engine's own tested write path:

1. Nodes go through `SurrealGraph.bulkUpsertNodes` — batched, with
   per-node error isolation and conflict-retry.
2. Edges go through `SurrealGraph.addEdge`, one call per edge (no bulk
   edge verb exists on `SurrealGraph`) — endpoint-checked and deduped
   per `(source, target, relation)` triple.

Nodes are written before edges within a batch so an edge whose
endpoints are node rows later in the *same* batch still resolves.

A dangling edge (missing endpoint) is a per-row **failure** here —
`SurrealGraph.addEdge` refuses missing endpoints loudly, because
SurrealDB's `RELATE` would otherwise create a dangling relation. (This
was a deliberate divergence from the deleted adapter for the prior
local graph engine, whose `MERGE`
used to silently no-op the same row and count it written — stricter,
not looser: the row lands in `errors[]` instead of vanishing while
inflating `written`.)

Resume safety: `bulkUpsertNodes` is an UPSERT and `addEdge` is deduped
per triple, so replay from any checkpoint is idempotent by construction
— no temp files or transaction rollback needed.

Graph-adapter selection is not part of this file: see
`bulkLoader/selectGraphAdapter.ts`, which picks the Surreal adapter by
capability probe on the live graph handle, so a handle exposing neither
graph-write surface (e.g. cloud's `DataplaneGraph`) is never handed to
an adapter it can't back.

### LanceDB (`bulkLoader/lanceAdapter.ts`, 288 LOC)

LanceDB writes are version-commit per `table.add(batch)`. The
adapter:

- `begin()` opens the table via `lanceTablePool`.
- `writeBatch()` builds an Arrow record batch from rows (fast path
  — `Float32Array` columns flow without per-row JS allocation);
  falls back to `Record<string, unknown>[]` if Arrow build fails.
  Server-side chunking caps each `add()` at ~5k rows to bound the
  Arrow writer's in-memory footprint.
- `checkpoint()` no-op (every successful `add()` is a version-commit).
- `rollback()` deletes any versions created during this job.

Bulk-load mode defaults to `embed: skip` per principle clause 8 —
the lance vector mirror is populated asynchronously via
`embed.batch` outbox rows that the Sprint E re-embed job enqueues.

The dispatcher (`bulkLoader/loaderDispatcher.ts`, 217 LOC) selects
the right adapter per job's `target` and threads per-job options.

## Job lifecycle + state machine

```
       POST /api/load
            │
            ▼
       ┌──────────┐
       │ received │  temp file open; body still streaming in
       └────┬─────┘
            │  runner.tickOnce() picks it up
            ▼
       ┌──────────┐  checkpoint every N rows → load_jobs.checkpoint_row
       │ running  │
       └────┬─────┘
            │
     ┌──────┼──────┐
     ▼      ▼      ▼
┌────────┐┌──────┐┌──────────┐
│complete││failed││cancelled │
└────────┘└──────┘└──────────┘
```

State table: `load_jobs` (co-located with the outbox SQLite db at
`<LORE_HOME>/workspaces/<name>/.lore/outbox.sqlite`). Schema +
migrations in `packages/lore/src/storage/loadJobsMigration.ts`.

Crash recovery: on daemon boot,
`loadJobsRunner.startupReconcileAndResume()` scans `load_jobs WHERE
status='running'` and re-enters each job at row index =
`checkpoint_row`. Idempotent substrate writes (SQLite `INSERT OR
REPLACE`, surreal node UPSERT + per-triple edge dedup, lance
dedupe-by-id) make replay safe.

Completion: a single `load.done` outbox row is committed when the
job hits `complete`, carrying `{job_id, workspace, rows_processed,
rows_failed}`. External consumers see bulk-load completion through
the same outbox surface as every other write (Sprint O invariant).

## Per-workspace concurrency + backpressure

Default 3 concurrent jobs per workspace
(`LORE_LOAD_MAX_CONCURRENT_PER_WORKSPACE`). The
`WorkspaceConcurrencyManager`
(`packages/lore/src/storage/loadJobsConcurrency.ts`) holds an
in-memory counter reconciled against `load_jobs WHERE status IN
('received','running')`.

When a fourth job arrives for the same workspace:

```
HTTP/1.1 429 Too Many Requests
Retry-After: 30
{
  "error": "tenant_concurrency_exceeded",
  "workspace": "atlas",
  "in_flight": 3,
  "cap": 3
}
```

Outbox-lag backpressure shares the helper
`checkOutboxBackpressure()` with hot/warm lanes. The 503 response
includes `Retry-After` and a per-workspace lag snapshot.

The two checks fire in order: workspace_required → concurrency cap
→ outbox backpressure. Concurrency runs before outbox so a tenant
hammering the loader can't push every other tenant into 503.

## Temp-file retention

The `TempFileSweeper` runs hourly and removes:

- temp files for `complete` jobs older than `LORE_LOAD_RETENTION_HOURS_COMPLETE` (default 24 h)
- temp files for `failed` jobs older than `LORE_LOAD_RETENTION_HOURS_FAILED` (default 168 h / 7 days)
- temp files for `cancelled` jobs on the complete schedule

Failed jobs keep their temp files longer for forensic debugging. The
`load_jobs` row is retained on the same schedule (so `GET
/api/load/jobs/<id>` still returns the final error list within the
retention window).

## Performance characteristics

| Measurement | Source | Value |
|---|---|---|
| SQLite floor (in-process prepared+txn, 100k rows, 4-col TEXT/PK, WAL) | Z0 audit, Section 6 | 81 ms (~1.23M rps) |
| **Z2 in-memory perf gate** (`test/Z2-perf-100k.ts`, 100k rows through adapter) | Z2 gate test | ~312 ms (~**320k rps**) |
| Z-D3 gate target (100k rows < 5 min) | Sprint Z principle | 300,000 ms |
| W9 end-to-end ceiling (1000 rows via `POST /api/nodes/bulk`) | Sprint O0 measurement | 9,644 ms (~104 rps) |

The Z2 in-memory measurement is the substrate-native ceiling for a
healthy single-node daemon. Live end-to-end measurement (chunked
HTTP upload + parser + dispatcher + adapter) is deferred to a
live-daemon perf session and bounded by network + JSONL parse pace
rather than substrate throughput.

## Operator runbook

### Submit a bulk load

```sh
# JSONL upload, 1M nodes, default skip-embed
curl -sN -X POST \
  -H 'Content-Type: application/x-ndjson' \
  -H 'Authorization: Bearer <token>' \
  --data-binary @nodes.jsonl \
  'http://localhost:3847/api/load?workspace=atlas&format=jsonl&target=node&entityType=cre_property'
# → {"job_id":"...","state":"received",...}
```

### Poll a job

```sh
curl -sN -H 'Authorization: Bearer <token>' \
  http://localhost:3847/api/load/jobs/<job_id> | jq
```

### List recent jobs in a workspace

```sh
curl -sN -H 'Authorization: Bearer <token>' \
  'http://localhost:3847/api/load/jobs?workspace=atlas&state=running' | jq
```

### Cancel a running job

```sh
curl -sN -X POST -H 'Authorization: Bearer <token>' \
  http://localhost:3847/api/load/jobs/<job_id>/cancel
```

### Backfill embeddings after a skip-embed load

```sh
# Once the load reports state=complete, queue re-embed via Sprint E
lore embed reembed --workspace atlas --type cre_property
```

### Diagnose: bulk load is slow

1. Check the response code on the original POST. A 429 means the
   concurrency cap clamped; either wait for an in-flight job to
   finish or raise `LORE_LOAD_MAX_CONCURRENT_PER_WORKSPACE`. A 503
   means the outbox is backed up — check `/api/health` `outbox.lagSeconds`.
2. Poll the job; check `rows_processed` between two polls 60 s
   apart. If the delta is < 1000 rows, the bottleneck is downstream
   (outbox replicator, embed lane), not the loader.
3. Confirm the right adapter is in use:
   ```sh
   tail -200 ~/Library/Logs/lore/lore-server.log | grep "loaderDispatcher\|substrate="
   ```
   Look for `substrate=sqlite|surreal|lance` lines. A `substrate=verbatim`
   line on a node load indicates the dispatcher fell back to the
   per-row write path (file a bug).
4. Check checkpoint cadence: every 10k rows the runner persists a
   checkpoint. If checkpoints aren't appearing in `load_jobs`, the
   batch parser is stuck — kill the daemon and resume.

### Recover: job stuck in `running`

A job whose `started_at` is more than 1 hour old and whose
`rows_processed` hasn't advanced in the last 5 polls is hung
(typically a substrate write lock contention; rare).

```sh
# Cancel the hung job
curl -sN -X POST -H 'Authorization: Bearer <token>' \
  http://localhost:3847/api/load/jobs/<job_id>/cancel

# Restart the daemon — startup reconcile re-enters any 'running' jobs
# from their checkpoint_row
launchctl kickstart -k gui/$(id -u)/com.groundfloor.lore

# Verify the resumed job picks up at the checkpoint
curl -sN -H 'Authorization: Bearer <token>' \
  http://localhost:3847/api/load/jobs/<job_id> | jq '.checkpoint_row, .rows_processed'
```

If the row count still doesn't advance after a restart, inspect
the substrate directly:

- SQLite: `sqlite3 <LORE_HOME>/workspaces/<ws>/.lore/outbox.sqlite '.schema load_jobs'`
- graph (SurrealDB, the only graph engine): no separate lock file —
  check the daemon log for the `surreal` bulk adapter's per-row
  errors instead
- lance: confirm `<workspace>/.lore/lance/*` is writable + no
  zombie writer process holds the version

### Recover: outbox lag won't drain

Sprint O6 self-heal + drain CLI handles this:

```sh
lore outbox drain-failed --workspace atlas --check-substrate
```

See `docs/architecture/outbox.md` for the full outbox runbook.

## Sub-chain history

- **Z0** — audit + 11-case gate test + perf baseline (one commit,
  zero runtime change).
- **Z1** — streaming-upload endpoint + async job model + `load_jobs`
  SQLite table + workspace_required + outbox-lag backpressure.
  Flipped Z-D1, Z-D2, Z-D6, Z-D7, Z-D8, Z-D11.
- **Z2** — three substrate-native adapters (SQLite / the prior local
  graph engine / lance) +
  dispatcher + runner + 100k perf gate. Flipped Z-D3, Z-D4, Z-D10.
- **Z3** — checkpoint/resume helper (10k default) + per-workspace
  concurrency cap (default 3) + temp-file sweeper. Flipped Z-D5,
  Z-D9. Sprint Z gate 11/11.
- **Z4** — this document + CHANGELOG v3.5.0 + tag.

## Files

| File | Purpose | LOC |
|---|---|---|
| `packages/lore/src/mcp/http/routes/load.ts` | streaming upload + job query routes | 492 |
| `packages/lore/src/storage/loadJobsStore.ts` | `load_jobs` SQLite CRUD + types | 388 |
| `packages/lore/src/storage/loadJobsMigration.ts` | schema migration | 110 |
| `packages/lore/src/storage/loadJobsRunner.ts` | background runner | 622 |
| `packages/lore/src/storage/loadJobsConcurrency.ts` | concurrency manager + sweeper | 211 |
| `packages/lore/src/bulkLoader/types.ts` | adapter interface | 143 |
| `packages/lore/src/bulkLoader/loaderDispatcher.ts` | per-job dispatcher | 217 |
| `packages/lore/src/bulkLoader/sqliteAdapter.ts` | SQLite adapter | 234 |
| `packages/lore/src/bulkLoader/surrealAdapter.ts` | surreal graph adapter (the only graph adapter; added in the prior local graph engine's removal effort's Phase 3c — see `docs/KUZU_REMOVAL.md`) | 242 |
| `packages/lore/src/bulkLoader/selectGraphAdapter.ts` | per-workspace graph-adapter selection by capability | 69 |
| `packages/lore/src/bulkLoader/lanceAdapter.ts` | lance adapter | 288 |
| `test/sprint-Z-bulk-loader-property.ts` | 11-case gate test | — |
| `test/Z2-perf-100k.ts` | in-memory perf gate | — |

## See also

- `docs/audits/sprint-Z-bulk-loader-2026-05-24.md` — Z0 substrate
  capability inventory + adapter design decisions.
- `docs/architecture/outbox.md` — Sprint O outbox surface (the
  universal write path; `load.done` flows through this).
- `BACKLOG-storage-rename.md` — `packages/lore/src/storage/` will
  be renamed in a follow-on sprint; bulk-load files move with it.
