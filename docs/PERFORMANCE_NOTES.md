# Performance Notes — Lore Core

Operational and architectural notes about hot-path performance, what
optimizations are in place, and which limitations are imposed by the
underlying engines (the graph engine — SurrealDB, the only graph engine
since the prior local graph engine was fully removed 2026-08-21, see
`docs/KUZU_REMOVAL.md` — / LanceDB / SQLite).

This document is the single home for "we looked at it; here's the
plain story" performance notes that don't fit cleanly into
`OPERATIONS.md` (which is for operators) or `architecture.md` (which
is for the high-level design).

---

## 1. `LoreNode` table — no secondary indexes (prior local graph engine limitation, HISTORICAL)

> **Moot as of 2026-08-21 — the prior local graph engine was fully removed
> (see `docs/KUZU_REMOVAL.md`).** Everything below describes a real
> constraint of that engine specifically, kept as the investigation record
> (why fake DDL wasn't added, what mitigations exist) rather than deleted.
> It no longer describes a current limitation — there is only one graph
> engine now, SurrealDB, and its own secondary-index story is unrelated
> (see `SurrealFeatures.indexes` / `LORE_SURREAL_DEFINE_INDEXES` in
> `engines/surreal/surrealConnection.ts` for that engine's own index
> situation, which is a separate, still-current topic this note doesn't
> cover).

**Status (as of the original investigation, superseded — see above):**
Engine-limited to the prior local graph engine (selected via the legacy
graph-engine config value), not fixable in core at the time. Mitigated by
bounded queries and caller-side patterns.

### What was investigated

Audit finding `perf-listnodes-bulklist-fullscan-no-index`
(AUDIT_FINDINGS_2.md §A.3) flagged that the `LoreNode` table declares
only `PRIMARY KEY (id)` — no index on `updatedAt`, `type`, `project`,
or `ecosystem`. Hot readers (`listNodes`, `bulkListNodes`,
cursor-paginated `reconnect`) all `ORDER BY n.updatedAt DESC`, which
without a secondary index forces the graph engine to do a full table scan +
sort on every page. At enterprise volume (K ≥ 100k nodes) this becomes
O(N²/pageSize) work for full-corpus reconnect.

### What we tried

We probed the prior local graph engine's embedded package directly (see
`docs/KUZU_REMOVAL.md`; used when a workspace was configured for the legacy
graph-engine config value). The Cypher parser rejects every variant of
`CREATE INDEX` at parse time:

```
CREATE INDEX idx_k ON T(k)              -> Parser exception
CREATE INDEX IF NOT EXISTS idx_k ON T(k) -> Parser exception
CREATE SECONDARY INDEX idx_k ON T(k)    -> Parser exception
CREATE INDEX idx_k ON TABLE T(k)        -> Parser exception
CALL create_index('T', 'k', 'idx_k')    -> Catalog exception: function does not exist
```

Only the primary-key index (built automatically on the `id` column) is
available. That engine's embedded package (0.11.x) does not expose
secondary index DDL.

### Why we did NOT add fake DDL

It would be easy to drop `CREATE INDEX IF NOT EXISTS …` statements
into `localGraph.ts` and silently swallow the parser error in the
existing migration loop. We deliberately did not, because:

1. The resulting schema looks indexed but isn't — every future
   contributor reading the DDL would believe the index exists.
2. The hot reader would still scan + sort; nothing changes at runtime.
3. The next person debugging a slow `listNodes` at K=100k would
   waste hours before discovering the index is decorative.

This section is moot now that engine has been removed entirely (see
`docs/KUZU_REMOVAL.md`); it is kept only as the investigation record.

### Mitigations in place today

Lore Core already bounds the damage from the missing index in
several ways. None of these makes the underlying scan cheaper, but
together they keep the worst-case work bounded and predictable.

1. **`DEFAULT_LIST_NODES_CAP = 10_000`** (`engines/loreNodeRow.ts`).
   No-arg `listNodes` is capped at 10 k rows. Callers that truly need
   the whole corpus must pass `{ unbounded: true }` — an audit-visible
   opt-in.

2. **Cursor pagination on `bulkListNodes`** (`engines/graphBulkList.ts`).
   The HTTP `/api/nodes/bulk-list` route always paginates;
   `(updatedAt, id)` is a stable tiebreaker. Pages stay small. The
   per-page sort is still O(N) work, but the result set the client
   sees is bounded.

3. **`listNodes` result memoization** (`engines/localGraphReads.ts:406`).
   The filter tuple (`type`, `tag`, `project`, `ecosystem`, `limit`) is
   the cache key; the cache is invalidated on every write via
   `bumpSearchEpoch`. UI panels that re-open the same filter pay the
   sort exactly once per epoch.

4. **Semantic-recall-first paths.** `recall` and `search` go through
   LanceDB (HNSW vector index), NOT through `listNodes`. The
   full-table-scan path is only hit by:
   - the admin UI's filter drawer (always paginated, bounded by item 2),
   - the nightly `reconnect` job (paginated, off-hours).

5. **`reconnect` paging** (`engines/reconnect.ts`). Pages by
   `bulkListNodes` with `PAGE_SIZE=1000`. At 1 M nodes this is ~1000
   pages × O(1M) work per sort = expensive, but **bounded and
   schedulable**. Operators run it off-hours; it's not a synchronous
   user-facing path.

### What the operator should do at scale

If a deployment crosses the K = 100 k node line and `reconnect` /
admin-UI list latency becomes a problem:

1. **Run `reconnect` off-hours.** It's the only job that scans the
   full corpus; schedule it during low traffic.
2. **Keep `listNodes` callers bounded.** Anything that passes
   `{ unbounded: true }` should be audited — most code paths can use
   the default 10 k cap.
3. **Prefer semantic recall over list scans.** UI and API surfaces
   that need "recent N of type X" should use `recall` (vector path)
   first; fall back to `listNodes` only for explicit admin browsing.

### What unlocks the real fix

This was moot the moment the engine was removed (see
`docs/KUZU_REMOVAL.md`); it is preserved for historical completeness only.
At the time, the real fix — true secondary indexes on `(updatedAt)`,
`(type)`, `(project)` — would have required one of:

- The embedded package gaining `CREATE INDEX` support (track upstream).
- Migration to a larger variant of the same engine family (different
  package, larger install footprint, needs evaluation against the
  package-size decision that led to the smaller embedded package).
- A SQLite-side `(workspace, updatedAt, id)` lookup oracle that
  cursor pagination consults for the row-id list, then hydrates
  through the graph engine by primary key. This is a meaningful
  architecture change — it splits the cursor source of truth across two
  stores and complicates the write path (every write would have to keep
  the oracle in sync, transactionally). Not justified at the customer
  scale reached before the engine was removed.

The recommendation in the audit finding (verifier downgraded to
medium) is: **defer the structural fix; document the limitation;
keep the bounded-query guards healthy.** That is what this section
records.

---

## 2. See also

- `OPERATIONS.md` — running the daemon, log levels, health endpoints.
- `architecture.md` — high-level engine layout (tri-substrate).
- `AUDIT_FINDINGS_2.md` §A.3 `perf-listnodes-bulklist-fullscan-no-index`
  — original audit finding.
- `SWARM_QUEUE_2.md` NW-4c — task that closed out as a not-a-bug, citing the
  prior local graph engine's index limitation (see `docs/KUZU_REMOVAL.md`).
