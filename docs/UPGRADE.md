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
# 1. Stop the daemon (avoids a mid-write backup; also releases Kùzu's
#    single-writer handle for any workspace still on graphEngine: 'kuzu').

# 2. BACK UP every workspace first — this is your rollback path.
lore backup --all --out /srv/lore-backups

# 3. Upgrade the package (however you install it, e.g.):
npm i -g @groundfloor/lore@latest      # or your pinned version

# 4. Restart and verify.
lore serve --http &
lore doctor
curl -s http://localhost:3847/api/health | jq '.version, .workspaces.globalTotals'
```

If `lore doctor` is clean and `/api/health` reports the new `version` with sane
per-workspace counts, the upgrade is good. If not, roll back: stop the daemon,
reinstall the prior version, and (if data changed) restore from the backup taken in
step 2 per [`BACKUP_RESTORE.md`](./BACKUP_RESTORE.md).

> Most upgrades need **no** explicit `lore migrate` step. Schema migrations are an
> opt-in tool for specific, named transitions — covered below.

### Note on `LoreNode` indexing

There is **no one-time index-build step** on upgrade, on either graph engine:

- **Kùzu** (legacy, per-workspace `graphEngine: 'kuzu'` opt-in) exposes no
  secondary-index DDL at all in the `@kineviz/kuzu-lite` binding, so the
  `LoreNode` table is primary-keyed on `id` only.
- **SurrealDB** (default as of v3.13.0) has secondary B-tree indexes
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
| `v1-sqlite [<path>] [--apply] [--archive]` | One-off: migrate a legacy V1 `knowledge.db` SQLite file into the local graph (SurrealDB by default, or Kùzu on a legacy `graphEngine: 'kuzu'` workspace) |
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
  `kuzu` or `lance` exit with a "requires daemon-side wiring; not yet exposed via
  the standalone CLI" notice — that integration is a later step (H1.next).
  **`kuzu` has no adapter registered at all** — `kuzuMigrationAdapter.ts` was
  deleted as part of the Kuzu-removal work (see `docs/KUZU_REMOVAL.md`), so a
  `kuzu`-targeted spec now hits the same "not wired" path as `lance` purely
  because nothing claims it, not because daemon wiring is pending. The Lance
  adapter logic (`migration/adapters/lanceMigrationAdapter.ts`) does exist and
  is exercised by the in-process test suite, but it is not reachable from
  `lore migrate apply` on the command line either. Note this `SubstrateName`
  type (`sqlite | kuzu | lance`) has **no `surreal` option** — a
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

## Upgrade checklist

1. **Back up every workspace** — `lore backup --all`. This is the rollback path.
2. Stop the daemon (releases Kùzu's single-writer handle on workspaces still
   using `graphEngine: 'kuzu'`; also avoids a mid-write backup on SurrealDB).
3. Install the new version.
4. Run any required one-off `lore migrate <target>` step **dry-run first**, then
   `--apply`. For schema-spec migrations, never `advance` past a reversible phase
   until the data is verified.
5. Restart the daemon; confirm with `lore doctor` and `/api/health` (`version`,
   per-workspace counts).
6. If anything is wrong, roll back: reinstall the prior version and restore from
   the step-1 backup.
