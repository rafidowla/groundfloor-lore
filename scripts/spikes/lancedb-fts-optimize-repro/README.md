# LanceDB 0.37.1 FTS-index-corruption-on-optimize — spike + shipped fix

Investigation for the Atlas-reported bug: `lore.runMaintenance()` →
`table.optimize()` on `lore_verbatim` repeatedly failing with

```
Cannot open index on column 'text': ... part_7_tokens.lance not found:
No such file or directory ... Skipping index merge for this column.
```

producing 5,073 orphaned `_indices/*` directories over ~12 days, with
occasional hangs blowing past Atlas's MCP request timeout.

Original investigation: branch `spike/lancedb-0.37.1-fts-repro`. The
`@lancedb/lancedb` 0.27.2 → 0.37.1 bump and the fix described below
shipped for real via `fix/lancedb-0.37.1-optimize-retry`
(`packages/lore/src/engines/maintain/adapters.ts`).

## Scripts

All five build a real `lore_verbatim`-shaped table (same Arrow schema as
`packages/lore/src/engines/verbatimStore.ts`'s `buildVerbatimSchema`) and
a real FTS index via `Index.fts(...)`, matching
`packages/lore/src/engines/verbatimBatch.ts`'s `ensureFtsIndex`.

- **`sequential.mjs [ticks]`** (plain `node`) — one process, one writer,
  sequential add → occasional delete → `optimize()` per tick, no
  concurrency. Ran 1000 ticks clean on 0.37.1.
- **`concurrent-writer.mjs [durationSeconds]`** (plain `node`) — a writer,
  a reader, and a maintenance loop racing raw `table.optimize()` directly
  (not through Lore's adapter) on one shared Table handle. This is what
  first surfaced the "Retryable commit conflict... Please retry" class.
- **`overlapping-optimize.mjs [durationSeconds]`** (plain `node`) — two
  `optimize()` loops racing each other directly on one shared handle, plus
  a trickle writer, modeling "the next tick fires while the previous
  tick's optimize() is still running."
- **`concurrent-writer-adapter.mjs [durationSeconds]`** (`npx tsx`, needs
  TS import resolution) — same scenario as `concurrent-writer.mjs`, but the
  maintenance actor calls the REAL `LanceMaintainer.optimizeTable()`
  instead of raw `table.optimize()`. `WRITER_DELAY_MS` env var paces the
  writer (default 0 = intentionally extreme zero-gap stress test).
- **`overlapping-optimize-adapter.mjs [durationSeconds]`** (`npx tsx`) —
  same as `overlapping-optimize.mjs`, but via TWO independent
  `LanceMaintainer` instances (same directory), through the real adapter.

## Findings

**Spike (2026-08-25, no fix yet):** sequential load was clean. Concurrent
load surfaced frequent, cleanly-thrown `Retryable commit conflict ...
Please retry` / `... transaction was preempted ...` errors — not the
literal reported text, but the same upstream mechanism
(`lance-format/lance#7207`, orphaned index files from a preempted Rewrite,
still open upstream as of 0.37.1). `LanceMaintainer.optimizeTable()` had
zero retry logic despite LanceDB's own error text saying "Please retry."

**Root cause of why a naive retry doesn't help:** a commit conflict means
the Table handle's cached view is already stale — it prepared its
Rewrite/CreateIndex against a base version some other writer has since
superseded. Calling `.optimize()` again on the SAME handle re-prepares
against that same stale base and fails identically (verified empirically —
retrying without a refresh did not lower the failure rate at all, even
with much larger attempt counts/backoff). The fix calls `checkoutLatest()`
to pull the handle forward before each retry.

**Shipped fix:** `retryOptimizeOnConflict()` in `adapters.ts` — up to 4
attempts, small linear backoff, `checkoutLatest()` between attempts, gated
by `isRetryableLanceConflict()` so unrelated errors (missing table,
genuine corruption) still fail fast on the first attempt.

**Before → after, measured with the `*-adapter.mjs` scripts (15s runs,
darwin-arm64, @lancedb/lancedb 0.37.1):**

| Scenario | Before | After |
|---|---|---|
| Concurrent writer+reader, moderate pace (`WRITER_DELAY_MS=20`) | ~20-23% failure | **0%** (3/3 runs) |
| Concurrent writer+reader, extreme (zero-gap writer) | ~29-32% failure | ~0-4% (avg ~1.8%) |
| Two independent overlapping `optimizeTable()` callers | ~65-73% failure, FTS ended broken in some runs | ~21-29% failure (avg ~24.7%), FTS ended broken in 1 of 5 runs |

**The residual risk in the last row is real and expected, not a bug in
the fix.** `retryOptimizeOnConflict()` protects one caller's own retry
loop; it cannot prevent two fully independent `LanceMaintainer` instances
(no shared state) from repeatedly colliding with each other. That
scenario — two maintenance-timer invocations genuinely overlapping — is
exactly what the (separately tracked, Atlas-side) isolation/supervision
work would need to prevent by construction, since only avoiding the
overlap in the first place closes it completely.

## Re-running

```
npm install   # on fix/lancedb-0.37.1-optimize-retry or later, pulls 0.37.1
node scripts/spikes/lancedb-fts-optimize-repro/sequential.mjs 1000
npx tsx scripts/spikes/lancedb-fts-optimize-repro/concurrent-writer-adapter.mjs 15
WRITER_DELAY_MS=20 npx tsx scripts/spikes/lancedb-fts-optimize-repro/concurrent-writer-adapter.mjs 15
npx tsx scripts/spikes/lancedb-fts-optimize-repro/overlapping-optimize-adapter.mjs 15
```
