/**
 * verbatimStoreRole.ts — role-based LanceDB handle scoping for VerbatimStore
 * (LORE-ASK-VECTOR-STORE-ROLE.md).
 *
 * `verbatimStore.ts` is already at its file-size baseline cap (see
 * `.file-size-baseline.json`) — this sibling holds every role-specific
 * helper so the host file's line count doesn't grow. Every export here
 * takes plain values (role, booleans, sizes) rather than a `VerbatimStore`
 * instance, so there is no import cycle with verbatimStore.ts.
 *
 * Handle budget by role (default LORE_LANCE_POOL_SIZE=16):
 *   'both'  (default, unchanged) — connection + write table + pool = 18
 *   'write' — connection + write table, NO pool                    =  2
 *   'read'  — connection + pool, NO write table                    = 17
 */

/** Default role is 'both' — byte-identical to pre-this-feature behaviour. */
export type VerbatimStoreRole = 'read' | 'write' | 'both';

/**
 * Thrown by a mutating call (store/storeBatch/tombstone/physicalDelete/...)
 * against a role:'read' store — there is no write table to mutate.
 *
 * Deliberately a DISTINCT class from `VerbatimStoreError` (defined in
 * verbatimStore.ts) rather than importing it here: importing it would create
 * an import cycle (verbatimStore.ts already imports this module for the
 * role type/helpers). This error is just as "clear and named" as the ask
 * requires — `name` is `'VerbatimStoreRoleError'` and `operation` identifies
 * the rejected call — without the cycle.
 */
export class VerbatimStoreRoleError extends Error {
    public operation: string;
    constructor(operation: string) {
        super(
            `[VerbatimStore:${operation}] write operations are unavailable — this store was opened with role:'read' ` +
            `(no write table was opened). Reopen with role:'both' (default) or role:'write' to write.`,
        );
        this.name = 'VerbatimStoreRoleError';
        this.operation = operation;
    }
}

/** Guard called at the top of every public mutating method (outside any
 *  try/catch that would rewrap it, mirroring the existing assertSafeLanceId
 *  call sites in verbatimStore.ts), so the distinct error type/name survives
 *  to the caller instead of being folded into a generic VerbatimStoreError. */
export function assertWritableRole(role: VerbatimStoreRole, operation: string): void {
    if (role === 'read') throw new VerbatimStoreRoleError(operation);
}

/**
 * Whether `initialize()` should open the write table via `db.openTable()`.
 * False only for role:'read' — the ask's core handle-reduction: a read-role
 * store never holds `this.table`; the pool opens its own handles directly
 * against `this.db` instead (see `shouldBuildReadPool`).
 */
export function shouldOpenWriteTable(role: VerbatimStoreRole): boolean {
    return role !== 'read';
}

/**
 * Whether `ensureReadPool()` should attempt to build the pool, given the
 * role and whether a write table handle is currently held:
 *   - 'write' — never (explicitly no pool; this is the whole point of the ask).
 *   - 'read'  — always (the pool opens independently of `table` via `db`).
 *   - 'both'  — only once a table exists — byte-identical to the pre-existing
 *     "lazy on first search(), eager in initialize() once the table already
 *     exists" behaviour.
 */
export function shouldBuildReadPool(role: VerbatimStoreRole, hasTable: boolean): boolean {
    if (role === 'write') return false;
    if (role === 'read') return true;
    return hasTable;
}

/**
 * Whether `search()`/`searchByVector()` may proceed for a store whose
 * `this.table` is null: false for 'both'/'write' (unchanged — no table means
 * no data yet), true for 'read' once initialized (a read-role store never
 * holds `this.table`, so a table-based early-return would always short
 * circuit to `[]` and defeat the role's whole purpose).
 */
export function canSearchWithoutTable(role: VerbatimStoreRole): boolean {
    return role === 'read';
}

/** One-time (per-instance) info log when a role:'write' store's search falls
 *  back to the single write handle because it has no read pool by design —
 *  distinct from the pre-existing "pool not warmed yet" cases, which never
 *  log. `alreadyLogged` is the caller's own per-instance flag. */
export function shouldLogWriteRoleFallback(role: VerbatimStoreRole, poolBuilt: boolean, alreadyLogged: boolean): boolean {
    return role === 'write' && !poolBuilt && !alreadyLogged;
}

// No quoted words in this message — logger.ts's redactError() hashes ANY
// quoted token as if it were a node-id (S9 PII scrubbing), which would
// otherwise mangle `role:'write'` into an unreadable `role:id#<hash>`.
export const WRITE_ROLE_FALLBACK_LOG_MESSAGE =
    '[VerbatimStore] search: role=write store has no read pool by design — serving from the single write handle.';

/**
 * Test/observability hook (LORE-ASK-VECTOR-STORE-ROLE.md item 2) — total
 * live LanceDB handles a VerbatimStore instance holds: the Connection (1 if
 * open), the write Table (1 if open), plus every pool handle. Lets a test
 * assert the 18 -> 2 handle reduction for role:'write' at the default pool
 * size without reaching into private fields.
 */
export function countHandles(hasConnection: boolean, hasTable: boolean, poolSize: number): number {
    return (hasConnection ? 1 : 0) + (hasTable ? 1 : 0) + poolSize;
}
