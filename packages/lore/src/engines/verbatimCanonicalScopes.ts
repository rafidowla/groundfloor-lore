/**
 * verbatimCanonicalScopes.ts — read the stored `security_scopes` of existing
 * canonical rows. Split out of verbatimBatch.ts (file-size cap); no behaviour change.
 */

import type * as lancedb from '@lancedb/lancedb';
import { assertSafeLanceId, isRevisionHistoryId, toPlainStringList } from './verbatimHistory.js';
import { VERBATIM_CHUNK_SIZE } from './verbatimBatch.js';

/**
 * Scopes of the existing canonical rows for `ids` (id -> labels), for writes that
 * pass NO `security_scopes`: an overwrite then keeps the row's labels instead of
 * resetting them to public (which would also expose its `#rev` history). Throws
 * on a read failure so the write aborts — never silently falls back to public.
 */
export async function readCanonicalScopes(table: lancedb.Table, ids: ReadonlyArray<string>): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>();
    const targets = ids.filter((id) => !isRevisionHistoryId(id));
    targets.forEach((id) => assertSafeLanceId(id, 'readCanonicalScopes'));
    for (let ci = 0; ci < targets.length; ci += VERBATIM_CHUNK_SIZE) {
        const escChunk = targets.slice(ci, ci + VERBATIM_CHUNK_SIZE).map((id) => `'${id.replace(/'/g, "''")}'`).join(',');
        const rows = await table.query().where(`id IN (${escChunk})`).select(['id', 'security_scopes']).toArray();
        for (const r of rows as Array<Record<string, unknown>>) out.set(String(r.id), toPlainStringList(r.security_scopes));
    }
    return out;
}
