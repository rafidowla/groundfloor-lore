/**
 * developer/collections.ts — Q2.2 slice 5b. Substrate-name lookup +
 * EdgeShapeHints for the developer plugin's PluginStorage call sites.
 *
 * Why this file exists:
 *   - Kùzu uses PascalCase table names (`CodeSymbol`, `LoreAppliesToCode`)
 *     for legacy reasons; the cloud schema uses snake_case collection
 *     names with a `developer_` prefix (`developer_code_symbol`,
 *     `developer_lore_applies_to_code`).
 *   - Slice 5a's PluginStorage takes a single canonical name. Until
 *     slice 5c's `declareCollection` makes the substrate-name remap
 *     implicit, we keep the mapping local to the plugin and pick the
 *     right name per call via `ctx.storage.mode`.
 *   - EdgeShapeHints carry the source/target labels Cypher needs (Kùzu
 *     mode only — the cloud adapter ignores them). Several developer
 *     edges connect tables whose primary keys differ (FileContains,
 *     LoreTouchesFile, LoreAppliesToCode), so we use the asymmetric
 *     `srcIdField` / `tgtIdField` form added in slice 5b.
 *
 * Slice 5c removes both halves of this file:
 *   - the substrate-name lookup is replaced by a single canonical name
 *     handed to `declareCollection` at boot;
 *   - the EdgeShapeHints fold into the same call.
 */

import type { EdgeShapeHint, PluginStorage } from '@lore-core/plugins/storage.js';

/* ─── Node tables ─────────────────────────────────────────────── */

export const CODE_SYMBOL = {
    kuzu: 'CodeSymbol',
    cloud: 'developer_code_symbol',
} as const;

export const CODE_FILE = {
    kuzu: 'CodeFile',
    cloud: 'developer_code_file',
} as const;

export const DEV_ACTIVITY = {
    kuzu: 'DevActivity',
    cloud: 'developer_dev_activity',
} as const;

/* ─── Edge (REL) tables ───────────────────────────────────────── */

export const CODE_RELATION = {
    kuzu: 'CodeRelation',
    cloud: 'developer_code_relation',
} as const;

export const FILE_CONTAINS = {
    kuzu: 'FileContains',
    cloud: 'developer_file_contains',
} as const;

export const LORE_APPLIES_TO_CODE = {
    kuzu: 'LoreAppliesToCode',
    cloud: 'developer_lore_applies_to_code',
} as const;

export const LORE_TOUCHES_FILE = {
    kuzu: 'LoreTouchesFile',
    cloud: 'developer_lore_touches_file',
} as const;

/* ─── Core LoreNode (read-only from this plugin) ──────────────── */

/**
 * Cross-pillar edges connect to the core lore_node collection. Plugins
 * normally don't read other plugins' data, but the developer plugin
 * predates the boundary rule for a few specific surfaces (resolveChatContext,
 * getCodeSymbolContext.knowledge, etc.). Q2.3 will tighten this into a
 * core-side hook; for now the storage adapter accepts any collection
 * name, so we look up the core's substrate-correct name here.
 */
export const LORE_NODE = {
    kuzu: 'LoreNode',
    cloud: 'lore_node',
} as const;

/* ─── Lookup helper ───────────────────────────────────────────── */

export type CollectionRef = { kuzu: string; cloud: string };

export function collName(storage: PluginStorage, ref: CollectionRef): string {
    return storage.mode === 'dataplane' ? ref.cloud : ref.kuzu;
}

/* ─── EdgeShapeHints (Kùzu MATCH labels) ──────────────────────── */
/**
 * Each hint pins the Kùzu node-table labels for the edge's source and
 * target sides plus the per-side primary-key field. Cloud adapter
 * ignores them. We pin the Kùzu labels (not cloud names) since the hint
 * only matters in Kùzu mode.
 */

export const HINT_CODE_RELATION: EdgeShapeHint = {
    srcLabel: CODE_SYMBOL.kuzu,
    tgtLabel: CODE_SYMBOL.kuzu,
    idField: 'uid',
};

export const HINT_FILE_CONTAINS: EdgeShapeHint = {
    srcLabel: CODE_FILE.kuzu,
    tgtLabel: CODE_SYMBOL.kuzu,
    srcIdField: 'path',
    tgtIdField: 'uid',
};

export const HINT_LORE_TOUCHES_FILE: EdgeShapeHint = {
    srcLabel: LORE_NODE.kuzu,
    tgtLabel: CODE_FILE.kuzu,
    srcIdField: 'id',
    tgtIdField: 'path',
};

export const HINT_LORE_APPLIES_TO_CODE: EdgeShapeHint = {
    srcLabel: LORE_NODE.kuzu,
    tgtLabel: CODE_SYMBOL.kuzu,
    srcIdField: 'id',
    tgtIdField: 'uid',
};
