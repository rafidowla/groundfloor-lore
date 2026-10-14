/**
 * outbox/recallableQueries.ts - 3.34.0 (N5) outbox reads behind `awaitRecallable`.
 * Shared by the SQLite store (SQL) and, through `classifyEmbedRow`, the JSON store. Kept out of
 * sqliteStore.ts / supersession.ts (file-size budget).
 *
 * Two embed-producing row kinds exist: `verbatim.upsert` (payload.id = `lore:<nodeId>`; one per node
 * on arcade bulk and on every single-node write) and `embed.batch` (local bulk; payload.targetNodeIds).
 */

import type { OutboxStatus } from './types.js';

type Db = { prepare(sql: string): { all(...params: unknown[]): unknown[]; get(...params: unknown[]): unknown } };
export type EmbedRowState = 'queued' | 'dead' | 'replicated';

const CHUNK = 500;
const VERBATIM_PREFIX = 'lore:';

/** 'queued' for a still-to-run status, 'dead' for dead-lettered, 'replicated' for done. */
export function embedStateOfStatus(status: OutboxStatus | string): EmbedRowState | null {
    if (status === 'pending' || status === 'failed' || status === 'replicating') return 'queued';
    if (status === 'dead') return 'dead';
    if (status === 'replicated') return 'replicated';
    return null;
}

/** Of two states for one node, the one from the newer row wins; ties prefer 'queued'. */
export function mergeEmbedState(
    cur: { state: EmbedRowState; seq: number } | undefined,
    next: { state: EmbedRowState; seq: number },
): { state: EmbedRowState; seq: number } {
    if (!cur || next.seq > cur.seq) return next;
    if (next.seq === cur.seq && next.state === 'queued') return next;
    return cur;
}

/** Node ids a payload embeds: `lore:<id>` for verbatim.upsert, targetNodeIds for embed.batch. */
export function embedTargetsOf(kind: string, payload: unknown): string[] {
    if (!payload || typeof payload !== 'object') return [];
    const p = payload as Record<string, unknown>;
    if (kind === 'verbatim.upsert') {
        const id = p['id'];
        return typeof id === 'string' && id.startsWith(VERBATIM_PREFIX) ? [id.slice(VERBATIM_PREFIX.length)] : [];
    }
    if (kind === 'embed.batch') {
        const t = p['targetNodeIds'];
        return Array.isArray(t) ? t.filter((x): x is string => typeof x === 'string') : [];
    }
    return [];
}

export function embedStatesForNodesOf(db: Db, workspace: string, nodeIds: string[]): Map<string, EmbedRowState> {
    const best = new Map<string, { state: EmbedRowState; seq: number }>();
    const pid = "CASE WHEN json_valid(payload) THEN json_extract(payload, '$.id') END";
    for (let i = 0; i < nodeIds.length; i += CHUNK) {
        const part = nodeIds.slice(i, i + CHUNK);
        const rows = db.prepare(
            `SELECT ${pid} AS pid, status, sequenceId FROM outbox_entries
             WHERE workspace = ? AND operationKind = 'verbatim.upsert' AND ${pid} IN (${part.map(() => '?').join(', ')})`,
        ).all(workspace, ...part.map((n) => VERBATIM_PREFIX + n)) as { pid: string; status: string; sequenceId: number }[];
        for (const r of rows) {
            const state = embedStateOfStatus(r.status);
            if (!state || typeof r.pid !== 'string') continue;
            const id = r.pid.slice(VERBATIM_PREFIX.length);
            best.set(id, mergeEmbedState(best.get(id), { state, seq: r.sequenceId ?? 0 }));
        }
        const batch = db.prepare(
            `SELECT j.value AS nid, e.status AS status, e.sequenceId AS sequenceId
             FROM outbox_entries e, json_each(CASE WHEN json_valid(e.payload) THEN e.payload ELSE '{}' END, '$.targetNodeIds') j
             WHERE e.workspace = ? AND e.operationKind = 'embed.batch' AND j.value IN (${part.map(() => '?').join(', ')})`,
        ).all(workspace, ...part) as { nid: string; status: string; sequenceId: number }[];
        for (const r of batch) {
            const state = embedStateOfStatus(r.status);
            if (!state || typeof r.nid !== 'string') continue;
            best.set(r.nid, mergeEmbedState(best.get(r.nid), { state, seq: r.sequenceId ?? 0 }));
        }
    }
    return new Map([...best].map(([k, v]) => [k, v.state]));
}

export function embedBacklogOf(db: Db, workspace: string, upToSequenceId: number | null, sampleLimit: number): { highWaterSequenceId: number; queued: number; sampleNodeIds: string[] } {
    const hw = (db.prepare(`SELECT COALESCE(MAX(sequenceId), 0) AS m FROM outbox_entries WHERE workspace = ?`).get(workspace) as { m: number }).m;
    if (upToSequenceId === null) return { highWaterSequenceId: hw, queued: 0, sampleNodeIds: [] };
    const q = db.prepare(
        `SELECT COUNT(*) AS n FROM outbox_entries
         WHERE workspace = ? AND operationKind IN ('verbatim.upsert', 'embed.batch') AND sequenceId <= ?
           AND status IN ('pending', 'failed', 'replicating')`,
    ).get(workspace, upToSequenceId) as { n: number };
    const rows = db.prepare(
        `SELECT operationKind, payload FROM outbox_entries
         WHERE workspace = ? AND operationKind IN ('verbatim.upsert', 'embed.batch') AND sequenceId <= ? AND status = 'replicated'
         ORDER BY sequenceId DESC LIMIT ?`,
    ).all(workspace, upToSequenceId, Math.max(1, sampleLimit)) as { operationKind: string; payload: string }[];
    const out: string[] = [];
    for (const r of rows) {
        let parsed: unknown;
        try { parsed = JSON.parse(r.payload); } catch { continue; }
        for (const id of embedTargetsOf(r.operationKind, parsed)) {
            if (out.length >= sampleLimit) break;
            if (!out.includes(id)) out.push(id);
        }
        if (out.length >= sampleLimit) break;
    }
    return { highWaterSequenceId: hw, queued: q.n, sampleNodeIds: out };
}
