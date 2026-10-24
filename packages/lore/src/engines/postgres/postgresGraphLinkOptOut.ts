/**
 * postgres/postgresGraphLinkOptOut.ts - the durable per-node link opt-out (`autolink:false`) in Postgres.
 *
 * Mirrors `sqlite/sqliteGraphLinkOptOut.ts`. One table, `link_optout (workspace_id, node_id)`, keyed by the
 * PLAIN node id rather than `nodes.sk`:
 *   - the intent is recorded BEFORE the node row exists, and `sk` is only assigned when the node row is inserted,
 *     so an sk-keyed flag could not be stored at that point;
 *   - a node upsert never touches this table, so it can neither clobber nor resurrect the flag;
 *   - it carries `workspace_id`, so the logical backup lane (postgresBackupDiscovery.ts) exports and restores it
 *     automatically, with no `sk` remap (there is no surrogate key in it to remap). Proven by
 *     test/link-optout-durable-pg.ts (backup -> restore keeps opt-outs).
 *
 * Additive DDL only (`CREATE TABLE IF NOT EXISTS`). `deleteNode` removes the row in its own transaction.
 */
import { pgError, type PgQueryable } from './postgresGraphRow.js';

export const LINK_OPTOUT_PG_DDL = `
    CREATE TABLE IF NOT EXISTS link_optout (
        workspace_id TEXT NOT NULL,
        node_id      TEXT NOT NULL,
        PRIMARY KEY (workspace_id, node_id)
    )`;

export async function getLinkOptOuts(db: PgQueryable, workspaceId: string, ids: readonly string[]): Promise<Set<string>> {
    const out = new Set<string>();
    if (ids.length === 0) return out;
    try {
        const res = await db.query(
            'SELECT node_id FROM link_optout WHERE workspace_id = $1 AND node_id = ANY($2::text[])',
            [workspaceId, [...new Set(ids)]],
        );
        for (const r of res.rows as Array<{ node_id: string }>) out.add(r.node_id);
        return out;
    } catch (error) {
        throw pgError('Failed to read link opt-outs', 'getLinkOptOuts', error);
    }
}

/** `optOut=true` records the flag (idempotent); `false` clears it. One statement, so atomic. */
export async function setLinkOptOuts(db: PgQueryable, workspaceId: string, ids: readonly string[], optOut: boolean): Promise<void> {
    if (ids.length === 0) return;
    const unique = [...new Set(ids)];
    try {
        if (optOut) {
            await db.query(
                'INSERT INTO link_optout (workspace_id, node_id) SELECT $1, unnest($2::text[]) ON CONFLICT DO NOTHING',
                [workspaceId, unique],
            );
        } else {
            await db.query('DELETE FROM link_optout WHERE workspace_id = $1 AND node_id = ANY($2::text[])', [workspaceId, unique]);
        }
    } catch (error) {
        throw pgError(`Failed to ${optOut ? 'set' : 'clear'} link opt-outs`, 'setLinkOptOuts', error);
    }
}
