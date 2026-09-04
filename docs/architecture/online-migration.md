# Online schema migration — operator runbook

Sprint H ships online schema migration for Lore's SQLite + LanceDB substrates. Every migration verb is online by construction — no daemon-down window is required. The graph substrate — SurrealDB, the only graph engine since the prior local graph engine was fully removed 2026-08-21 (see `docs/KUZU_REMOVAL.md`) — is NOT wired into this coordinator: SurrealDB's node/edge tables are schemaless by design, so there is no ALTER-TABLE ladder to run against them (the migration adapter that used to cover graph DDL for that engine no longer exists either). This runbook covers what an operator runs, in which order, and what each of the two wired substrates does under the hood.

## TL;DR — supported operations

| Operation | Substrate | Online? | Pattern |
|---|---|---|---|
| add column | sqlite, lance | yes | additive (single phase) |
| add table | sqlite, lance | yes | additive (single phase) |
| add index | sqlite, lance | yes | additive (single phase) |
| **rename column** | sqlite, lance | yes | **expand / migrate / contract** |
| **change column type** | sqlite, lance | yes | **expand / migrate / contract** |
| **drop column** | sqlite, lance | yes | **expand / migrate / contract** |

## The expand / migrate / contract pattern

Destructive changes are decomposed into three independently reversible phases (audit Section 4):

1. **EXPAND (Phase 1)** — additive only. Add the new column / new type alongside the old. Substrate stays online; readers + writers unaffected. Phase 1 is fully reversible (drop the column we just added).

2. **MIGRATE (Phase 2)** — backfill data from old shape → new shape, in batches (SQLite default 500 rows/batch; lance Arrow projection). The coordinator opens a **dual-write window** during Phase 2: any concurrent writer that hits the table mirrors writes to BOTH old and new shape, so no row is lost. Phase 2 is reversible (close dual-write, leave new column populated for re-advance).

3. **CONTRACT (Phase 3)** — remove the old shape. Once Phase 3 runs, the old column is gone — this phase is **NOT reversible**. Restore from snapshot (Sprint Z3 backup pattern) if you need the data back.

### Phase transitions

```
                       advance()                  advance()                advance()
[apply] --> expand --------------> migrate ---------------> contract -------------> complete
                       rollback()                rollback()                  X (terminal)
                       (drops new col)           (closes dual-write,
                                                  keeps new col)
```

## Operator CLI

### 1. Author a spec file

```json
{
  "id": "20260524-rename-priority",
  "kind": "rename_column",
  "substrate": "sqlite",
  "target": "load_jobs",
  "workspace": "default",
  "params": {
    "fromColumn": "priority",
    "toColumn": "priority_v2",
    "columnDdl": "priority_v2 INTEGER DEFAULT 0"
  }
}
```

`kind` is one of:
- `rename_column` — params: `fromColumn`, `toColumn`, `columnDdl`
- `change_type` — params: `fromColumn`, `toColumn`, `columnDdl` (DDL carries the new type)
- `drop_column` — params: `column`

### 2. Apply Phase 1 (EXPAND)

```sh
lore migrate apply ./20260524-rename-priority.json --db-path ./load_jobs.sqlite
```

The new column lands. Status: `applied`, phase: `expand`.

### 3. Advance to Phase 2 (MIGRATE)

```sh
lore migrate advance 20260524-rename-priority --db-path ./load_jobs.sqlite
```

Coordinator opens the dual-write window FIRST, then runs the batched UPDATE. When the backfill finishes the row is back at status `applied`, phase `migrate`. Any writes that hit the table during this window get mirrored to the new column too — see "Dual-write" below.

### 4. Advance to Phase 3 (CONTRACT)

```sh
lore migrate advance 20260524-rename-priority --db-path ./load_jobs.sqlite
```

Coordinator closes the dual-write window, then drops the old column. Status: `applied`, phase: `contract`. **At this point the old column is gone — no rollback.**

### 5. Advance to `complete` (optional marker)

```sh
lore migrate advance 20260524-rename-priority --db-path ./load_jobs.sqlite
```

Coordinator-only state transition; no substrate side effect. Marks the migration as fully wound down.

### --auto mode (one-shot)

For low-risk environments or test fixtures:

```sh
lore migrate apply ./spec.json --db-path ./db.sqlite --auto
```

`--auto` runs Phase 1, then loops `advance` through migrate → contract → complete without operator prompts. **Use with care** — Phase 3 is irreversible.

### Rollback

```sh
lore migrate rollback 20260524-rename-priority --db-path ./load_jobs.sqlite
```

For destructive parent kinds (`rename_column` / `change_type` / `drop_column`) the rollback walks back one phase per invocation:
- From `migrate` → closes dual-write, returns to `expand`. New column retained; data preserved.
- From `expand` → drops the new column we added in Phase 1. Status flips to `rolled_back`.
- From `contract` or `complete` → **refused**. Restore from snapshot.

For additive kinds, rollback uses the H1 single-shot reverse (DROP COLUMN / DROP TABLE / DROP INDEX).

## Dual-write window

When Phase 2 opens, `MigrationCoordinator.dualWriteActiveFor(table, fromColumn)` starts returning a `DualWriteState`. The Sprint Z bulk loader dispatcher consults this on every row: if a metadata key on the row matches `fromColumn` for the row's substrate target, the dispatcher mirrors the value to `toColumn` before writing. Idempotent — already-mirrored rows are untouched.

Hot write paths (REST routes, MCP tools) should consult the same surface when wiring up to the daemon-side MigrationCoordinator instance. The dispatcher integration is the first wire; hot-path wires land alongside per-route work.

## Substrate-specific behavior

### SQLite

- **Phase 1** — `ALTER TABLE ADD COLUMN <ddl>`. Native, online, idempotent (probes `pragma table_info` first).
- **Phase 2** — batched `UPDATE ... SET to = from WHERE to IS NULL ... LIMIT 500`. Resumable: a follow-up call only updates rows where `to IS NULL`. Caps at 1M batches as a safety stop.
- **Phase 3** — `ALTER TABLE DROP COLUMN` on SQLite >= 3.35 (2021). Older builds get a table-rebuild fallback inside a `BEGIN/COMMIT` transaction.

### LanceDB

LanceDB stores Arrow tables backed by Parquet files. Add-field / drop-field semantics depend on the bound vectordb binding's capability:

- **Phase 1** — `addField(table, columnDdl)`. Often a Parquet rewrite under the hood; the shim hides cost.
- **Phase 2** — `copyColumn(table, fromColumn, toColumn)` via the shim. Typically an Arrow projection rewrite. If the bound shim lacks `copyColumn`, the adapter returns `lance-migrate-data-failed:copy-column-not-supported` with a hint to upgrade.
- **Phase 3** — `dropColumn(table, column)` via the shim, or `swapRename(staging, live)` for the table-rebuild fallback. **Size ceiling:** Arrow rebuild can OOM on very large tables — partition the table or chunk the rewrite externally for tables larger than ~10x available RAM.

## Cross-substrate change of type — ALTER COLUMN TYPE everywhere

Type changes are decomposed identically per substrate (audit Section 2 matrix shows no substrate exposes a native `ALTER COLUMN TYPE`). The operator authors a `change_type` spec per substrate, runs them in parallel, and advances each on its own cadence:

```sh
lore migrate apply ./type-change-sqlite.json --db-path ./load_jobs.sqlite --auto
lore migrate apply ./type-change-lance.json # daemon-side wiring
```

The cross-substrate atomicity story (single transaction across both substrates) lands in H3 — H2 ships the per-substrate primitive.

## Outbox emissions

Every phase transition emits an outbox entry via `migration.started` (start of phase) and `migration.applied` (end of phase) — or `migration.failed` on error. Payload includes `migrationId`, `migrationKind`, `substrate`, `target`, `workspaceScope`, and the `transition` (`expand->migrate`, etc.) for downstream consumers.

## Status surface

```sh
lore migrate list                              # all migrations
lore migrate status <id>                       # full JSON row
lore migrate list --status running             # currently running
lore migrate list --workspace default          # workspace scope
```

The migration row carries `phase` + `status` (status one of `pending|running|applied|failed|rolled_back`). For destructive parent kinds the `phase` is the source of truth for "how far through the 3-phase ceremony are we."

## Common workflows

### Rename a column (the primary use case)

```sh
# write spec, then:
lore migrate apply spec.json --db-path ./db.sqlite           # phase=expand
# read traffic now sees both columns; new column is empty
lore migrate advance <id> --db-path ./db.sqlite              # phase=migrate (dual-write open + backfill)
# new column now matches old; any writes during this window hit both
lore migrate advance <id> --db-path ./db.sqlite              # phase=contract (dual-write closed + drop old)
# only new column remains
```

### Change column type via expand / migrate / contract

Identical to rename — the `change_type` kind is wired separately so the migrations table + outbox carry operator intent (rename vs type-change), but the runtime decomposition is the same expand → migrate → contract sequence.

### Drop column via expand / migrate / contract

```sh
# spec.kind = 'drop_column', params = { "column": "deprecated_field" }
lore migrate apply spec.json --db-path ./db.sqlite           # phase=expand (no-op marker)
lore migrate advance <id> --db-path ./db.sqlite              # phase=migrate (no-op; placeholder for symmetry)
lore migrate advance <id> --db-path ./db.sqlite              # phase=contract (DROP COLUMN runs)
```

## Failure modes + recovery

- **Phase 2 mid-batch crash (SQLite)** — restart the daemon, re-run `lore migrate advance <id>`. The batched UPDATE only touches rows where `toColumn IS NULL`, so progress resumes cleanly.
- **Dual-write window leaks if daemon crashes between advance() and the next state-change** — coordinator restart from `migrations.sqlite` re-establishes phase state; dual-write index is rebuilt from rows where `status='applied' AND phase='migrate'`. (Daemon-boot wiring lands in H4 closure.)
- **Capability missing on lance** — adapter returns structured `{ ok: false, reason: 'additive-not-supported', detail: { hint, substrate } }`; coordinator persists the reason; operator surfaces it via `lore migrate status <id>` and either upgrades the binding or runs the table-rebuild workaround manually.

## See also

- `docs/audits/sprint-H-online-migration-2026-05-24.md` — H0 audit, substrate capability matrix, 7 risks
- `docs/architecture/MIGRATION_RUNNER_DESIGN.md` — Phase 4 migration runner (Loom-side; complementary concern)
- `docs/architecture/SCHEMA_CHANGE_SAFETY_MEMO.md` — Agentic DBA safety memo (design intent)
