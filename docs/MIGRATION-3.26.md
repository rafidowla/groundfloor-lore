# Migrating to Lore 3.26.x

For embedded hosts (Atlas, MIRA, PM Helper, nirman-tapestry) and daemon
operators upgrading from 3.25.x. See also [`CHANGELOG.md`](../CHANGELOG.md)
3.26.0 entry.

**Short version for local and embedded hosts that do not set
`DATAPLANE_API_KEY`:** nothing is required. You get the fixes in §3, §4, §5
and §7 for free, one new optional environment switch (§3) and one new call,
`lore.nodeDelete` (§7). A host that deletes nodes through `rawGraph()` should
read §7.

## 0. Behaviour changes

| Change | Who is affected | Section |
|---|---|---|
| Local-sync is registry-gated | local hosts that set `DATAPLANE_API_KEY` | §1 |
| Cloud rows are keyed by a permanent workspace id | cloud mode and local-sync | §1 |
| Deleting a workspace fails when its deletion record cannot be written | every host | §2 |
| A failed embedding-model warm-up no longer fails `open` | every host using the local embedding model | §3 |
| `maintain` answers `ok: false` + `isError` when an enabled step failed (first shipped in 3.25.2) | hosts upgrading from 3.25.1 or earlier that call `maintain` | CHANGELOG 3.25.2 |
| The `lore maintain` CLI exits 1 when an enabled step failed (it printed `FAILED:` and exited 0 before) | cron jobs and scripts that run `lore maintain` | CHANGELOG 3.26.0 |
| `lore doctor --json`, `lore outbox requeue-dead` and `lore verbatim reap` exit 1 on the failures they already printed (they exited 0 before) | scripts that run those commands and read the exit code | CHANGELOG 3.26.0 |
| Embedded mode: a missing node is no longer re-created by the replay of a save recorded in the running process, nor by a save older than a recorded delete | embedded hosts that delete through `rawGraph()` | §7 |
| SQLite outbox: a failed record is not claimed for replay before its retry time | custom code that calls `claimForReplication` | §7 |
| A failed update restores the node instead of deleting it (single saves and `POST /api/nodes/bulk`) | every host that saves nodes | §7 |
| A save whose node cannot be read beforehand is rejected with nothing written (it used to be written with empty access scopes) | every host that saves nodes | §7 |
| Every save reads the node once before writing; in cloud mode that is a network read | every host that saves nodes | §7 |
| A failed item in `POST /api/edges/bulk` restores the earlier edge instead of deleting it; each bulk edge is read once (twice when bidirectional) before it is written | hosts that use the bulk edge route | §7 |
| A failed save or delete of one relationship (`POST /api/edge`, `DELETE /api/edge`, MCP `store_edge`, MCP `delete_edge`) is undone and its outbox record withdrawn; each save reads the edge once (twice when bidirectional) and each delete once, before writing | every host that writes relationships one at a time | §7 |
| The queued record of a `supersedes` edge is one-way: replay no longer also writes `old -[supersedes]-> new` | every host that supersedes nodes | §7 |
| `POST /api/node/unsupersede` queues the removal of the `supersedes` edge, in both directions | hosts that call that route | §7 |
| Embedded mode: a replayed delete is skipped when the node exists and a newer save from the running process is queued behind it | embedded hosts | §7 |

## 1. Cloud mode and local-sync (Dataplane)

Skip this section unless the host sets `DATAPLANE_API_KEY`.

- **Set `DATAPLANE_CONNECTION`.** It names the one Dataplane connector every
  cloud call uses. Unset, Lore never sends `/v1/transaction` and logs
  `cloud_connection_unset` once at boot.
- **Workspaces must exist in the registry.** A workspace not present in the
  host's own `workspaces.json` is refused with
  `cloud_scope_workspace_not_allowed`. Provision the workspace through Lore
  before syncing it.
- **Permanent workspace id.** Each `workspaces.json` entry carries an immutable
  `id`; the `lore_workspace` column and the `lw1_` row key use it. Rename keeps
  the data. Delete + recreate under the same name gets a NEW id, so the old
  rows are not visible to the new workspace. Ids are backfilled only when a
  Dataplane-backed store is built; local and embedded hosts never rewrite
  `workspaces.json`.
- **One Lore instance per `org_id`.** Two hosts sharing an org id share a row
  namespace; the purge tool (§2) assumes one registry is the authority for an
  org.
- No data migration: nothing was deployed in cloud mode before 3.26.0.

## 2. Workspace deletion log and `lore maintain cloud-purge`

**Deletion log.** Every workspace deletion is recorded in
`<LORE_HOME>/workspace-deletions.jsonl` BEFORE the registry entry is removed.
The record is what later proves a workspace id is safe to purge. Consequences:

- A deletion **fails** (the workspace stays) when the record cannot be
  written, e.g. a read-only `LORE_HOME`. Fix the write problem and retry.
- Records are kept forever. Do not rotate or truncate the file.
- Back the file up with `workspaces.json`; without it, leftover cloud rows can
  only be purged through the explicit `--unrecorded` override.

**Purge tool.** Rows of a deleted workspace stay in Dataplane until an operator
removes them:

```bash
lore maintain cloud-purge --list                 # deleted workspaces + purge status
lore maintain cloud-purge --id <workspace-id>    # dry run: what would be deleted
lore maintain cloud-purge --id <workspace-id> --apply
```

- CLI only. Dry run by default. Not exposed over MCP or HTTP.
- Cloud mode only; org `default` is refused.
- Refuses an id that is still live in the registry, has no deletion record,
  was deleted less than 7 days ago (`--min-age` to change), or still receives
  writes.
- Deletes only rows it can prove belong to the workspace (row key recomputed
  per row). Rows that match the scope but fail the proof are left and reported.
- Exit codes: `0` complete, `1` refused, `2` aborted or failed, `3` incomplete
  (re-run).
- Full reference: `docs/DATAPLANE_INTEGRATION.md`.

## 3. Embedding-model warm-up is non-fatal; optional offline switch

Before 3.26.0 a cache miss on the local embedding model fell through to a
Hugging Face download during `open`, and a failed download (e.g. `undici`
`ETIMEDOUT`) failed the whole open.

- `open` now succeeds and logs a warning naming the model, dtype, cache
  directory and the fix. The model load is retried on the first embed.
- Embeds still fail with `EmbedModelUnavailableError` while the model is
  unavailable; `reason` is `download-failed` or `offline`.
- After a failed download Lore waits 30 s before the next download attempt.
  Embeds inside the pause fail at once with the same error (`retryInMs` set).
  A model fetched meanwhile is used immediately, without waiting.
- **New: `LORE_MODELS_OFFLINE=1`** (or `true`). Lore never attempts a model
  download; a cache miss fails fast with the fix in the message. Off by
  default. Environment only: it must reach the shared `lore-models` process,
  which a `createLore()` option would not.
- Pre-fetch the model for a `LORE_HOME`: `lore models fetch-embedding` (this
  command still downloads with the switch on).
- The models directory follows `LORE_HOME`, not `createLore({ dataDir })`. A
  run with a fresh `LORE_HOME` has an empty model cache.

## 4. Outbox dead-letter watch

Rows parked as `dead` with `superseded by newer same-key write (RA-6)` are no
longer reported as dead-letters or `DATA LOSS`. Applies to rows already in
existing outbox files; no migration. Stats keep `dead` as the total and add
`deadSuperseded`.

## 5. No-op history rows

An identical re-store that passes a field as explicit `undefined` no longer
writes a version row. No action.

## 6. Dependency warnings on install

- `sharp`: still reported through `@lancedb/lancedb`'s optional
  `@huggingface/transformers` 3.0.2. Not fixable in Lore; keep the host-side
  `overrides` entry.
- `uuid`: still reported through `exceljs` 4.4.0. Lore 3.26.0 keeps `exceljs`
  as its spreadsheet reader; keep the host-side workaround you use today.

## 7. Deleting nodes from an embedded host

**New call:** `await lore.nodeDelete({ id, workspace })` returns
`{ deleted, verbatimWarning? }`. It records the delete in the outbox, removes
the graph node and its relationships, tombstones the verbatim row, appends the
WAL entry and writes one `lib:nodeDelete` audit row. See
[`API_REFERENCE.md`](API_REFERENCE.md).

**What was wrong.** In embedded mode a save is applied to the graph at once and
also recorded in the outbox. When that record was replayed and the node was
missing, Lore assumed a crash had lost the write and created the node again. A
host that deleted with `lore.store.storageClient.rawGraph().deleteNode(id)`
therefore saw the node return on the next replicator tick (both graph engines).

**What changed.**

- A save recorded before a delete of the same node (`nodeDelete`, MCP
  `delete_node`, or a replayed delete record) never re-creates the node. That
  includes a save left unfinished by a crash.
- Otherwise a missing node is re-created only by a record that was already
  unfinished when the process started. A record written by the running process
  no longer re-creates it.
- A save made after a delete is kept, including when the delete record is
  replayed after the save.
- Each outbox record replayed on its own is claimed first, and a replicator runs
  one tick at a time. Such a record is no longer replayed twice by overlapping
  ticks. The batched verbatim and embedding paths are unchanged.
- One process replays a data directory's outbox. The delete bookkeeping lives in
  that process; a second replaying process on the same directory is not
  supported.

**Failed saves.** A save that fails partway (the graph write throws, or its
verbatim outbox record cannot be written) used to delete the node, including a
node that existed before the save. It now puts the earlier node back: same
content, same `createdAt` and counters, relationships untouched. A node the
failed save created is still removed. `POST /api/nodes/bulk` behaves the same
way. What a host can observe:

- **`updatedAt` moves.** The restore is a real write, so a restored node shows
  the time of the restore (both local engines also reset `syncedAt`, as on any
  save). It runs even when
  the failed write changed nothing.
- **A save can now fail before it writes.** If the node cannot be read before
  the write, `nodeUpsert` rejects with `nodeUpsert could not read the current
  state of <id> before writing (...); nothing was written`, and the bulk route
  fails that item. Nothing is written and nothing is queued, so a retry is safe.
  Before 3.26.0 such a save went through with empty access scopes.
- **One read per save.** Every save reads the node once before writing; before,
  only a save that omitted `security_scopes` did. In cloud mode it is a network
  read.
- A change made by `supersedeNode` while the save was in flight is kept, and a
  node deleted meanwhile is not brought back.

**Failed bulk relationship writes.** A failed item in `POST /api/edges/bulk`
used to be compensated with a delete of the forward edge, which removed a
relationship that existed before the request. The route now reads each edge
before it writes and puts the earlier edge back (same `confidence` and
`confidenceScore`); an edge the failed item created is removed, in both
directions for a bidirectional item. What a host can observe:

- **One or two reads per bulk edge** (two when bidirectional). In cloud mode
  they are network reads.
- **An item can fail before it writes.** If the edge cannot be read first, the
  item fails with `could not read the edge before writing: ...; nothing was
  written`. Nothing is written or queued for it, so a retry is safe. On
  SurrealDB an id the engine rejects now fails here, with this text.
- **Outbox records.** When the failed item's record was already picked up, it
  is replayed once, then one record per direction puts the earlier edge back.
  If a later item of the same request then succeeds on that edge, one more
  record is written so the replay ends on that item's edge.
- **Custom graph engines.** The read uses `getEdge(sourceId, targetId,
  relation)` when the engine has it (SQLite, SurrealDB and Dataplane do),
  `queryEdges` otherwise. An engine with neither keeps the old behaviour.

**Failed single relationship writes.** `POST /api/edge`, `DELETE /api/edge`,
MCP `store_edge` and MCP `delete_edge` behave the same way. Before 3.26.0 a
write that failed kept its outbox record, so the edge appeared later (or an
edge that was still there was removed later) although the caller had been told
the call failed. Now the graph is put back as it was and the record is
withdrawn; a record that was already picked up is followed by one that puts
the earlier state back. What a host can observe:

- **The error is the same.** The caller still gets the original write error.
- **One or two reads per save, one per delete.** In cloud mode they are network
  reads.
- **A call can fail before it writes.** If the edge cannot be read first, the
  call fails with `could not read the edge before writing: ...; nothing was
  written` or `could not read the edge before deleting: ...; nothing was
  deleted`. Nothing is written or queued, so a retry is safe.
- **`POST /api/edge` with a missing endpoint** no longer leaves a queued record
  that creates the edge once the node appears. Save the edge again after the
  node exists.
- **A failed pre-read on `POST /api/edge` is always a 500**, also when the
  engine's message contains "not found" (it was a 400).
- **Custom graph engines:** a bidirectional save on an engine with no
  `addBidirectionalEdge` is rejected with `this graph cannot write a
  bidirectional edge; nothing was written`, before anything is recorded.
- **Not covered.** Three cases are logged and not undone: an undo that itself
  fails, a record that can be neither withdrawn nor followed by a correcting
  one, and a failed delete whose record was already picked up on an engine
  that cannot read edges. Writers that do not take the per-edge lock (the
  storage facade's `addEdge`, the `lore supersede` CLI, CLI runs of
  `lore reconnect` and `lore sync`, admin import and migrate, the bulk loader,
  the schema relation operations): an edge one of
  them writes for the same triple between a failed call's read and its undo is
  removed by that undo. Sync pull, reconnect's inferred edges and the ArcadeDB
  replay lane DO take the lock when they run inside the daemon or an embedded
  host.

**`supersedes` edges.**

- The queued record of a `supersedes` edge (written by a save with
  `supersedes`, MCP `supersede_node` and `POST /api/node/supersede`) is now
  one-way. Before, its replay also wrote the reverse edge,
  `old -[supersedes]-> new`. Recall's supersession filter reads the node's
  `supersededBy` field, not this edge; `traverse` and `subgraph` showed it.
  Reverse edges already in a graph are not removed by the upgrade, and a record
  queued by an earlier version still replays both ways.
- `POST /api/node/unsupersede` now queues the removal of the edge, so a
  still-queued supersede record replayed afterwards no longer brings it back.
  It removes the reverse edge of that pair too (and queues that removal),
  unless the newer node is itself superseded by the older one or cannot be
  read. So the call now records two `edge.delete` records, not one.
- These writers now take the same per-edge lock as the request-path edge
  writers.

Unchanged: the bulk node delete route (`POST /api/nodes/bulk-delete`).

**Replay order.** When a delete record and several later saves of the same id
are replayed together, the node ends on the newest save. A custom `OutboxStore`
may implement the new optional
`newestNodeUpsertAfter(workspace, nodeId, sequenceId): Promise<OutboxEntry | null>`
(the newest `node.upsert` row for that id still `pending`, `failed` or
`replicating`, with a higher `sequenceId`); without it the first replayed save
wins, as before. The SQLite outbox creates one index,
`idx_outbox_node_upsert_id`, when it opens (an existing outbox gets it on its
first open under 3.26.0); no migration step. The older save is never written in
place of the newest: if the newest save's payload fails to write, the record
fails and is retried, and a payload that can never be written ends as two
dead-letter records with the node absent. `lore doctor` reports them and
`lore outbox requeue-dead` replays them once the cause is fixed.

**What to do.**

- Replace raw graph deletes with `lore.nodeDelete`. A workaround that stops the
  replicator and drains the outbox before each raw delete (Atlas 0.3.8) can be
  removed once the host calls `nodeDelete`.
- Raw deletes keep working. A raw delete of a node saved by the running process
  is no longer undone. Two gaps remain for a raw delete, and `nodeDelete` has
  neither:
  - the node's verbatim row is left behind (not tombstoned);
  - if the node's last save is still unfinished from before start-up (the
    process stopped before it was replayed, or the raw delete runs right after
    start-up before the first replay), that save is replayed as crash recovery
    and the node comes back.
- Do not mix raw deletes and `nodeDelete` on the same id.
- A custom `OutboxStore` may implement the new optional
  `claimForReplication(entryId): Promise<boolean>`; without it the replicator
  behaves as before.

## 8. Checklist

- [ ] Hosts with `DATAPLANE_API_KEY`: set `DATAPLANE_CONNECTION`; confirm every
      synced workspace is in `workspaces.json`.
- [ ] Include `<LORE_HOME>/workspace-deletions.jsonl` in backups.
- [ ] Air-gapped or CI hosts: run `lore models fetch-embedding` once, then set
      `LORE_MODELS_OFFLINE=1`.
- [ ] Keep the `sharp` override and any `uuid` workaround.
- [ ] Embedded hosts that delete nodes: switch from
      `rawGraph().deleteNode()` to `lore.nodeDelete({ id, workspace })` and drop
      any stop-and-drain workaround.
- [ ] Coming from 3.25.1 or earlier: a `maintain` caller should read `ok` /
      `failedOperations`; a step that used to fail quietly now reports as an
      error.
- [ ] Scripts or cron jobs that run `lore maintain`: a failed step now gives
      exit code 1. Decide whether the job should alert, retry or carry on.
- [ ] Scripts that run `lore doctor --json`, `lore outbox requeue-dead` or
      `lore verbatim reap`: a reported failure now gives exit code 1 (the
      output is unchanged). A health check that only read the JSON `ok` field
      keeps working.
