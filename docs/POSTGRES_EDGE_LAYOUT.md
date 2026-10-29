# Postgres edge layout 2 (integer surrogate keys)

Applies to the Postgres graph engine (`packages/lore/src/engines/postgres/`). Other engines are unchanged.

## What changed

The `edges` table used to be keyed by the endpoints' text ids: `PRIMARY KEY (workspace_id, source_id, target_id, relation)`,
with two more text indexes on the endpoints. Node ids are about 41 characters, so every edge carried its endpoints three
times over. Layout 2 keys edges by the nodes' integer surrogate keys:

```
PRIMARY KEY (workspace_id, src_sk, dst_sk, relation)
idx_edges_ws_dst_sk (workspace_id, dst_sk)    reverse lookups (who points at X), workspace-led
idx_edges_dst_sk   (dst_sk)                legacy reverse index; kept for older builds, removed by `lore postgres drop-global-sk-indexes`
idx_edges_relation (workspace_id, relation) relation-only reads (supersession, link rebuild, prune)
```

- `source_id` / `target_id` no longer exist on `edges`. Reads join `nodes` on `(workspace_id, sk)` to return the text ids,
  so the API surface (`LoreEdge`) is unchanged. `nodes.sk` is a BIGINT identity, but the invariant is that it is unique
  PER WORKSPACE (`UNIQUE (workspace_id, sk)`, constraint `nodes_workspace_sk_key`), not per database: a restore, a moved
  workspace or a sharded cluster can hold the same `sk` in two workspaces. Every join therefore names both columns
  (`ON s.workspace_id = e.workspace_id AND s.sk = e.src_sk`). The database-wide `idx_nodes_sk` is kept for older builds.
- Forward lookups (`src_sk = X`) use the primary key; there is no separate source index.
- 8-byte columns are stored first to avoid alignment padding.
- `src_sk` / `dst_sk` carry the column comment `lore:references nodes.sk`. There is no foreign key: Lore's delete paths
  and backup restore rewrite both tables in bulk, and the backup lane remaps surrogate keys by reading that comment.

### Measured (200k edges, 20k nodes, Postgres 16, `test/measure-pg-edge-sizes.ts`)

| | layout 1 | layout 2 |
|---|---|---|
| total (heap + indexes) | 73.4 MiB | 35.0 MiB |
| per edge | 385 B | 183 B |
| heap / indexes | 30.6 / 42.7 MiB | 18.2 / 16.8 MiB |

That is -52%. Layout 2 index sizes at 200k edges: primary key 14 MB, `idx_edges_dst_sk` 1.9 MB, `idx_edges_relation` 1.4 MB.
Query plans on the sample: forward lookup is an index scan on the primary key (0.07 ms), reverse lookup a bitmap scan
on `idx_edges_dst_sk` (0.14 ms), relation count an index-only scan on `idx_edges_relation` (2.4 ms). Migrating the 200k
edges took about 3 s.

## Migration (automatic, in place)

On open, `ensureGraphSchema` reads the layout from the table comment `lore:edge-layout=<n>`. A table with no stamp is
layout 1 and is converted by `postgresEdgePkMigration.ts` while holding the schema-bootstrap advisory lock (other Lore
processes opening the database wait, then find the new table):

1. STAGE: create `edges_next` (no indexes yet), `edges_dangling` and a one-row progress table.
2. COPY: ascending batches (20000 rows) over the old text key, one transaction per batch together with the progress mark.
   Endpoints are resolved through `nodes` by text id; a stored `src_sk` / `dst_sk` from an earlier intermediate layout is
   never trusted.
3. INDEX: primary key and secondary indexes built on `edges_next`.
4. SWAP: one transaction. ACCESS EXCLUSIVE on the old table (`lock_timeout` 60 s, then it fails and the next open retries
   only this phase), a catch-up pass for writes made during the copy (updates, inserts, deletes, new dangling rows), a
   count check (old = new + quarantined) that aborts on any mismatch, then renames and the layout stamp.

Every phase is idempotent and resumable: a crash resumes from the progress mark; a second opener finds layout 2 and does
nothing.

### Quarantine

A legacy edge whose source or target node no longer exists cannot be keyed. It is never deleted: the full legacy row (text
ids, provenance) plus which endpoint was missing and when goes to `edges_dangling`. The count is logged at the end of the
migration. Nothing reads the table; it has a `workspace_id` so backups include it. To re-link a row by hand, insert it
into `edges` once the missing node exists.

### Rollback

The old table is kept as `edges_pre_pk` (rows as they were at the swap). Nothing reads or writes it; it costs disk only.
To roll back, stop all Lore processes on the database, then in one transaction rename `edges` to `edges_layout2` and
`edges_pre_pk` to `edges`, and clear the layout comment (`COMMENT ON TABLE edges IS NULL`). Edges written after the swap
are not in `edges_pre_pk`. Once satisfied, reclaim the space with `lore postgres rollback-copies` (lists the copy and
checks it against the live table) and `lore postgres rollback-copies --drop edges_pre_pk --yes` (see `docs/OPERATIONS.md`).
It uses `dropPrePkEdges(client)` from `postgresEdgePkMigration.ts` after verifying; `DROP TABLE edges_pre_pk` still works
by hand. The command never drops `edges_dangling`. A new migration refuses to start while `edges_pre_pk` exists,
so a rollback copy is never overwritten.

## Version guard

An engine that understands layout N refuses a database stamped with a higher layout (`assertEdgeLayoutSupported`), with a
message telling the operator to upgrade. Engines older than the guard cannot run against layout 2 either: their writes
name `source_id` / `target_id`, which no longer exist, so they fail on the first edge write rather than writing keyless rows.
Upgrade every Lore process that shares the database before or together with the first one that opens it.

## Paging

- `queryEdges({limit, offset, ...})` keeps its contract: ordered by text `(source_id, target_id, relation)` (the join gives
  the same order as before; engines must agree on this for parity tests), limit/offset, O(offset) per page. The HTTP
  edges route's sealed offset cursors wrap this, so cursors clients already hold stay valid across the upgrade.
- `queryEdgesPage({limit, cursor, ...})` is new and Postgres-only. It pages on the physical key
  `(src_sk, dst_sk, relation)` with a row-comparison seek, so each page is one index range scan at any depth, and is
  stable under concurrent inserts. Order is by surrogate key, not text id. On the sample, a keyset page costs 2-3 ms
  versus 95 ms for an offset page at depth 100000.
  Cursor handling: no cursor = first page; a version-2 cursor from this method continues after it; anything else (an old
  text-key or offset cursor, or a tampered string) is rejected with `invalid_cursor` and the caller restarts from the
  first page. Cursors are not portable across layouts and should not be persisted.

## Backup and restore

The logical backup lane exports `edges` with `src_sk` / `dst_sk` and the `lore:references nodes.sk` comment; restore
remaps both to the new node keys, so a restore into a non-empty database (or the same one) resolves every edge to the
matching node. `edges_dangling` is backed up and restored like any workspace table. The migration scaffolding
(`edges_next`, `edges_pre_pk`) is excluded by name and listed with a reason in the discovery report.

## Tests

`test/pg-edge-pk-migration-unit.ts` (convert, quarantine, rollback copy, idempotence, resume, catch-up, guard, paging,
backup), `test/pg-edge-surrogate-keys-unit.ts`, and the backup/link suites. All skip with a printed reason when
`LORE_PG_URL` is unset.
