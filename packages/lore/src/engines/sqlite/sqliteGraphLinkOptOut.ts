/**
 * sqliteGraphLinkOptOut.ts - the durable per-node link opt-out (`autolink:false`) in `graph.sqlite`.
 *
 * One tiny table, keyed by plain node id and deliberately NOT a column on `nodes`:
 *   - the flag is often recorded BEFORE the node row exists (the write intent precedes the write), and a
 *     column cannot hold a value for a row that is not there yet;
 *   - node upserts / replaces (`INSERT OR REPLACE`, sync, re-embed, migrate) rewrite the row and could
 *     silently drop a column, whereas a separate table is untouched by any node write;
 *   - it lives in the workspace's own database file, so it travels with the workspace on backup / copy.
 *
 * Additive schema only (`CREATE TABLE IF NOT EXISTS`, no change to existing tables); an older Lore opening the
 * file simply ignores the table. `deleteNode` removes the row (see sqliteGraphWrites.ts).
 */
import type { SqliteDb } from './sqliteGraphSchema.js';
import { LoreGraphError } from '../loreGraphError.js';

export const LINK_OPTOUT_DDL = `
    CREATE TABLE IF NOT EXISTS link_optout (
        node_id TEXT PRIMARY KEY
    ) WITHOUT ROWID;
`;

/** Parameters per statement stay far below SQLite's 32766 limit. */
const CHUNK = 500;

export function getLinkOptOuts(db: SqliteDb, ids: readonly string[]): Set<string> {
    const out = new Set<string>();
    if (ids.length === 0) return out;
    try {
        for (let i = 0; i < ids.length; i += CHUNK) {
            const chunk = ids.slice(i, i + CHUNK);
            const rows = db.prepare(`SELECT node_id FROM link_optout WHERE node_id IN (${chunk.map(() => '?').join(',')})`).all(...chunk) as Array<{ node_id: string }>;
            for (const r of rows) out.add(r.node_id);
        }
        return out;
    } catch (error) {
        throw new LoreGraphError('Failed to read link opt-outs', 'getLinkOptOuts', error);
    }
}

/** `optOut=true` records the flag (idempotent); `false` clears it. One transaction. */
export function setLinkOptOuts(db: SqliteDb, ids: readonly string[], optOut: boolean): void {
    if (ids.length === 0) return;
    try {
        const stmt = db.prepare(optOut ? 'INSERT OR IGNORE INTO link_optout (node_id) VALUES (?)' : 'DELETE FROM link_optout WHERE node_id = ?');
        db.transaction(() => { for (const id of ids) stmt.run(id); })();
    } catch (error) {
        throw new LoreGraphError(`Failed to ${optOut ? 'set' : 'clear'} link opt-outs`, 'setLinkOptOuts', error);
    }
}
