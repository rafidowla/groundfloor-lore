/**
 * mcp/aliases.ts
 *
 * Atlas — Lore developer plugin's tree-sitter code intelligence layer.
 * Backward-compat gitnexus_* -> code_* aliases. Drop one release after Phase 8.
 *
 * Original work authored for groundfloor-lore. Patterns informed by
 * reading GitNexus and jcodemunch source for understanding only — no
 * code copied, no structural mirroring. See `docs/PLAN_replace_gitnexus_in_developer_plugin.md`
 * section 10 for the license-compliance protocol enforced by
 * `scripts/atlas-license-check.mjs`.
 *
 * Phase: 6 (MCP tool surface).
 *
 * Maps each gitnexus_* tool name (referenced by AI agents in CLAUDE.md
 * and existing transcripts) to its Atlas code_* replacement. The tool
 * registry honours both names during the deprecation window; aliases
 * delete in the release after Phase 8.
 */

export const GITNEXUS_TO_ATLAS_ALIASES: ReadonlyMap<string, string> = new Map([
    ['gitnexus_query', 'code_query'],
    ['gitnexus_context', 'code_context'],
    ['gitnexus_impact', 'code_impact'],
    ['gitnexus_detect_changes', 'code_detect_changes'],
    ['gitnexus_rename', 'code_rename'],
    ['gitnexus_cypher', 'code_cypher'],
]);

/**
 * Register every gitnexus_* alias as an additional name pointing at
 * the same handler as its code_* counterpart. The actual MCP server
 * adapter (Phase 6.1 follow-up) iterates this map alongside ATLAS_TOOLS
 * and emits both registrations.
 */
export function expandWithAliases<T>(handlers: Map<string, T>): Map<string, T> {
    const out = new Map(handlers);
    for (const [oldName, newName] of GITNEXUS_TO_ATLAS_ALIASES) {
        const handler = handlers.get(newName);
        if (handler) out.set(oldName, handler);
    }
    return out;
}
