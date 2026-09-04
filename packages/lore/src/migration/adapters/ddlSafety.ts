/**
 * ddlSafety.ts — anti-injection guards for online-migration DDL.
 *
 * Migration specs are operator-authored (`lore migrate apply <spec.json>`) and
 * the adapter splices `spec.table` / `spec.column(s)` / `spec.columnDdl` into
 * native SQLite DDL. `quoteIdent` covers bare identifiers, but the
 * column-DDL fragments ("name TYPE [constraints]") were spliced RAW. (The
 * former local graph engine's now-removed Cypher-DDL adapter shared this
 * same guard, with the same raw-table-name exposure.)
 *
 * This is a local-CLI defense-in-depth boundary (the migration coordinator is
 * not exposed on any HTTP/MCP route; the spec author is the operator acting on
 * their own DB). The guard blocks the statement-terminator and comment
 * sequences that turn one `ADD COLUMN` into multi-statement injection —
 * better-sqlite3's `exec()` runs what it is handed.
 * audit 2026-06-25 (MEDIUM, DDL injection).
 */

/** Statement terminators + comment sequences that enable multi-statement injection. */
const FORBIDDEN_DDL = /[;`\x00]|--|\/\*|\*\//;

/**
 * Validate a column-DDL fragment ("name TYPE [constraints]", or a comma-
 * separated list of them). Rejects statement terminators + comment sequences.
 * Returns the fragment unchanged on success.
 */
export function assertSafeDdlFragment(fragment: unknown, context: string): string {
    if (typeof fragment !== 'string' || fragment.trim().length === 0) {
        throw new Error(`${context}: empty or non-string DDL fragment`);
    }
    if (FORBIDDEN_DDL.test(fragment)) {
        throw new Error(
            `${context}: DDL fragment contains a forbidden sequence ` +
            `(';', '--', '/*', '*/', backtick, or NUL) — refusing: ${fragment.slice(0, 80)}`,
        );
    }
    return fragment;
}

/**
 * Validate a bare SQL/Cypher identifier (table or column name). Same rule as
 * the engine-layer `assertIdent`, duplicated here so the migration adapters
 * don't reach across into engines/.
 */
export function assertSafeIdent(name: unknown, context: string): string {
    if (typeof name !== 'string' || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
        throw new Error(`${context}: invalid identifier '${String(name).slice(0, 40)}'`);
    }
    return name;
}
