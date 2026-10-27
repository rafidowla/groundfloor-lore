# Deleting a workspace

Deleting a workspace in Lore hides it at once and erases the data Lore controls after a recovery window.
This page says exactly what is erased, when, how to undo it, how to check it, and what Lore cannot reach.

## What happens when you delete

`DELETE /api/workspaces/:name` (and the maintain command's ephemeral-workspace expiry) do this, in order:

1. Lore closes every open handle on the workspace (graph, verbatim store, ingestion). If a handle cannot be closed
   the delete is refused and nothing changes.
2. The local data folder is renamed, in one atomic step, to a hidden holding folder
   `<LORE_HOME>/workspaces/.erase-hold-<permanent id>`. A new workspace with the same name can never pick up the old folder.
3. A `deleted` record with `eraseAfter` and `holdingPath` is appended to `<LORE_HOME>/workspace-deletions.jsonl`.
4. The workspace is removed from the registry. From now on it is unreachable by name.

The HTTP response keeps its existing fields and gains an `erase` object:

```json
{ "erase": { "status": "scheduled", "eraseAfter": "2026-11-01T12:00:00.000Z", "windowDays": 7,
             "restoreCommand": "lore workspaces restore <id>", "notReached": "Copies outside Lore ..." } }
```

`status` is `scheduled` (hidden, erased after the window), `erased` (erased in this call), `erasing` (erase started but
not finished; Lore retries) or `not-scheduled` (nothing was erased because another workspace still uses the same data).

## The recovery window

`LORE_WORKSPACE_ERASE_AFTER_DAYS` (integer, default `7`, `0` = erase at once). See [CONFIGURATION.md](CONFIGURATION.md).
Each deletion records its own erase date, so changing the setting affects only later deletes. There is no switch
that turns the scheduled erase off.

## Erase now

- HTTP: `DELETE /api/workspaces/:name?erase=now` (any other value of `erase` is a 400).
- CLI: `lore workspaces erase-now <id>` (works on a workspace that is already deleted and waiting).

Both use the same permission as a normal delete. No new permission exists.

While a daemon is running on the same `LORE_HOME`, use the HTTP route, or stop the daemon before running the CLI. The
CLI runs in a second process, and an audit line the daemon writes at the same instant as the CLI's audit rewrite can be
lost (see "Known limits" under the audit-log step). A cross-process lock is a planned follow-up.

The audit entry for an HTTP `?erase=now` request (or any delete whose erase ran inside the request, i.e. `eraseStatus`
`erased` or `erasing`) names the workspace by permanent id only: `args: {workspaceId, erase, eraseStatus}`, no name. It is
written after the audit blank-out, so a name in it would never be blanked. The actor is kept, so the entry still records
who erased. A delete that only schedules the erase keeps `args.name`; that entry is blanked when the erase runs.

## Restore (CLI only)

```
lore workspaces deleted                         # find the id
lore workspaces restore <id> [--as <new-name>]  # bring it back with the SAME permanent id
```

Restore works only while no erase has started. It refuses, and says why, when the old name or folder is now taken by
another workspace (use `--as`). There is no HTTP route for restore. Restart the Lore service afterwards.

## The scheduled erase

The daemon and an embedded `createLore()` host both run a tick about a minute after boot and then hourly. It erases
every deleted workspace whose `eraseAfter` has passed. A partly failed erase is retried with backoff (15 minutes,
doubling, capped at 24 hours) and every attempt is recorded. A lock file (`<LORE_HOME>/workspace-erase.lock`) keeps
the daemon, the CLI and a second host on the same home from erasing at the same time; a lock left behind by a crashed
process is detected and taken over.

Run order, so nothing is orphaned: ingestion blobs, then engine rows (Postgres / Dataplane), then side stores (outbox
rows, the workspace-paths entry), then the local folder, then the OS keychain entry.

## Receipts

Each erase appends to `workspace-deletions.jsonl` (the file stays version 1; readers skip lines they do not know):

- `{"event":"erased","id","at","status":"complete"|"partial"|"needs-operator","stores":[...],"unverifiableStreak"?}` per-store result with removed and remaining counts. `unverifiableStreak` (absent = 0) is the number of consecutive attempts in which every incomplete store was `unverifiable`.
- `{"event":"erase-failed","id","at","attempt","error"}` (secrets are scrubbed).
- `{"event":"restored","id","at","name"}`.

A receipt is `complete` only when every store reports it verified nothing is left. A store that cannot prove that
(`unverifiable`) or that left something behind makes the receipt `partial`, and Lore keeps retrying.

## When retrying cannot help: `needs-operator`

Some `unverifiable` results never resolve by retrying (data in shared storage that cannot be told apart from another
workspace's, a link where a folder should be, no Postgres connection configured for a Postgres workspace). So that the
tick does not retry them forever:

- After an erase attempt in which every remaining incomplete store is `unverifiable` (no `partial` step, no thrown
  failure) for `LORE_WORKSPACE_ERASE_MAX_UNVERIFIABLE_ATTEMPTS` consecutive attempts (integer 1-100, default `5`; anything
  else uses the default), the receipt is written with status `needs-operator`.
- A `partial` step (a real failure that may clear) or a failed attempt never counts and resets the run.
- The counter lives in the receipts in `workspace-deletions.jsonl` (`unverifiableStreak`), so it survives restarts.
  Receipts written by older versions have no such field and load as 0. An older Lore reading the log skips a
  `needs-operator` line as unknown and keeps retrying, as before.
- The scheduled tick skips a `needs-operator` record. `lore workspaces deleted` (also `--json`) shows state
  `needs-operator`, the reason for each store (`reasons`), the attempt count and the per-store receipt. The record cannot be restored.
- `lore workspaces erase-now <id>` still works on it: a manual run resets the counter and runs every store again. If it
  finishes, the receipt is `complete`; if the stores are still unverifiable the record goes back to retrying and, after the
  limit again, to `needs-operator` (exit code 2 while it is not complete).
- What an operator does: read the reason per store, check or clean that store by hand, then run `erase-now`.

There are no erase counters in `/api/admin/stats` or the metrics endpoint today, and no HTTP listing of deleted workspaces
(the CLI is the only listing), so this state is visible through the CLI and the log.

## What each store does

| Store | Behaviour |
|---|---|
| Local folder (SQLite, vectors, verbatim, graph) | The holding folder is removed. Refuses symlinks, mount points and anything outside the managed workspaces folder. |
| Dataplane (cloud, local-sync) | Uses the same per-row proof as `lore maintain cloud-purge`; the existing `purge` events still count. |
| OS keychain key | Removed by name, only when no live workspace has that name. |
| Outbox rows, workspace-paths entry | Keyed by name; removed only when no live workspace has that name. |
| Postgres rows, uploaded files (ingestion blobs) | Wired into every erase path (daemon tick, embedded host, `?erase=now`, maintain expiry, `lore workspaces erase-now`). Uploaded files are erased by the blob step. Postgres rows are erased for real: the engine keys every row by the workspace's permanent id (`POSTGRES_ROWS_KEYED_BY = 'permanent-id'`), so the step deletes only that id's rows, and the receipt can be `complete`. |

## Postgres and blob erasers

Lane f6a. Both erasers implement the `WorkspaceEraser` contract (match only by the permanent workspace id, idempotent, verify after erasing, batches, never throw for "nothing to erase"). Run order in the lifecycle: ingestion blobs, then engine rows, then the local directory, then the keyring.

### Postgres (`createPostgresWorkspaceEraser`, store `postgres`)

Tables are found from the live catalog, not a list:

- every ordinary or partitioned table in the schema with a `workspace_id` column (nodes, edges, verbatim, link tables, opt-outs, table-storage tables `lore_entity*`, ingestion tables `lore_ingest_*`, history versions, and migration scaffolding such as `edges_next`, `edges_pre_pk`, `verbatim_pre_partition`, `verbatim_common_lexemes`, `edges_dangling`);
- the workspace's list-partition of `verbatim` (`verbatim_ws_<hash>`, recognised by its bound `FOR VALUES IN ('<id>')`): DETACH then DROP;
- per-workspace read views `lore_tv_<entity_type_id>` and per-field partial indexes `lore_ev_<field_id>_u|_i`.

Not erased on purpose (no workspace column, reviewed list `GLOBAL_POSTGRES_TABLES`): `verbatim_changes_log`, `verbatim_partition_progress`, `edges_pk_progress`. A progress cursor that names the target is reported as `partial`, never edited.

Batching: rows are deleted in `ctid` batches (default `batchRows`), each batch repeating the workspace predicate so a `ctid` collision cannot touch a neighbour. The step is resumable: an abort returns `partial` and a second run completes. After deleting, the eraser VACUUMs the touched tables and re-counts; `complete` only when every count is 0.

Fail-safe: a table that has an unrecognised workspace-like column, or is neither covered nor on the reviewed list, makes the result `unverifiable`, never a silent `complete`. A test fails the build when a new `CREATE TABLE` appears that is in none of the groups.

Keying: the engine stores the workspace's permanent id in `workspace_id` (`POSTGRES_ROWS_KEYED_BY = 'permanent-id'`), so `erase()` deletes the target id's rows and nothing else. Rows written by older builds were re-keyed from name to id by a one-time migration at engine open (see CHANGELOG, lane g1), including those of deleted (held) workspaces. The old count-only mode (`rowsKeyedBy: 'workspace-name'`) remains for tests: it deletes nothing and returns `unverifiable`. The lifecycle must not treat `unverifiable` as erased.

### Ingestion blobs (`createIngestionBlobEraser`, store `blobs-fs` or `blobs-groundfloor`)

- Blob refs come from the ingestion store's own records (`listSourceBlobRefs`, paged), never from scanning the blob store.
- A ref is deleted only when no other workspace's ingestion store records it (`countBlobRefsHeldByOtherWorkspaces`) and the optional `isRefHeldElsewhere` hook says no. Kept shared refs are named in `detail`, not counted as remaining.
- `has()` is checked before `delete()` so a second run does not double-count; a failed delete gives `partial`; a blob store that cannot delete or confirm gives `unverifiable`.
- `wholeStore: true` is for a dedicated per-workspace SQLite ingestion file (all refs in it belong to the target).

### What is not reachable

- Physical bytes: Postgres erase is a logical delete plus VACUUM. Freed pages, WAL and backups/snapshots can still hold the data until overwritten or expired.
- Filesystem blob refs are `<sha256(workspace name)[:16]>/<sha>`, so a same-name successor workspace with identical bytes shares the ref; the target's own store cannot see the successor. Use `isRefHeldElsewhere` until blobs are namespaced by permanent id.
- Postgres ingestion job and source ids hash the workspace's permanent id, not its name (`job_id` is a global primary key), so a same-name successor re-ingesting identical content gets its own ids while the old workspace's rows are still held. Rows written before that change carry name-hashed ids; the store still finds them, inside its own workspace's rows only, so a resubmission of identical work is a repeat.
- Groundfloor Files blobs are deleted through the API; copies the platform keeps in its own backups are outside Lore.

### How the engine erasers are wired (lane f6c)

- One place builds them for every path (`resolveErasers` in `engines/workspaceErase/lifecycle.ts`, using `hostErasers.ts`): the daemon tick, the embedded `createLore()` host, `DELETE ...?erase=now`, maintain expiry and `lore workspaces erase-now`. A caller-supplied eraser for the same store replaces the built-in one.
- The Postgres eraser runs only when `LORE_PG_URL` is set (otherwise `not-applicable`, or `unverifiable` if the deleted workspace was on Postgres). It uses its own small connection pool, never the host's shared pool, and closes it afterwards.
- **Direct Postgres:** rows are keyed by the permanent id, so a name reused by a new workspace never shares rows with the deleted one. The Postgres step deletes the deleted workspace's id only and can report `complete`.
- The blob step is guarded by name. If a LIVE workspace now has the same name, files inside the deleted workspace's own `.erase-hold-<id>` folder (fs blob store) are still erased, because that folder belongs to the old id alone. Anything keyed by name in shared storage (Files API blobs, whose refs start with a hash of the name) is left alone and the step is `unverifiable`, so the receipt stays `partial`. It is `not-applicable` only when a live workspace uses the same folder.
- The local-dir step checks only the id-derived holding folder against live workspaces for a new-style delete, so re-creating a workspace with the old name (at the old default folder) does not stop the old held data being erased. If it does refuse while the held folder still exists, the step is `unverifiable`, never `not-applicable`.
- Outbox rows are keyed by name too: when a live workspace reuses the name, the deleted workspace's not-yet-sent queue rows (if any) cannot be told apart and are left in the queue, which drains on its own.
- A dedicated per-workspace SQLite ingestion file is erased as a whole; Postgres ingestion tables are erased by permanent id through a private pool.
- Maintain expiry no longer fails when the local folder is gone but another store left the receipt `partial`; the receipt is retried.

## What delete does NOT erase

- Database backups and exports made by an operator. Lore cannot reach them; they expire on your own backup schedule.
- Copies of audit records that a non-file audit exporter (`LORE_AUDIT_EXPORTER=splunk|datadog|elastic`, or a custom one) has already sent to an external system such as a SIEM. Lore cannot recall or edit them; erase them there. The default file exporter's sidecar `<LORE_HOME>/audit-export.jsonl` IS erased (blanked) by the audit-log step.
- Audit entries that cannot be tied to the deleted workspace, for example a delete by node id or `retention.sweep`. They carry no workspace name or id, so they are left as they are (decided 2026-10-25). See the audit-log step below.
- The `workspaces.delete` entry of an erase-now HTTP request. It is written after the erase, but carries only the permanent id (see "Erase now"), never the name.

### Audit log step (`audit-log`, runs last)

The deleted workspace's entries in `<LORE_HOME>/audit.jsonl`, the rotated `audit.jsonl.<ts>.gz` archives and the file exporter's copy `<LORE_HOME>/audit-export.jsonl` are blanked, not removed (Rafi 2026-10-25: audit content may hold sensitive client data).

- **Kept on a blanked line:** `timestamp`, `toolName` (the action), `result` (the outcome), `durationMs`, `prevHash`, and `anchorHash` on a genesis record.
- **Blanked:** `actor` (becomes `{id:'redacted',roles:[]}`), `args` (becomes `{}`), `resultDetail`, `approvalId`.
- **Added:** `redacted: {at, by:'workspace-erase', workspaceId, runId, origHash}`. `origHash` is the sha256 of the original line, so the next line's `prevHash` still matches. The chain is not recomputed.
- **Marker:** one `audit.redacted` entry is appended per run with `{runId, workspaceId, count, digest}`. The digest covers every `origHash` plus a digest of the kept fields. It names the permanent id only, never the workspace name.
- **Matching:** an entry belongs to the workspace when its args contain the permanent id, or when its `workspace`/`oldName`/`newName` (or `name` on `workspaces.*` tools) equals the name within the workspace's lifetime (creation to deletion plus 60 s) and no other workspace could have held that name then. If another holder overlaps, the entry is ambiguous: it is left untouched and the step reports `unverifiable` (the receipt stays `partial`, then `needs-operator`).
- **Verification:** `verifyChain()` and `verifyChainWithHistory()` accept a blanked line only if it is in the exact canonical blanked form and a later marker of the same run vouches for it. The full-history verifier also checks the marker's count and digest; the live-file verifier only checks that a marker exists, because the marker can cover archived lines. Changing a kept field, forging a blanked line or dropping the marker fails verification.
- **Rewrite safety:** archives are rewritten via temp file + fsync + rename, keeping their mtime (archive order depends on it). In the running process, appends are paused for the rewrite. A crash between rewrite and marker is repaired on the next run by a `recovered` marker.
- **Export copy (`audit-export.jsonl`):** the default local exporter writes a second copy of every audit record. It is blanked with the same matching rule and the same stub form, keeping line count and timestamps. It is not a hash chain, so it gets no marker. A running exporter is paused, its queued records are written first (so they are blanked too), the file is rewritten, then appending resumes; no appended record is lost. The receipt says `complete` only when this file is clean too; if it cannot be rewritten the step is `partial` and is retried. If the file does not exist (exporter off, or a cloud exporter), there is nothing to do. The exporter does not rotate this file. Erases completed before this fix (3.37.0) left their lines in this file.
- **Known limits:** a second process appending at the same time (for example `lore workspaces erase-now` while a daemon runs) is only narrowed by a size/mtime check before the rename; run CLI erase-now with the daemon stopped, or use HTTP `?erase=now`. A same-user attacker can still append a forged marker (tamper-evidence, as with the rest of the chain). Each audit file is read whole (256 MB cap).

## Older deletes (legacy records)

A `deleted` record written before this change has no `eraseAfter`. Lore does not erase these automatically (no surprise
data loss on upgrade). `lore workspaces deleted` lists them as "kept — legacy delete"; `lore workspaces erase-now <id>`
erases one on request. They cannot be restored, because their data was never moved. The switch is the single constant
`AUTO_ERASE_LEGACY_DELETES` in `engines/workspaceErase/config.ts`.

## How to verify

1. `lore workspaces deleted` shows the state and the latest receipt per store.
2. `grep '"event":"erased"' <LORE_HOME>/workspace-deletions.jsonl` shows the receipt lines.
3. `ls <LORE_HOME>/workspaces/` shows no `.erase-hold-<id>` folder once complete.
