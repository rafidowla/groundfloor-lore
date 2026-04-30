# Data Layer (Phase 9 — code↔data bridge)

> **Status:** Schema scaffold landed (collections.ts + schema.ts). Walkers
> + extractors + MCP tools are TODO. Implementation plan in
> `docs/PLAN_replace_gitnexus_in_developer_plugin.md` §3 Phase 9.

## What this directory will hold

| File | Status | Purpose |
|---|---|---|
| `walkers/sql.ts` | TODO | Walks `.sql` files via `tree-sitter-sql`. Emits `SqlTable` + `SqlColumn` from `CREATE TABLE` / `CREATE VIEW`; emits `Query` from DML statements. |
| `walkers/embedded-sql.ts` | TODO | Finds SQL strings inside other source files. Two paths: (a) string-pattern detection for template literals / concats matching `/^\s*(SELECT\|INSERT\|UPDATE\|DELETE\|CREATE\|ALTER\|DROP)/i`; (b) ORM call patterns (Prisma, TypeORM, SQLAlchemy, Hibernate, Sequelize). |
| `walkers/aql.ts` | TODO | ArangoDB AQL walker. Vendor `tree-sitter-aql`. Same shape as SQL walker. |
| `extractors/orm/prisma.ts` etc. | TODO | Per-ORM call-pattern recognisers. |
| `index.ts` | TODO | Re-exports walkers + extractors. |
| `tools.ts` | TODO | 5 MCP tools: `code_table_dependencies`, `code_query_blast_radius`, `code_unused_columns`, `code_migration_impact`, `code_orm_summary`. |

## Schema (already declared in `schema.ts` + `collections.ts`)

| Node table | Fields |
|---|---|
| `SqlTable` | `uid`, `name`, `schemaName`, `file`, `kind` ('table' / 'view' / 'index'), `repo` |
| `SqlColumn` | `uid`, `name`, `tableUid`, `type`, `nullable` |
| `Query` | `uid`, `file`, `startByte`, `endByte`, `kind` ('select' / 'insert' / 'update' / 'delete'), `sqlDialect`, `rawText`, `repo` |
| `AqlQuery` | (same shape, dialect = 'aql') |

| Edge | From → To | Meaning |
|---|---|---|
| `Executes` | CodeSymbol → Query | function runs this query |
| `ReadsCol` | Query → SqlColumn | SELECT / WHERE / JOIN / GROUP BY references |
| `WritesCol` | Query → SqlColumn | INSERT / UPDATE / DELETE column targets |
| `RefsTable` | Query → SqlTable | mentioned in any clause |
| `HasColumn` | SqlTable → SqlColumn | structural |

## v1 ORM coverage targets

Per the plan: Prisma, TypeORM, SQLAlchemy, Hibernate, Sequelize. Per-customer-demand additions later.

## Acceptance (Phase 9)

- `code_table_dependencies('users')` returns the right `CodeSymbol` set on a synthetic test repo.
- `code_migration_impact()` flags affected functions for a synthetic `ALTER TABLE` migration.
- ~2–3 weeks of focused work; NOT a Phase 7 blocker (Phase 7 is already shipped 2026-04-30).
