# Maintain — access-time coldness signal

Design + rationale for the `lastAccessedAt` / `last_retrieved_at` coldness
signal that backs `lore maintain`'s node retention. Shipped 2026-06-06.

## Problem

`maintain`'s node retention archives/deletes nodes that are "older than N days
**and cold**." Lore originally had no access-time column, so "cold" was
approximated by `updatedAt` — which measures *last edit*, not *last use*. A
node nobody edits but everyone recalls would be wrongly classified cold.

## Why a naive stamp-on-read is dangerous

A stamp-on-read is a write-on-read. Two existing mechanisms make the naive
version actively harmful (both verified in code):

1. **Read-cache epoch.** Every graph write calls `readCache.bumpEpoch()`
   (`localGraph.ts`); `getNode`/`search`/`recall` memoize on that epoch
   (`cache.ts`). Stamping via the normal `upsertNode` path would invalidate
   the recall cache on every recall.
2. **Sync/embed triggers.** `upsertNode` sets `syncedAt=''` and bumps
   `updatedAt`; the sync engine and embed queue key off those. An access stamp
   through that path would queue a re-sync + re-embed on every read.

**Design rule:** access stamps bypass `upsertNode`, the epoch, `updatedAt`, and
`syncedAt` entirely.

## Design

- **Two local-only columns** on `LoreNode` (additive ALTER, tier-1 safe):
  - `lastAccessedAt` — most recent read of ANY kind (recall, search, getNode,
    traverse, graph-view topology).
  - `last_retrieved_at` — most recent INTENTIONAL retrieval (recall / search /
    get_full results only).
  - Neither is ever synced to cloud (access is instance-local; syncing it would
    cause cross-machine churn for zero benefit).
  - Backfilled to `updatedAt` on first boot (idempotent; only empty rows).

- **`AccessTracker`** (`engines/accessTracker.ts`) — a debounced in-memory
  accumulator. Read handlers call `getAccessTracker()?.touch(ids, source)`
  (O(1) Map insert, no I/O). A timer (default 60s, `LORE_ACCESS_FLUSH_MS`)
  drains it and writes all pending stamps in one batched pass. N reads in a
  window collapse to ≤1 write. Wired at boot (local mode only) and final-flushed
  on graceful shutdown.

- **`stampAccessTimes(entries)`** — the only writer of these columns. No
  `bumpWriteEpoch`, no `updatedAt`/`syncedAt` mutation. Implemented on
  `SurrealGraph` (`engines/surreal/surrealGraphWrites.ts`, wired as a class
  method on `engines/surrealGraph.ts`) — the ONLY local graph engine as of
  2026-08-21 (the prior Cypher-based `LocalGraph` this was originally built
  against was removed that day; see surrealGraph.ts's header). Batches
  entries by their `(accessedAt, retrievedAt)` pair into one `UPDATE $ids`
  statement per group (direct record targeting, same form `markStaleByIds`
  uses), rather than the prior engine's per-id loop. Not part of
  `LoreGraphHandle` — duck-typed and feature-detected by
  `engines/accessTracker.ts`'s `ensureAccessTracker()`, since cloud's
  DataplaneGraph deliberately lacks it (access coldness is a local-disk
  capacity concern). No outbox row: these columns are instance-local
  telemetry, never synced to cloud (see below), so there is nothing for a
  replica to replay.

- **`maintain` policy `coldSignal`** (`retrieval` | `access` | `update`,
  default `retrieval`). `selection.ts` reads the chosen field, falling back to
  `updatedAt` → `createdAt` when empty.

## The graph-view tension (product decision)

Operator chose "all reads count, including graph-view loads." The visualizer's
topology load returns ~300 nodes; if those all count as "accessed," opening the
graph once keeps the whole workspace warm forever and retention never fires.

**Reconciliation:** record both timestamps (so all reads ARE tracked — useful
for "recently viewed" UI later), but split by source so retention isn't held
hostage by browsing. The default `cold_signal=retrieval` trusts only deliberate
retrieval, so browsing never saves a node from cleanup. An operator who truly
wants graph-view to protect nodes sets `cold_signal=access`.

## Known tradeoffs

- **Cache visibility lag.** Because the flush bypasses the epoch, a freshly
  stamped access time is invisible to a *cached* `getNode`/`listNodes` until the
  entry's TTL lapses (default 60s) or a real write bumps the epoch. Irrelevant
  to nightly retention (coarse by days); the alternative (bumping the epoch) is
  exactly the cost we're avoiding.
- **Crash loss.** The accumulator is in-memory; a hard crash loses ≤1 flush
  interval of stamps. Acceptable for an approximate signal; graceful shutdown
  flushes.
- **Cross-workspace recall.** Stamps target the active workspace graph; access
  to non-active workspaces via `workspace:'*'` recall is best-effort.

## Tests

- `test/maintain-unit.ts` — `cold_signal` selection (retrieval spares
  retrieved, access spares browsed, update ignores access; updatedAt fallback).
- `test/access-coldness-surreal-unit.ts` — against a real `SurrealGraph`
  (2026-09-03, X-accesstimes audit fix, replacing the old
  `maintain-access-integration.ts` that ran against the now-deleted
  `LocalGraph` backed by the prior graph engine): `ensureAccessTracker()` is
  no longer a no-op; `stampAccessTimes` sets the columns WITHOUT touching
  `updatedAt`/`syncedAt`/epoch (the three invariants); an untouched node
  stays unstamped; `AccessTracker.touch → flush` path; end-to-end —
  `selectRetentionCandidates` with `cold_signal='access'` spares the
  touched node and selects the untouched one; best-effort — a failing
  write (read-only-style error, transaction-conflict/lock-style error) is
  swallowed, never thrown.
