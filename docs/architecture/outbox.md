# Outbox — universal write path

Sprint O (closed 2026-05-24, v3.3.0) made the outbox the **only**
write path through Lore. Every API write — hot single-node, bulk,
edge, delete — first commits a row to the durable outbox, then
returns success to the caller. A background replicator drains the
outbox and fans out to substrate stores (the graph substrate —
SurrealDB by default as of v3.13.0, Kùzu supported per workspace —
LanceDB vectors, verbatim docs, SQLite). This document describes the
contract, the runtime, and the operator runbook.

Audience: Lore daemon engineers + operators who need to debug an
"outbox lag spiked" alert at 2am.

---

## The 9-clause Sprint O contract

The contract Lore signs with its callers. Each clause is enforced
by a gate test case in `test/sprint-O-outbox-property.ts`
(`O-D1`..`O-D11`). All 11 cases are green at v3.3.0.

> **Outbox-as-universal-write-path (effective Sprint O):**
>
> 1. Every write — hot single-store, bulk, and any future warm/cool/bulk lanes — commits to the outbox table BEFORE returning success to the caller.
> 2. The outbox commit carries: `(operation_type, workspace, payload_blob, monotonic_sequence_id, created_at, status='pending')`.
> 3. The replicator service is the only component that reads the outbox and writes to substrate mirrors (the graph substrate — SurrealDB or Kùzu, per workspace — LanceDB vectors, SQLite tables, verbatim docs).
> 4. Replication is per-workspace — one slow workspace doesn't block others.
> 5. API write returns success the moment the outbox commit lands (sub-100 ms in steady state).
> 6. When outbox lag exceeds the configurable threshold, write endpoints return `503 outbox_lag` with `Retry-After` header.
> 7. Crash recovery: replicator restarts from the last-replicated outbox sequence ID. No write is lost; some may be replayed (idempotent fan-out required).
> 8. `/api/health` reports per-workspace outbox depth + last-replicated lag in seconds.
> 9. Sprint L's `workspace_required` contract is preserved — every outbox row carries workspace; no outbox commit possible without workspace.

---

## How a write reaches the substrate

```
HTTP POST /api/node  (or /api/nodes/bulk)
         │
         ▼
  withOutbox(store, entry, fn)   ─── O2 / O3 wiring
         │
         │  1. store.record(entry)         ← durable commit, fsync
         │  2. fn() runs the request-path side effects (validation,
         │     in-memory caches) but NOT substrate writes
         │  3. respond 200 to caller       ← contract clause 5
         │
         ▼  (returns; HTTP response already sent)

──────── boundary: caller is done ────────

  OutboxReplicator (background loop)
         │
         │  every idleMs / busyMs:
         │    for ws in store.listWorkspacesWithPending():
         │      batch = store.listPendingForWorkspace(ws, 100)
         │      for entry in batch:
         │        markEntryStatus(id, 'replicating')
         │        dispatch(entry, substrates)     ← idempotent fan-out
         │        markEntryStatus(id, 'replicated')
         │        advance lastReplicatedSeq cursor
         │
         ▼
  graph (SurrealDB or Kùzu, per workspace) / LanceDB / verbatim store
```

Key files:

- `packages/lore/src/outbox/coordinator.ts` — `withOutbox()` wrapper
- `packages/lore/src/outbox/store.ts` — `FileOutboxStore` (JSON legacy)
- `packages/lore/src/outbox/sqliteStore.ts` — `SqliteOutboxStore` (default)
- `packages/lore/src/outbox/replicator.ts` — background poller
- `packages/lore/src/outbox/dispatcher.ts` — `operationKind` → substrate router
- `packages/lore/src/outbox/lagCache.ts` — per-workspace cache routes consult on the hot path
- `packages/lore/src/outbox/recovery.ts` — boot-time per-step recovery (legacy, complements the replicator's cursor-based resume)

---

## Outbox commit state machine

Each outbox entry transitions through these entry-level states
(`OutboxStatus` in `types.ts`):

| State | Meaning |
|---|---|
| `pending` | Just committed; replicator has not picked it up yet. |
| `replicating` | Replicator has started its fan-out call. |
| `replicated` | All substrate writes acknowledged; `replicatedAt` set. |
| `failed` | Last attempt threw; will be retried on next tick. `attempts` incremented. |
| `dead` | Exceeded `maxAttempts` (default 5) OR threw an unrecoverable error (`UnwiredOperationKindError`, `MissingPayloadError`). Skipped on future polls; **needs operator attention**. |

`completed` (boolean column) is set when the entry reaches
`replicated`. `listUnfinished()` returns everything with
`completed = 0`.

Per-step `StepStatus` (`pending`, `done`, `failed`) is the older
sync-engine schema; it coexists with the entry-level status for
pre-O1 producers. The replicator drives entry-level status; the
legacy `recoverOutbox()` driver in `recovery.ts` drives per-step
status for the verbatim/vector mirror lane.

---

## How the replicator polls

The `OutboxReplicator` loop in `replicator.ts`:

```
loop:
  for ws in store.listWorkspacesWithPending():
    batch = store.listPendingForWorkspace(ws, batchSize=100)
    cursor = store.readReplicationState(ws)
    for entry in batch:
      if entry.sequenceId <= cursor.lastReplicatedSeq: skip   ← crash-resume guard
      replicateOne(entry)
      if ok and entry.sequenceId > advanced: advanced = entry.sequenceId
    if advanced > cursor: store.writeReplicationState(ws, advanced)
  refreshLagCache()
  sleep(busyMs if work else idleMs)
```

**Per-workspace independence (clause 4).** Each workspace gets its
own batch on its own tick. A workspace stuck behind a slow graph
write does not block writes to a different workspace — the next
tick picks up the un-blocked workspace's batch and replicates it
normally.

**Backoff.** `failed` entries are picked up on the next tick with
`attempts` bumped. After `maxAttempts` (default 5) they are marked
`dead`. Two unrecoverable error classes short-circuit to `dead`
immediately rather than burning attempts:
- `UnwiredOperationKindError` — programming error: a producer
  wrote an `operationKind` the dispatcher does not know.
- `MissingPayloadError` — programming error: required payload
  field absent.

---

## Backpressure semantics (clause 6)

When the replicator falls behind, callers see `503 outbox_lag`
with a `Retry-After` header rather than a silent latency cliff.

The trigger lives in `mcp/http/middleware.ts`. Inputs:

- `OutboxLagCache` — refreshed once per replicator tick (and once
  at boot before the loop starts) from
  `store.aggregateStats()`. Holds per-workspace `depth` +
  `lagSeconds` + `dead`.
- Thresholds — configurable per-workspace (see middleware for the
  current defaults; commonly `depth > 5000` OR `lagSeconds > 60`).

Per-workspace isolation (clause 4 applied to backpressure): a
write to workspace `A` is rejected only when workspace `A`'s
queue is hot. Workspace `B` writes still succeed even if `A` is
flooded — the cache key is the request's workspace, not the
global aggregate.

Fail-open: if the cache is unwired (e.g. test-mode wiring without
a replicator), routes return success rather than fail-closed. The
rationale: backpressure exists to protect substrate health, not
to gate functional correctness. In production, the replicator
always wires the cache.

---

## Crash recovery guarantees (clause 7)

The outbox is the only durable record of "an API write was
accepted". The substrate stores are derivative — they can be
torn down and reconstructed by replaying outbox rows.

**Resume marker.** Each workspace has a `lastReplicatedSequenceId`
cursor (stored as `lastReplicatedSeq` in
`outbox_replication_state`; both names refer to the same value).
On boot, the new replicator reads the cursor and only processes
rows whose `sequenceId` is strictly greater.

**Idempotency requirement.** A row CAN be replayed if the daemon
crashed after the substrate write but before
`markEntryStatus('replicated')` landed. Therefore every substrate
writer wired into the dispatcher must be idempotent under repeat
calls with the same payload. Both graph engines satisfy this by
construction — SurrealDB's `upsertNode` (default as of v3.13.0) and
per-triple-deduped `addEdge`, and Kùzu's `MERGE`-based upsert (still
supported per workspace). LanceDB vector mirror is
idempotent on `(node_id, embedding_version)`. New `operationKind`
handlers added to the dispatcher MUST satisfy the same property
or pass a `sequenceId`-aware upsert path (Option B from the O0
audit).

**Verification.** `test/O5-crash-recovery-integration.ts` proves
the contract end-to-end:
1. Write 100 rows.
2. Run replicator with a flaky substrate; ~40 succeed, the rest
   fail mid-fanout.
3. Close the store handle (simulates daemon exit / crash).
4. Reopen the SQLite file with a new replicator + happy substrate.
5. Assert: every row processed exactly once across the boundary,
   final cursor at 100, zero duplicate substrate calls.

The test runs in-process for full determinism (no daemon spawn
race) and is included in the gate test suite at v3.3.0.

---

## Self-heal + operator drain (Sprint O6, v3.4.1)

Sprint O6 closes the "duplicate-retry artifact" gap discovered
2026-05-24 where a row could land in substrate successfully but
still get marked `status='failed'` by the replicator — leaving
the queue permanently stuck behind a row that should have been
`replicated`. At enterprise scale (Sprint Z bulk loader, 10x
more writes/sec) this would manifest as periodic "Lore is down"
backpressure alerts on healthy daemons.

### Self-heal tick

The replicator runs a periodic sweep — by default once every
`selfHealIntervalMs = 60_000 ms` (1 minute) — that lists
`status='failed'` rows older than `selfHealGraceMs = 5_000 ms`
(5 s, the grace window shields against in-flight write races)
and probes substrate per row via `verifyApplied(entry, substrates)`.
If substrate already holds the row's effect, the replicator flips
the row to `replicated` and bumps the `selfHealed` counter on its
stats block.

Tunable via env:

| Variable                              | Default | Purpose                                          |
|---------------------------------------|---------|--------------------------------------------------|
| `LORE_OUTBOX_SELFHEAL_INTERVAL_MS`    | 60000   | Cadence between sweeps                           |
| `LORE_OUTBOX_SELFHEAL_GRACE_MS`       | 5000    | Min age of a `failed` row before self-heal touches it |
| `LORE_OUTBOX_SELFHEAL_BATCH`          | 256     | Max rows per sweep                               |

### Verifier hooks per operation kind

Each substrate exposes a CHEAP indexed probe wired into
`DispatcherSubstrates`:

| Operation kind     | Probe       | Verified iff…                          |
|--------------------|-------------|----------------------------------------|
| `node.upsert`      | `hasNode`   | the workspace's graph has a node with this id |
| `edge.upsert`      | `hasEdge`   | the workspace's graph has the (src, tgt, relation) triple |
| `node.delete`      | `hasNode`   | the workspace's graph does NOT have the node |
| `edge.delete`      | `hasEdge`   | the workspace's graph does NOT have the edge |
| `verbatim.upsert`  | `hasVerbatim` | LanceDB has row with this id         |
| `embed.batch`      | `hasEmbeddings` | Every targetNodeId has a vector    |
| `sync.vector.mirror`, `embed.done` | n/a | Not self-healable (left for retry / dead) |

A probe that throws degrades to "not verified" — self-heal stays
safe under a misbehaving substrate.

### Operator drain CLI — `lore outbox drain-failed`

The CLI is the operator's hammer when self-heal cadence isn't
fast enough (e.g. mid-incident) or when probes need to be skipped
entirely (e.g. an aborted import where substrate is known empty).

```
# Preview what self-heal would recover, all workspaces
lore outbox drain-failed --dry-run

# Recover everything in one workspace
lore outbox drain-failed --workspace default

# After a substrate wipe — evict every failed row without probing
lore outbox drain-failed --workspace aborted-import \
    --no-check-substrate --mark-dead
```

Flags:

- `--workspace <ws>` — default: all workspaces
- `--check-substrate` (default) — probe each row before deciding
- `--no-check-substrate` — skip probe (pair with `--mark-dead`)
- `--mark-dead` — mark un-recovered failures `dead` after sweep
- `--dry-run` — report-only, no mutation
- `--limit N` — cap sweep size (default: replicator's
  `selfHealBatchSize`, 256)

The CLI does NOT require the daemon to stop. The mutation is a
single `UPDATE` per row in WAL mode, idempotent against the
replicator's own self-heal tick.

### Gate cases

| Case  | Asserts                                              |
|-------|------------------------------------------------------|
| O-D12 | failed-but-substrate-replicated rows auto-recover    |
| O-D13 | operator can drain stuck rows via CLI without restart |

Both ship green at v3.4.1 in `test/O6-self-heal-property.ts`.

---

## Storage backends

Two implementations of `OutboxStore` ship; pick via
`LORE_OUTBOX_BACKEND` env var:

| Backend | When | Notes |
|---|---|---|
| `sqlite` (default) | Sprint O3c onwards | `outbox.sqlite` (WAL mode) at `<loreHome>/.lore/`. Per-row INSERT/UPDATE; no rewrite-the-world cost. Default since v3.3.0. |
| `json` | Emergency rollback only | `outbox.json` whole-file rewrite on every mutation. Has a perf cliff at ~500 entries (O3b measurement: 134 s for 1000-row batch on JSON vs 10 s on SQLite). |

**Migration.** On first boot of v3.3.0 (or any post-O3c build)
the SQLite store auto-migrates an existing `outbox.json`:
1. Open `outbox.sqlite` (creates the schema).
2. If `outbox.sqlite` has 0 rows AND `outbox.json` exists, copy
   every entry across in a single SQLite transaction.
3. On success: rename `outbox.json` to
   `outbox.json.migrated-<ISO_TIMESTAMP>` (kept indefinitely for
   safety; the file is never deleted).
4. On failure: roll back the SQLite transaction; leave
   `outbox.json` untouched. The daemon continues with the JSON
   backend until the operator intervenes.

Re-running the migration is a no-op: step 2's "0 rows" guard
short-circuits.

---

## Operator runbook — "outbox lag spiked, what do I do?"

### Step 1 — confirm the alert is real

```
curl -s http://localhost:3847/api/health | jq '.outbox, .perWorkspaceOutbox'
```

You should see:

```json
{
  "depth": <total pending+replicating+failed>,
  "lagSeconds": <oldest pending age>,
  "dead": <rows over retry budget>,
  "perWorkspace": { "<ws>": { "depth": ..., "lagSeconds": ..., "dead": ... } }
}
```

If `depth` is 0 and `lagSeconds` is 0, the alert was stale — the
lag cache had not refreshed yet. Wait one replicator tick (default
~250 ms idle) and re-check.

### Step 2 — identify the slow workspace

Read `perWorkspaceOutbox`. The workspace with the highest
`lagSeconds` is the suspect. Per-workspace isolation (clause 4)
means **only writes to that workspace are seeing 503s** — other
workspaces are fine.

### Step 3 — check substrate health

The replicator's fan-out target is the bottleneck. Common causes:

| Symptom | Likely cause | Action |
|---|---|---|
| `lagSeconds` rising but `replicated` count in logs also rising | Substrate is slow but progressing | Wait for drain; do not restart |
| `lagSeconds` rising, no `[outbox replicator]` log lines | Replicator hung or unwired | Restart daemon; check `/api/health` shows the replicator stats block |
| `dead > 0` | Rows failed `maxAttempts` times — substrate is broken or producer wrote a bad payload | Inspect dead rows: `sqlite3 .lore/outbox.sqlite "SELECT id, operationKind, lastError FROM outbox_entries WHERE status='dead'"` |
| All workspaces lag | Disk full, fsync pathology, or process-wide graph-substrate lock contention (SurrealDB or Kùzu) | Check disk space; check graph substrate logs; restart daemon |

### Step 4 — options

- **Wait for drain.** The most common case. Backpressure (clause
  6) is doing its job — incoming writes get 503s with
  `Retry-After`, the replicator catches up, the cache clears, and
  writes resume. No operator action needed.
- **Restart the replicator** (= restart the daemon at the
  moment). The cursor is durable in `outbox_replication_state`,
  so restart replays at most one in-flight batch — idempotent.
- **Run `lore outbox drain-failed`** (preferred — added in Sprint
  O6, v3.4.1). Sweeps every `status='failed'` row, probes substrate
  via the dispatcher's `verifyApplied` hook, and flips rows the
  substrate already holds to `replicated`. Operator-safe; no
  daemon restart required. See "Self-heal + drain" below.
- **Drain a single dead row manually.** Pre-O6 fallback only.
  Use when `lore outbox drain-failed --workspace <ws>` cannot reach
  the substrate (e.g. the graph substrate — SurrealDB or Kùzu — is down) and you need to evict a poison
  row to unblock the queue:
  ```
  sqlite3 .lore/outbox.sqlite \
    "UPDATE outbox_entries SET status='replicated', completed=1, replicatedAt=datetime('now') WHERE id='<id>'"
  ```
  Skips the replicator's fan-out for that row. Substrate state
  must be checked manually afterwards.
- **Scale the substrate.** If the graph substrate (SurrealDB or Kùzu) / LanceDB sustainably can't
  keep up, the long-term fix is on the substrate side. The
  outbox protects correctness, not throughput.

### What NOT to do

- **Do NOT delete `outbox.sqlite`.** It is the only durable
  record of writes the substrate has not yet seen. Deleting it
  silently drops every pending write. If you absolutely must
  reset, snapshot the file first.
- **Do NOT manually edit `outbox_replication_state`.** Lowering
  `lastReplicatedSeq` will cause replay of already-applied rows.
  Idempotent substrates tolerate this but it's wasteful and
  audit-noisy. Raising it will cause data loss.
- **Do NOT disable the replicator and write to the substrate
  directly.** That bypasses the contract (clauses 1, 3) and
  corrupts the cursor.

---

## Embed pipeline integration (Sprint E, v3.4.0)

Sprint E added two embedding-specific operation kinds to the
outbox:

| operationKind | payload | producer | dispatcher action |
|---|---|---|---|
| `embed.batch` | `{ texts: string[]; targetNodeIds: string[] }` (same length) | bulk-write lane (default `embed:'queued'`); `lore embed reembed` CLI | `BatchedEmbedder.embedBatch(texts)` → `storeEmbedBatch({ targetNodeIds, vectors })` |
| `embed.done`  | `{ targetNodeIds: string[] }` | (handler-emitted on flush) | optional `onEmbedDone` hook — no-op friendly |

### Producer side

- **Hot single writes** (`POST /api/node`) stay inline-by-default
  — embed runs synchronously alongside the substrate write so
  recall after a single write is immediately consistent. The
  E-D5 regression sentinel pins this behaviour.
- **Bulk writes** default to `embedMode: 'queued'`. The request
  commits N `node.upsert` rows + ONE `embed.batch` row covering
  every node in the batch, then returns. Per-item override via
  `embed: 'inline' | 'skip' | 'queued'`. Empty queued batches
  skip the `embed.batch` row entirely (keeps the outbox clean
  when every item is `inline` or `skip`).
- **Re-embed jobs** (`lore embed reembed --workspace <ws>`) walk
  the workspace's existing nodes and enqueue
  `ceil(N / chunkSize)` `embed.batch` rows (default `chunkSize`
  = 256). Resumable — duplicate enqueues result in vector
  upserts, so re-running an interrupted job is safe.

### Replicator side — consolidation (Sprint E3)

On each tick the per-workspace batch is walked with a small
state machine: when an `embed.batch` row is encountered, the
replicator looks ahead for adjacent `embed.batch` rows and
merges their `texts` / `targetNodeIds` arrays into ONE
`BatchedEmbedder.embedBatch` call up to
`EMBED_BATCH_CONSOLIDATION_CAP` (default 1024 texts per merged
dispatch).

- 5 outbox rows × 50 texts each → 1 model call × 250 texts
  (instead of 5 separate model warm-ups + 5 `storeEmbedBatch`
  round-trips).
- Non-embed rows (`node.upsert`, `edge.upsert`, `verbatim.upsert`,
  ...) between two `embed.batch` rows break the run — Sprint O
  cross-kind ordering is preserved.
- A poison consolidated batch still drains: each row in the run
  bumps its own attempt counter, so retry-budget exhaustion
  flips contributing rows to `dead` individually rather than
  blocking the workspace forever.
- Set `EMBED_BATCH_CONSOLIDATION_CAP` to 0 to disable
  consolidation (per-row dispatch only). Useful for isolating
  the duplicate-retry artifact described in
  `BACKLOG-outbox-replicator-duplicate-retry-artifact.md`.

### Operator runbook — re-embed

```
# Plan
lore embed reembed --workspace default --dry-run

# Restrict by type / tag
lore embed reembed --workspace atlas --type AtlasNode --batch-size 512

# Watch progress on the daemon side
curl -s http://localhost:3847/api/health | jq .outbox
```

The CLI does not require the daemon to be running. Rows sit in
SQLite until the next daemon boot picks them up (crash-resumable
replication, Sprint O5).

---

## Test coverage at v3.4.0

| Test | What it covers |
|---|---|
| `test/sprint-O-outbox-property.ts` | 11 gate cases (O-D1..O-D11) — contract enforcement |
| `test/sprint-E-embed-property.ts` | 8 gate cases (E-D1..E-D8) — embed pipeline contract |
| `test/outbox-foundation-unit.ts` | `withOutbox` wrapper, `record` semantics |
| `test/outbox-unit.ts` | `FileOutboxStore` (JSON backend) primitives |
| `test/outbox-sqlite-store-unit.ts` | `SqliteOutboxStore` primitives + migration |
| `test/O3-bulk-outbox-perf-unit.ts` | bulk-lane perf (O-D11 baseline) |
| `test/E1-batched-embedder-unit.ts` | BatchedEmbedder contract + dispatcher integration |
| `test/E2-skip-on-write-unit.ts` | bulk-lane `embed.batch` producer shape |
| `test/E3-reembed-unit.ts` | replicator consolidation + re-embed job |
| `test/O4-backpressure-unit.ts` | 503 outbox_lag + per-workspace isolation |
| `test/O5-crash-recovery-integration.ts` | crash mid-fanout → resume → no duplicates |
| `test/chaos/outbox-crash-recovery.ts` | per-step legacy recovery (sync.vector.mirror) |
| `test/sprint-O-outbox-property.ts` — `O-D10` | Sprint L regression sentinel |

---

## Related sprints + onward

- **Sprint L** — `workspace_required` invariant (clause 9
  ancestor). Sprint O preserves it via the regression sentinel
  `O-D10`.
- **Sprint E / Z / S / H** (queued) — the outbox is the
  foundation these enterprise-data-plane sprints depend on.
  Eventing (E), replicated read paths (Z), substrate health
  monitors (S), and historical query / time-travel (H) all
  consume the outbox cursor or stream.

For the sprint trace, see `docs/audits/sprint-O-outbox-audit-2026-05-24.md`
and the O sub-chain closure nodes in the default workspace.

---

## R1 — Lore outbox vs. Dataplane `/transaction` (post-#13 cloud-validation)

Added 2026-05-24 to close DATAPLANE_INTEGRATION.md Section 10
remediation item R1. Future maintainers will otherwise conflate
the two.

| Concern | Dataplane `/transaction` | Lore outbox |
|---|---|---|
| Scope | Intra-connector atomicity (Postgres in one tx, Arango in another) | Cross-substrate + event fan-out durability |
| Guarantee | All-or-nothing within one connector | At-least-once across substrates and downstream consumers |
| Failure mode | Tx aborts; no partial commit | Row stays in outbox until every consumer ACKs |
| Idempotency | Caller-supplied `idempotency-key` (24h TTL) | Outbox row id is the natural dedupe key (no TTL) |
| Replay window | None — once committed, gone | Until consumer cursor advances past the row |

**Complementary, not redundant.** In cloud mode the outbox will
still front the writes Lore does to Dataplane: each Lore call
becomes an outbox row, the dispatcher reads the row and issues
the Dataplane `/transaction`, and the outbox row is only marked
ACKed when every downstream consumer (graph, vector, audit,
sync) has handled it. Atomicity is delegated; cross-substrate
durability + fan-out remains Lore-side.

**Why preserve both layers in cloud:**
- Dataplane `/transaction` doesn't fan out to multiple consumers
  (graph + vector + audit + sync). The outbox does.
- Dataplane idempotency-key TTL is 24h; outbox replay window is
  bounded only by retention policy.
- Outbox semantics (the O-D1..O-D11 contract) survive substrate
  swaps. Without it, every substrate change would re-litigate
  the at-least-once + crash-recovery story.

See `docs/audits/cloud-validation-checkpoint-2026-05-24.md` §6 R1.
