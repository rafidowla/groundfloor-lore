# Phase 9 Output — Atlas (data layer scaffold)

> **Status:** Schema + cloud-schema scaffold landed 2026-04-30. Walker
> + extractor + MCP-tool implementation is the 2–3-week body of work
> per the plan.

## What this phase exists for

The *interesting* graph for code↔data work is *function executes Query, Query reads/writes Table.column*. That bridges code ↔ data and is what makes Atlas distinctively differentiated vs. GitNexus and jcodemunch (neither does this). Customers asking "if I rename this table, what breaks?" or "this migration drops a column — what code reads it?" get real answers.

Per the plan in `docs/PLAN_replace_gitnexus_in_developer_plugin.md` §3 Phase 9.

## What landed in this scaffold pass

### Schema (additive, idempotent CREATE … IF NOT EXISTS)

`packages/lore-plugin-developer/src/schema.ts` — 4 new node tables + 5 new edge tables:

| Node | Fields |
|---|---|
| `SqlTable` | `uid`, `name`, `schemaName`, `file`, `kind`, `repo` |
| `SqlColumn` | `uid`, `name`, `tableUid`, `type`, `nullable` |
| `Query` | `uid`, `file`, `startByte`, `endByte`, `kind`, `sqlDialect`, `rawText`, `repo` |
| `AqlQuery` | `uid`, `file`, `startByte`, `endByte`, `kind`, `rawText`, `repo` |

| Edge | From → To | Extra fields |
|---|---|---|
| `Executes` | CodeSymbol → Query | `confidence`, `reason` |
| `ReadsCol` | Query → SqlColumn | `clause` |
| `WritesCol` | Query → SqlColumn | `clause` |
| `RefsTable` | Query → SqlTable | — |
| `HasColumn` | SqlTable → SqlColumn | — |

### Collection registry parity

`packages/lore-plugin-developer/src/collections.ts` — 9 new `CollectionDecl` entries declaring substrate-portable canonical names (`SqlTable`, `Executes`, etc.) + cloud-collection mappings (`developer_sql_table`, `developer_executes`, etc.).

### Cloud schema parity

`packages/lore-plugin-developer/src/cloudSchema.ts` — 9 new `ensureCollection` calls. All include the standard `org_id` ReBAC partition key. Edge collections carry the standard `id` / `source_id` / `target_id` shape so they work on non-graph connectors.

`DEVELOPER_CLOUD_COLLECTIONS` list extended from 7 → 16 names so the orphan-detection path knows about the new ones.

### Implementation TODO

`packages/lore-plugin-developer/src/data-layer/README.md` — the implementation roadmap with file plan + per-walker design.

| File | Status | Purpose |
|---|---|---|
| `walkers/sql.ts` | TODO | Walks `.sql` files via `tree-sitter-sql`. Emits SqlTable/SqlColumn from DDL; Query from DML. |
| `walkers/embedded-sql.ts` | TODO | SQL strings inside other source. (a) string-pattern detection; (b) ORM call patterns. |
| `walkers/aql.ts` | TODO | AQL via `tree-sitter-aql` (community grammar). |
| `extractors/orm/*.ts` | TODO | Per-ORM call-pattern recognisers. v1 targets: Prisma, TypeORM, SQLAlchemy, Hibernate, Sequelize. |
| `tools.ts` | TODO | 5 new MCP tools (see below). |

### MCP tools to implement

- `code_table_dependencies(tableName)` → all CodeSymbols that touch this table
- `code_query_blast_radius(symbolName)` → all tables/columns the function transitively touches
- `code_unused_columns(tableName)` → columns no Query references
- `code_migration_impact(migrationFile)` → CodeSymbols affected by a migration's table/column changes
- `code_orm_summary(orm?)` → which ORM is each query tied to; useful for ORM-migration projects

## Acceptance for Phase 9 (when it ships)

- `code_table_dependencies('users')` returns the right `CodeSymbol` set on a synthetic test repo
- `code_migration_impact()` flags affected functions for a synthetic `ALTER TABLE` migration
- ORM detection covers the 5 v1 targets (Prisma, TypeORM, SQLAlchemy, Hibernate, Sequelize)
- `tsc --noEmit` clean, `npm run test:arch` clean
- Per-walker unit tests + integration test on a synthetic schema repo

## Why scaffold now

1. **Schema migration is additive.** Landing the CREATE TABLEs up-front means when walker code starts populating the new tables, no further migration is needed — the daemon picks up the schema on next restart.
2. **Cloud parity included.** When/if a tenant moves to cloud mode, the collections will already exist.
3. **Compile-safe placeholder.** `tsc --noEmit` clean and `npm run test:arch` clean with the scaffold in place.
4. **Phase 9 stays unblocked.** The 2–3-week body of work can be picked up by anyone (including future-Rafi or a contractor) without the "where do I put this?" overhead.

## What's NOT in scope for this scaffold

- Actual SQL parsing (needs `tree-sitter-sql` walker)
- Embedded SQL detection in TS/Python/Go/etc. files
- AQL parsing
- ORM call-pattern recognition
- The 5 MCP tools

Per the plan: ~2–3 weeks of focused work. Land it post-Phase-7 (which is shipped 2026-04-30).

## Hand-off

Phase 9 is now in "Phase-0-equivalent" state — schema + plan + scaffold ready. Implementation is unblocked. Nothing in this scaffold runs at runtime yet (the new tables stay empty until walker code lands), so daemon behaviour is unchanged.
