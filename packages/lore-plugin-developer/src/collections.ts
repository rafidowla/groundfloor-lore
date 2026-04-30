/**
 * developer/collections.ts — Q2.2 slice 5c.
 *
 * Single source of truth for developer-plugin collection registration.
 * Plugin code uses the canonical PascalCase names (`CodeSymbol`,
 * `FileContains`, …) in every storage call; the adapter resolves
 * substrate-specific names + edge metadata via the registrations below.
 *
 * Slice history:
 *   - 5b: this file held a {kuzu, cloud} substrate-name lookup table +
 *     per-edge EdgeShapeHint constants the plugin had to thread through
 *     every call site.
 *   - 5c: replaced by the declarative `developerCollectionDecls` array.
 *     Plugin call sites no longer pass hints, no longer call collName(),
 *     and no longer branch on storage.mode. The mapping lives once,
 *     here, and is applied at boot via `contributeCollectionDecls`.
 */

import type { CollectionDecl } from '@lore-core/plugins/storage.js';

/* ─── Canonical names (the strings plugin code passes to storage) ─ */

export const CODE_SYMBOL_COLL = 'CodeSymbol';
export const CODE_FILE_COLL = 'CodeFile';
export const DEV_ACTIVITY_COLL = 'DevActivity';
export const CODE_RELATION_COLL = 'CodeRelation';
export const FILE_CONTAINS_COLL = 'FileContains';
export const LORE_APPLIES_TO_CODE_COLL = 'LoreAppliesToCode';
export const LORE_TOUCHES_FILE_COLL = 'LoreTouchesFile';

/* ─── Phase 9 — Data layer (SQL / AQL) ─────────────────────────── */
//
// Code↔data graph schema, additive only. Walkers + extractors live in
// packages/lore-plugin-developer/src/data-layer/. These names will be
// referenced by ops + walker code once Phase 9 implementation lands;
// for now they're declared up-front so the schema can be created
// idempotently without further migrations.

export const SQL_TABLE_COLL = 'SqlTable';
export const SQL_COLUMN_COLL = 'SqlColumn';
export const QUERY_COLL = 'Query';
export const AQL_QUERY_COLL = 'AqlQuery';
export const EXECUTES_COLL = 'Executes';        // CodeSymbol → Query
export const READS_COL_COLL = 'ReadsCol';       // Query → SqlColumn
export const WRITES_COL_COLL = 'WritesCol';     // Query → SqlColumn
export const REFS_TABLE_COLL = 'RefsTable';     // Query → SqlTable
export const HAS_COLUMN_COLL = 'HasColumn';     // SqlTable → SqlColumn
/**
 * Cross-pillar reads on the core lore_node collection. The developer
 * plugin reads it from a few legacy surfaces (resolveChatContext etc.).
 * Q2.3 will tighten this into a core-side hook; meanwhile we declare it
 * here so the canonical name (`LoreNode`, matching the Kùzu table) maps
 * to the cloud `lore_node` collection.
 */
export const LORE_NODE_COLL = 'LoreNode';

/* ─── Declarations applied at boot via contributeCollectionDecls ── */

export const developerCollectionDecls: CollectionDecl[] = [
    /* ─── Node collections ──────────────────────────────────────── */
    {
        kind: 'node',
        name: CODE_SYMBOL_COLL,
        primaryKey: 'uid',
        cloudCollection: 'developer_code_symbol',
    },
    {
        kind: 'node',
        name: CODE_FILE_COLL,
        primaryKey: 'path',
        cloudCollection: 'developer_code_file',
    },
    {
        kind: 'node',
        name: DEV_ACTIVITY_COLL,
        primaryKey: 'id',
        cloudCollection: 'developer_dev_activity',
    },
    {
        kind: 'node',
        name: LORE_NODE_COLL,
        primaryKey: 'id',
        cloudCollection: 'lore_node',
    },

    /* ─── Edge collections ──────────────────────────────────────── */
    {
        kind: 'edge',
        name: CODE_RELATION_COLL,
        source: CODE_SYMBOL_COLL,
        target: CODE_SYMBOL_COLL,
        cloudCollection: 'developer_code_relation',
    },
    {
        kind: 'edge',
        name: FILE_CONTAINS_COLL,
        source: CODE_FILE_COLL,
        target: CODE_SYMBOL_COLL,
        cloudCollection: 'developer_file_contains',
    },
    {
        kind: 'edge',
        name: LORE_APPLIES_TO_CODE_COLL,
        source: LORE_NODE_COLL,
        target: CODE_SYMBOL_COLL,
        cloudCollection: 'developer_lore_applies_to_code',
    },
    {
        kind: 'edge',
        name: LORE_TOUCHES_FILE_COLL,
        source: LORE_NODE_COLL,
        target: CODE_FILE_COLL,
        cloudCollection: 'developer_lore_touches_file',
    },

    /* ─── Phase 9 — Data layer (SQL / AQL) ─────────────────────── */
    {
        kind: 'node',
        name: SQL_TABLE_COLL,
        primaryKey: 'uid',
        cloudCollection: 'developer_sql_table',
    },
    {
        kind: 'node',
        name: SQL_COLUMN_COLL,
        primaryKey: 'uid',
        cloudCollection: 'developer_sql_column',
    },
    {
        kind: 'node',
        name: QUERY_COLL,
        primaryKey: 'uid',
        cloudCollection: 'developer_query',
    },
    {
        kind: 'node',
        name: AQL_QUERY_COLL,
        primaryKey: 'uid',
        cloudCollection: 'developer_aql_query',
    },
    {
        kind: 'edge',
        name: EXECUTES_COLL,
        source: CODE_SYMBOL_COLL,
        target: QUERY_COLL,
        cloudCollection: 'developer_executes',
    },
    {
        kind: 'edge',
        name: READS_COL_COLL,
        source: QUERY_COLL,
        target: SQL_COLUMN_COLL,
        cloudCollection: 'developer_reads_col',
    },
    {
        kind: 'edge',
        name: WRITES_COL_COLL,
        source: QUERY_COLL,
        target: SQL_COLUMN_COLL,
        cloudCollection: 'developer_writes_col',
    },
    {
        kind: 'edge',
        name: REFS_TABLE_COLL,
        source: QUERY_COLL,
        target: SQL_TABLE_COLL,
        cloudCollection: 'developer_refs_table',
    },
    {
        kind: 'edge',
        name: HAS_COLUMN_COLL,
        source: SQL_TABLE_COLL,
        target: SQL_COLUMN_COLL,
        cloudCollection: 'developer_has_column',
    },
];
