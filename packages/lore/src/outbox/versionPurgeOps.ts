/**
 * versionPurgeOps.ts — hard delete of version-history rows for a purged node or an erased workspace
 * (SQLite mechanics, factored out of `versionStore.ts` to keep it under the file-size cap).
 *
 * `node_versions` rows keep the node's full `previous_state` / `new_state` JSON, so a node erased "for good"
 * (`nodeDelete({ purge: true })`) or a deleted workspace being erased must lose them too. Both operations are
 * exact (node id + workspace name; workspace name), run in one transaction, and are idempotent (a second call
 * deletes zero rows). `changeset_writes` payloads also carry node content (`nodeData` / `node_id`), so the
 * node-scoped purge removes those of the same workspace's changesets, and the workspace-scoped erase removes the
 * workspace's changesets with their writes. Plain deletes never call these: version history is kept there.
 *
 * TIME BOUND (`upTo`, optional): a purge only removes history that existed when the purge happened. A purge replayed
 * late from the outbox, or a workspace erase that runs after a same-named workspace was re-created, must NOT wipe
 * history written afterwards. Version rows carry ISO-8601 UTC timestamps with millisecond precision
 * (`new Date().toISOString()`), and changesets carry `created_at` in the same format, so they are compared as strings
 * after normalising the bound to the same format. The bound is INCLUSIVE (`<= upTo`): a row stamped in the very same
 * millisecond as the purge is removed. Millisecond precision cannot order two events inside one tick; erring toward
 * deletion is the privacy-safe side, and a re-created node inside that one millisecond would have been written under
 * the node lock after the purge released it, so the inline purge (which runs under the lock) never sees it. An
 * unparseable bound is ignored (unbounded purge), never a silent no-op.
 *
 * Why inclusive (N3): a tie means a version row and the purge moment share one millisecond. Re-creation of the node
 * after the purge needs the per-node lock the purge held, plus a fresh outbox/graph/version round trip, so a row
 * legitimately newer than the purge but stamped in that same millisecond is practically unreachable; losing it would
 * cost one history row, while keeping an erased row would leak content.
 *
 * KNOWN LIMITS of the time-based bounds (documented in API_REFERENCE, no schema change here):
 *  - N2: `changeset_writes` has no timestamp of its own, so a node-scoped purge bounds a buffered write by its parent
 *    changeset's `created_at`. A changeset opened before the purge that buffers a write for a re-created node AFTER the
 *    purge loses that pending write on a replayed purge.
 *  - N4: `node_versions` has no workspace-id column, only the workspace NAME. A workspace erase bounded by `deletedAt`
 *    cannot tell late writes under an OLD same-named workspace instance (written after `deletedAt`) from the new one's.
 */
import type { Database as DatabaseType } from 'better-sqlite3';

const CHUNK = 400;

/** Normalise a bound to the stored ISO-8601 form; null when absent or unparseable (= unbounded). */
function isoBound(upTo: string | undefined): string | null {
    if (!upTo) return null;
    const ms = Date.parse(upTo);
    return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/** Rows removed by one purge/erase call. */
export interface VersionPurgeCounts { versions: number; changesetWrites: number; changesets: number }

/** Delete every version row (and buffered changeset write) of `nodeIds` in `workspace`. Other nodes/workspaces are untouched. */
export function purgeNodeVersions(db: DatabaseType, nodeIds: readonly string[], workspace: string, upTo?: string): VersionPurgeCounts {
    const out: VersionPurgeCounts = { versions: 0, changesetWrites: 0, changesets: 0 };
    const ids = [...new Set(nodeIds.filter((x) => typeof x === 'string' && x.length > 0))];
    if (ids.length === 0) return out;
    const bound = isoBound(upTo);
    const vTs = bound ? ' AND timestamp <= ?' : '';
    const csTs = bound ? ' AND created_at <= ?' : '';
    const tail = bound ? [bound] : [];
    const tx = db.transaction(() => {
        for (let i = 0; i < ids.length; i += CHUNK) {
            const part = ids.slice(i, i + CHUNK);
            const marks = part.map(() => '?').join(',');
            out.versions += db.prepare(`DELETE FROM node_versions WHERE workspace = ? AND node_id IN (${marks})${vTs}`).run(workspace, ...part, ...tail).changes;
            const hit = `changeset_id IN (SELECT id FROM changesets WHERE workspace = ?${csTs}) AND json_valid(payload) AND `
                + `(json_extract(payload, '$.node_id') IN (${marks}) OR json_extract(payload, '$.nodeData.id') IN (${marks}))`;
            const perCs = db.prepare(`SELECT changeset_id AS id, COUNT(*) AS n FROM changeset_writes WHERE ${hit} GROUP BY changeset_id`)
                .all(workspace, ...tail, ...part, ...part) as Array<{ id: string; n: number }>;
            out.changesetWrites += db.prepare(`DELETE FROM changeset_writes WHERE ${hit}`).run(workspace, ...tail, ...part, ...part).changes;
            for (const c of perCs) db.prepare(`UPDATE changesets SET write_count = MAX(write_count - ?, 0) WHERE id = ?`).run(c.n, c.id);
        }
    });
    tx();
    return out;
}

/** Delete every version row, changeset and buffered write of `workspace` (exact name match), optionally only those no newer than `upTo`. */
export function purgeWorkspaceVersions(db: DatabaseType, workspace: string, upTo?: string): VersionPurgeCounts {
    const out: VersionPurgeCounts = { versions: 0, changesetWrites: 0, changesets: 0 };
    const bound = isoBound(upTo);
    const vTs = bound ? ' AND timestamp <= ?' : '';
    const csTs = bound ? ' AND created_at <= ?' : '';
    const tail = bound ? [bound] : [];
    const tx = db.transaction(() => {
        out.versions = db.prepare(`DELETE FROM node_versions WHERE workspace = ?${vTs}`).run(workspace, ...tail).changes;
        out.changesetWrites = db.prepare(`DELETE FROM changeset_writes WHERE changeset_id IN (SELECT id FROM changesets WHERE workspace = ?${csTs})`).run(workspace, ...tail).changes;
        out.changesets = db.prepare(`DELETE FROM changesets WHERE workspace = ?${csTs}`).run(workspace, ...tail).changes;
    });
    tx();
    return out;
}
