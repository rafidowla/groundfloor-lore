/**
 * graphShared/lintMessages.ts — the operator-facing message text for
 * `lintGraph()`, shared so a rewording only ever happens once and every
 * engine's `lore lint` output reads identically.
 *
 * 3.21 step 1a extraction: only the ORPHAN CHECK's query predicate is
 * engine-specific (a graph-adjacency query on SurrealGraph, a `NOT EXISTS`
 * against the indexed `edges` table on SqliteGraph — see the design doc);
 * the message string itself carries over verbatim from the prior local
 * graph engine, because operators grep these strings.
 */

/** The message `lintGraph()` emits for one orphaned (edge-less) node. */
export function formatOrphanMessage(type: string, id: string): string {
    return `Orphan: ${type} node '${id}' has no relationships.`;
}
