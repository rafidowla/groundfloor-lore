# Upgrading Lore

How to upgrade the Lore daemon between versions and how its schema-migration
tooling (`lore migrate`) works — including what can and cannot be rolled back.

Source of truth: `cli/commands/migrate.ts`, `cli/commands/migrateOnline.ts`,
`migration/coordinator.ts`, and the V1 migrators under `engines/`.

See also: [`OPERATIONS.md`](./OPERATIONS.md) (running the daemon) and
[`BACKUP_RESTORE.md`](./BACKUP_RESTORE.md) — **back up before any upgrade or
migration; a restore is the only guaranteed rollback for an irreversible step.**

Current version: **3.11.0** (the plugin system was removed in 3.11.0 — domain
logic now lives in standalone client applications, not in Lore Core).

---

## Standard version-to-version upgrade

Lore data lives in `<LORE_HOME>/` (default `~/.groundfloor/`) and is independent of
the installed binary, so an upgrade is mostly "swap the binary, restart, verify."

```bash
# 1. Stop the daemon (avoids a mid-write backup; also releases SurrealDB's
#    single-writer handle on the workspace).

# 2. BACK UP every workspace first — this is your rollback path.
lore backup --all --out /srv/lore-backups

# 3. Upgrade the package (however you install it, e.g.):
npm i -g @groundfloor/lore@latest      # or your pinned version

# 4. Restart and verify.
lore serve --http &
lore doctor
# `workspaces.globalTotals` is full-body-only (needs a Bearer) — `version`
# is present in both the lite and full bodies. See docs/OPERATIONS.md's
# "GET /api/health" section for the anonymous-vs-authenticated split.
curl -s -H "Authorization: Bearer $(cat ~/.groundfloor/auth.token)" \
     http://localhost:3847/api/health | jq '.version, .workspaces.globalTotals'
```

If `lore doctor` is clean and `/api/health` reports the new `version` with sane
per-workspace counts, the upgrade is good. If not, roll back: stop the daemon,
reinstall the prior version, and (if data changed) restore from the backup taken in
step 2 per [`BACKUP_RESTORE.md`](./BACKUP_RESTORE.md).

> Most upgrades need **no** explicit `lore migrate` step. Schema migrations are an
> opt-in tool for specific, named transitions — covered below.

### Note on `LoreNode` indexing

There is **no one-time index-build step** on upgrade:

- **SurrealDB** (the only graph engine) has secondary B-tree indexes
  (`DEFINE INDEX`, `engines/surreal/surrealConnection.ts`) but ships them
  **default OFF** — `@surrealdb/node@3.0.3` leaks a libuv handle from the
  `DEFINE INDEX` that builds an index, so the daemon process never exits
  after `close()`. Set `LORE_SURREAL_DEFINE_INDEXES=1` to opt in once that
  upstream leak is fixed, or if you've accepted the trade.

Either way, hot list/cursor readers (`listNodes`, `bulkListNodes`, `reconnect`
paging) rely on bounded queries (`DEFAULT_LIST_NODES_CAP = 10_000`) and result
memoization, not on indexes. See [`PERFORMANCE_NOTES.md` §1](./PERFORMANCE_NOTES.md)
for the full story — what we tried, why we did not add decorative DDL, and what
operators should do at K ≥ 100 k nodes (run `reconnect` off-hours, prefer semantic
recall over list scans).

---

## `lore migrate`

`lore migrate` is a dispatcher over several distinct migration paths. Run it with
no recognized target to see the built-in usage list. The targets:

| Target | What it does |
| --- | --- |
| `v1-sqlite [<path>] [--apply] [--archive]` | One-off: migrate a legacy V1 `knowledge.db` SQLite file into the local graph (SurrealDB, the only graph engine) |
| `embedding-model --to <modelId> [--dim <n>] [--apply] [--force]` | Re-embed the corpus into a different embedding model's vector space |
| `workspace-to-workspace --from <a> --to <b> [filters] [--apply]` | Move filtered nodes (and optionally edges + vectors) between workspaces |
| `list [--substrate <name>] [--workspace <name>] [--status <s>]` | List online schema migrations tracked in `migrations.sqlite` |
| `status <id>` | Detail for one migration (phase, status, error, applied_at) |
| `apply <spec.json>` | Execute an online schema-migration spec |
| `rollback <id>` | Reverse a previously applied migration |

### One-off data migrations

These are **dry-run by default** — they report what they would do and only write
when you pass `--apply`. That makes them safe to inspect before committing.

**V1 SQLite → local graph** (legacy v1 → v2 import):

```bash
lore migrate v1-sqlite                 # dry-run against ~/.groundfloor/knowledge.db
lore migrate v1-sqlite --apply         # actually import
lore migrate v1-sqlite --apply --archive  # import, then move the source to ~/.groundfloor/archive/
```

The dry run prints nodes/edges read, what would be imported, ID conflicts (V1 ids
that collide with existing graph nodes are **skipped**, never overwritten), and
content-duplicate flags. `--archive` is ignored without `--apply`; without
`--archive` the source SQLite is left in place for you to delete manually.

**Embedding-model swap** (re-embed into a new vector space):

```bash
lore migrate embedding-model --to <modelId>          # dry-run
lore migrate embedding-model --to <modelId> --apply  # drop + rebuild lore_verbatim
```

`--apply` **drops and rebuilds** the LanceDB `lore_verbatim` table for the new
model. Back up first — the old embeddings are removed.

**Workspace moves** are likewise `--dry-run` by default; pass `--apply` to commit.
See `lore migrate workspace-to-workspace --help` for the filter flags.

---

## Online schema migrations (the `migrations.sqlite` lifecycle)

`lore migrate apply/list/status/rollback` drive the **MigrationCoordinator**
(`migration/coordinator.ts`), which tracks every schema change in a
`migrations.sqlite` table under the local `.lore/` dir. No daemon is required — the
CLI opens an ephemeral coordinator.

### Capability & substrate support (read this honestly)

- **SQLite substrate is the only one wired through the standalone CLI today.**
  `apply` for a `sqlite` spec requires `--db-path <sqlite-file>`. Specs targeting
  the legacy graph-engine substrate or `lance` exit with a "requires daemon-side
  wiring; not yet exposed via the standalone CLI" notice — that integration is
  a later step (H1.next). **The legacy graph-engine substrate has no adapter
  registered at all** — its migration adapter module was deleted as part of
  the removal work for that engine (see `docs/KUZU_REMOVAL.md`), so a spec
  targeting it now hits the same "not wired" path as `lance` purely
  because nothing claims it, not because daemon wiring is pending. The Lance
  adapter logic (`migration/adapters/lanceMigrationAdapter.ts`) does exist and
  is exercised by the in-process test suite, but it is not reachable from
  `lore migrate apply` on the command line either. Note this `SubstrateName`
  type still carries that legacy substrate value alongside `sqlite`/`lance`
  (unused since the engine's removal) and has **no `surreal` option** — a
  SurrealDB-backed workspace has no online-schema-migration path through
  `lore migrate apply` today. (This coordinator is a distinct, older
  subsystem from the one that migrates `LoreSchemaV2` node/edge type
  definitions across a boot workspace's actual graph engine — see
  `schemas/migration/schemaGraphOpsBackend.ts`, which is already
  engine-agnostic.)
- The coordinator preflights the adapter's declared capabilities and throws
  **before any side effect** if the substrate can't perform the op (e.g. additive
  not supported → schema-rebuild required).

### Spec format

`apply` takes a JSON spec file. Additive example:

```json
{
  "id": "20260524-add-priority-column",
  "kind": "add_column",
  "substrate": "sqlite",
  "target": "load_jobs",
  "workspace": "default",
  "params": { "column": "priority INTEGER DEFAULT 0" }
}
```

```bash
lore migrate apply spec.json --db-path /path/to/tables.sqlite
lore migrate list --substrate sqlite --status applied
lore migrate status 20260524-add-priority-column
```

Every migration carries a `workspace` (a hard invariant — applying without one
errors). The lifecycle is recorded as `pending → running → applied | failed`, and
`migration.started` / `migration.applied` / `migration.failed` events are emitted
to the outbox so dashboards and the replicator see each transition.

### Migration kinds

| Kind | Phase | Reversible? |
| --- | --- | --- |
| `add_column`, `add_table`, `add_index` | additive (one shot) | **Yes** — `rollback <id>` calls the adapter's reverse verb |
| `rename_column`, `change_type`, `drop_column` | destructive parent: `expand → migrate → contract → complete` | **Partially** — see below |

Additive migrations apply in a single step and reverse cleanly via
`lore migrate rollback <id>` (the coordinator only allows rollback from `applied`
status).

### Destructive migrations: expand / migrate / contract

Destructive changes use a multi-phase, dual-write lifecycle so writers never see a
broken schema:

1. **expand** — `apply` lands the new column/shape alongside the old.
2. **migrate** — opens a dual-write window and backfills data into the new shape.
3. **contract** — closes dual-write and drops the old shape.

Progress through phases with `advance` (and `--auto` on `apply` chains the whole
sequence without prompting). The CLI dispatches `rollback` for these kinds to the
**phase-aware** rollback.

#### Rollback safety for destructive migrations

| Roll back from phase | Result |
| --- | --- |
| `migrate` → `expand` | Closes the dual-write window; **new column retained**, data recoverable, you can re-advance |
| `expand` → `rolled_back` | Drops the new column added in expand |
| `contract` / `complete` | **NOT reversible** — once the old shape is dropped the data is gone |

This is the critical safety rule: **the contract phase is terminal.** Once you have
dropped the old column/table, `rollback` refuses and the migration row is marked
`failed` with `rollback-not-supported-from-contract`. The only way to get that data
back is to **restore from a backup** (see [`BACKUP_RESTORE.md`](./BACKUP_RESTORE.md)).

So the safe upgrade discipline for a destructive migration is:

```bash
lore backup --all --out /srv/lore-backups        # zero-RPO rollback for this change
lore migrate apply destructive-spec.json --db-path .../tables.sqlite
# verify at each phase via `lore migrate status <id>` before advancing to contract
```

Do not `advance` into `contract` until you have verified the migrated data and
confirmed you no longer need the old shape — that step burns your in-band rollback.

---

## Rolling back 3.35.0 → 3.34.0 (tested)

Tested 2026-10-16 for the 3.35.1 patch, using the published 3.34.0 and 3.35.0
tarballs against two targets: a local home on the default engines (SQLite
unified graph + `.lore/outbox.sqlite`), and an arcade-mode daemon on a real
ArcadeDB 26.7.1 cell. Daemons ran with `LORE_MODEL_SERVER=0`, one at a time
(each version stopped before the next started). In both cases 3.35.0 had
already opened the store and written to it, and outbox rows in the new 3.35
states were planted (`pending_commit` for a write whose graph commit landed,
`pending_commit` for one that never committed, a dead-lettered row with
`deadReason`, and — Arcade only — a transient-failure row with
`firstTransientAt` / `transientRetries`). Only 3.35.0 was tested; 3.35.1 adds
no storage-format change (no schema, DDL, migration or outbox-column change).

**Verdict: the rollback is safe for data, as tested.** 3.34.0 starts on a store
3.35.0 has touched, reads every node at the right revision, writes new ones,
and a later return to 3.35 picks up cleanly. Nothing was lost, and nothing that
3.35 retracted or dead-lettered came back. Limits of that verdict:

- The stale-replay case (a `pending_commit` row replayed over a newer 3.34
  write) was tested on SQLite only, not on ArcadeDB.
- Every run was sequential, one daemon at a time. 3.34 and 3.35 running
  together against one home or one cell was not tested. 3.34 writes do not
  bump `txTouch`, the per-node counter 3.35 batch commits use to make a rival
  commit on the same node conflict.
- **Do not run mixed versions against one store.** Stop every 3.35 daemon
  before starting 3.34 on the same home or cell, and the reverse.

What you give up while on 3.34 is listed below.

| Sequence | SQLite home | ArcadeDB cell |
|---|---|---|
| 3.34.0 writes → 3.35.0 opens, reads, writes (incl. `ifRevision` and `preconditions`) | OK; the 3 outbox columns are added in place | OK; `txTouch` is added to `LoreNode` on first open |
| Roll back: 3.34.0 opens the 3.35-touched store | Starts; every node reads at the right revision; new writes 201; `ifRevision` 200; recall OK | Same, on the v6 cell; bulk `preconditions` 200; no schema errors in the log |
| Roll forward: 3.35.0 again | `pending_commit` settled at boot (committed row → ready); the uncommitted row was retracted on a later sweep, once past the grace; dead row listed in `/api/outbox/dead` | Same, except the uncommitted row was retracted at boot (it was already past the grace by then); `/api/stats` `deadLettered: 1 {permanent: 1}` |
| Stale `pending_commit` replayed after 3.34 wrote a newer revision of the same node | Newer revision kept; the replay did not overwrite it | not tested |

**What 3.34.0 does not do with 3.35 state:**

- **`pending_commit` outbox rows are left alone.** 3.34 neither replicates nor
  deletes them. The next 3.35 start settles them: a row whose graph commit is
  present flips to ready and replicates; a row that never committed is
  retracted once older than `LORE_PENDING_COMMIT_GRACE_MS` (60 s from creation).
  The node behind an uncommitted row stays absent (404) on 3.34 throughout.
  Caveat: the test planted a copy of a row whose real row had already
  replicated, so "recall OK on 3.34" does not prove a genuinely stranded row is
  searchable. A write that 3.35 left `pending_commit` (a crash or timeout
  between the graph commit and the outbox flip) reads by id on 3.34, but its
  vector / verbatim fan-out may be missing — the node is not searchable —
  until 3.35 returns and settles the row.
- **Dead-lettered rows are invisible.** They stay in the outbox with their
  `deadReason`, but 3.34 has no `GET /api/outbox/dead` and no `deadLettered` /
  `deadByReason` in `/api/stats`. They reappear on 3.35.
- **Transient failures use the old policy.** A row 3.35 was retrying as a
  transient failure is retried by 3.34 as an ordinary failed row (it drained
  and replicated in the test). Its `firstTransientAt` / `transientRetries`
  values are left as they were.
- **Single-write `preconditions` is refused.** `POST /api/node` with
  `preconditions` returns `400 unknown_field` on 3.34. `ifRevision` and bulk
  `preconditions` still work. A client that depends on single-write
  preconditions must not be rolled back.
- **The three new `outbox_entries` columns stay** (`firstTransientAt`,
  `transientRetries`, `deadReason`). 3.34 inserts work; the columns take their
  defaults. Do not drop them by hand: 3.35 would re-add them at open
  (`ensureTransientColumns`), but the dead-letter reasons and transient-retry
  history they hold would be gone.

**ArcadeDB schema stamp (v6 vs v5).** 3.35 adds the v6 `txTouch` property
lazily when it opens a cell, but does not restamp
`tenant_apps.schema_version` in `arcade-provisioning.sqlite`; only
re-provisioning (`POST /api/arcade/apps`, idempotent) stamps 6. 3.34 has no
"schema too new" check: it reads and writes a v6 cell normally, ignores
`txTouch`, and its writes leave `txTouch` null (3.35 treats null as 0 and
preconditions on those nodes work after roll-forward). Re-provisioning under
3.34 restamps the app to 5 while `txTouch` stays on the type; 3.35 then works
on it unchanged. Today neither version checks the stamp when it opens a cell.
If a stale-cell gate on the stamp is ever built (an older `arcadeSchema`
comment described one), a 3.34 re-provision that restamped a cell to 5 would
trip it. Evidence note: the `txTouch` null → 1 change and the 5 → 6 → 5 stamp
sequence were observed during the run but not saved as probe files; only the
final stamp of 5 is in the saved evidence.

**Getting back to an exact 3.34 state.** The steps above leave 3.35's
additions in place (harmless to 3.34). If you need the store exactly as it was
before the upgrade, restore the backup taken before upgrading. **These restore
steps were not exercised in this test.**

1. Stop the daemon and reinstall 3.34.0.
2. Local home: `lore restore` each workspace from the pre-upgrade
   `lore backup --all` set (see [`BACKUP_RESTORE.md`](./BACKUP_RESTORE.md)).
   Any write made after that backup is lost.
3. Arcade cell: restore into an empty cell, never over the live one.
   `POST /api/arcade/apps/:tenant/:app/restore` refuses a non-empty cell
   (`409 restore_target_not_empty`), and with `{force: true}` it is an
   id-keyed upsert: nodes written after the backup survive, so the result is
   not the backup's state. Under 3.34, either disable the cell
   (`POST .../disable`), destroy it (`DELETE /api/arcade/apps/:tenant/:app`
   with `{confirm: "<tenant>/<app>"}`) and restore the pre-upgrade bundle into
   the now-empty cell, or restore into a new app id and move clients to it.
   Only restore the daemon's `outbox.sqlite` / `arcade-provisioning.sqlite`
   from the same point if you must: an old `arcade-provisioning.sqlite` brings
   back tokens and service credentials that were rotated or revoked since, so
   rotate them again afterwards.
4. Start 3.34.0 and confirm with `lore doctor` and `/api/health`.

---

## Upgrade checklist

1. **Back up every workspace** — `lore backup --all`. This is the rollback path.
2. Stop the daemon (releases SurrealDB's single-writer handle on the
   workspace; also avoids a mid-write backup).
3. Install the new version.
4. Run any required one-off `lore migrate <target>` step **dry-run first**, then
   `--apply`. For schema-spec migrations, never `advance` past a reversible phase
   until the data is verified.
5. Restart the daemon; confirm with `lore doctor` and `/api/health` (`version`,
   per-workspace counts).
6. If anything is wrong, roll back: reinstall the prior version and restore from
   the step-1 backup.
