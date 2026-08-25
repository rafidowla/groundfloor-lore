/**
 * outbox/store.ts — file-based outbox persistence.
 *
 * Stores the current outbox state as a JSON map keyed by entry id,
 * written via atomic write-rename on every mutation. JSON (not JSONL)
 * because the working set is small (in-flight + recently-completed)
 * and the simplest correct durability story is "rewrite the whole
 * file each time."
 *
 * Tolerant of corruption: an unparseable file is treated as empty on
 * next read rather than crashing the daemon. The MigrationCheckpointStore
 * + OrchestrationStore prove this pattern works for similar long-lived
 * plan state.
 *
 * File location: `<workspace>/.lore/outbox.json`.
 *
 * Sprint O1 (2026-05-24) — extends the file format for the
 * universal-write contract:
 *   - Per-workspace monotonic `sequenceId` assigned at record() time
 *     (allocator scans current MAX(sequenceId) per workspace + 1)
 *   - Pre-O1 rows (no `sequenceId`, no `workspace`, no `operationKind`)
 *     are backfilled on read: workspace='default', operationKind='sync.vector.mirror',
 *     sequenceId from row order (insertion sequence within 'default')
 *   - New record() with `operationKind` set MUST carry non-empty `workspace`
 *     (Sprint L invariant). Pre-O1 producers that omit `operationKind`
 *     still work for backward compat.
 *   - Per-workspace replicator cursor persisted alongside outbox.json
 *     in a sibling file `outbox-replication.json`.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
    OutboxAggregateStats,
    OutboxEntry,
    OutboxReplicationState,
    OutboxStatus,
    OutboxStore as IOutboxStore,
    OutboxWorkspaceStats,
    StepStatus,
} from './types.js';

const FILE_NAME = 'outbox.json';
const REPL_STATE_FILE = 'outbox-replication.json';
const MAX_ERROR_LEN = 1024;
const DEFAULT_WORKSPACE_BACKFILL = 'default';

interface ReplStateMap {
    [workspace: string]: OutboxReplicationState;
}

export class FileOutboxStore implements IOutboxStore {
    private readonly filePath: string;
    private readonly replStatePath: string;

    constructor(loreDir: string) {
        fs.mkdirSync(loreDir, { recursive: true });
        this.filePath = path.join(loreDir, FILE_NAME);
        this.replStatePath = path.join(loreDir, REPL_STATE_FILE);
    }

    get path(): string { return this.filePath; }
    get replicationStatePath(): string { return this.replStatePath; }

    private readAll(): Record<string, OutboxEntry> {
        if (!fs.existsSync(this.filePath)) return {};
        try {
            const raw = fs.readFileSync(this.filePath, 'utf-8');
            const parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
            const map = parsed as Record<string, OutboxEntry>;
            // Sprint O1 — backfill legacy rows that pre-date workspace +
            // sequenceId. We do this on every read so callers always see
            // a normalized shape; the next mutation writes the backfilled
            // values back to disk.
            return this.backfillLegacy(map);
        } catch {
            return {};
        }
    }

    /** Backfill pre-O1 rows: workspace='default', operationKind=
     *  'sync.vector.mirror' (the only pre-O1 producer per O0 audit),
     *  sequenceId from createdAt-sorted insertion order within
     *  workspace, status derived from `completed`. Idempotent. */
    private backfillLegacy(map: Record<string, OutboxEntry>): Record<string, OutboxEntry> {
        // Group missing-sequenceId entries by workspace and assign in
        // createdAt order. Pre-existing sequenceIds are respected so we
        // don't renumber.
        const needsBackfillByWs: Record<string, OutboxEntry[]> = {};
        const maxSeqByWs: Record<string, number> = {};
        for (const entry of Object.values(map)) {
            const ws = entry.workspace ?? DEFAULT_WORKSPACE_BACKFILL;
            if (entry.workspace === undefined) entry.workspace = ws;
            if (entry.operationKind === undefined) entry.operationKind = 'sync.vector.mirror';
            if (entry.status === undefined) {
                entry.status = entry.completed ? 'replicated' : 'pending';
            }
            if (entry.attempts === undefined) entry.attempts = 0;
            if (typeof entry.sequenceId === 'number') {
                maxSeqByWs[ws] = Math.max(maxSeqByWs[ws] ?? 0, entry.sequenceId);
            } else {
                (needsBackfillByWs[ws] ??= []).push(entry);
            }
        }
        for (const [ws, list] of Object.entries(needsBackfillByWs)) {
            list.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
            let next = (maxSeqByWs[ws] ?? 0) + 1;
            for (const e of list) {
                e.sequenceId = next++;
            }
        }
        return map;
    }

    private writeAll(map: Record<string, OutboxEntry>): void {
        const tmp = `${this.filePath}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(map, null, 2), 'utf-8');
        fs.renameSync(tmp, this.filePath);
    }

    /** Per-workspace sequenceId allocator. Reads the current map,
     *  finds MAX(sequenceId) where workspace=$ws, returns +1.
     *  Callers must hold the in-process write so they can record()
     *  with the returned value before another record() races. */
    private nextSequenceId(map: Record<string, OutboxEntry>, workspace: string): number {
        let max = 0;
        for (const e of Object.values(map)) {
            if (e.workspace === workspace && typeof e.sequenceId === 'number' && e.sequenceId > max) {
                max = e.sequenceId;
            }
        }
        return max + 1;
    }

    async record(entry: OutboxEntry): Promise<void> {
        const map = this.readAll();
        // Sprint O1 — workspace-required invariant on NEW universal-write
        // rows. The legacy sync-engine producer (which calls withOutbox
        // without operationKind set on the entry) is grandfathered to
        // workspace='default' to avoid breaking the existing path until
        // O2 migrates it. New producers MUST set operationKind AND
        // provide a non-empty workspace.
        if (entry.operationKind !== undefined) {
            if (!entry.workspace || typeof entry.workspace !== 'string') {
                throw new Error(
                    `outbox: workspace is required for operationKind '${entry.operationKind}' entries (Sprint L invariant)`,
                );
            }
        } else {
            // Legacy producer — backfill workspace + operationKind so
            // the on-disk row is universal-write-shaped from the start.
            entry.workspace ??= DEFAULT_WORKSPACE_BACKFILL;
            entry.operationKind = 'sync.vector.mirror';
        }
        // Assign sequenceId if missing. Per-workspace monotonic.
        if (typeof entry.sequenceId !== 'number') {
            entry.sequenceId = this.nextSequenceId(map, entry.workspace);
        }
        // Default replication bookkeeping.
        entry.status ??= 'pending';
        entry.attempts ??= 0;
        map[entry.id] = entry;
        this.writeAll(map);
    }

    /** Sprint O3 — single atomic file rewrite for N entries.
     *
     *  Why: bulk endpoints (POST /api/nodes/bulk etc.) need to record
     *  one outbox row per item. Naïve N×record() rewrites the JSON
     *  file N times — at 1000 items that's ~10s of redundant I/O and
     *  blows the O-D11 ±10% perf bound. Batching the commit makes
     *  the outbox overhead a single readAll + writeAll regardless of
     *  N, well under the budget.
     *
     *  Per-workspace sequenceId is allocated once for the whole batch
     *  per workspace (entries get contiguous ids preserving array order
     *  within each workspace). All other invariants from record()
     *  hold per-entry: workspace required when operationKind is set,
     *  status/attempts defaults, etc.
     */
    async batchRecord(entries: OutboxEntry[]): Promise<void> {
        if (entries.length === 0) return;
        const map = this.readAll();
        const nextSeqByWs: Record<string, number> = {};
        for (const entry of entries) {
            if (entry.operationKind !== undefined) {
                if (!entry.workspace || typeof entry.workspace !== 'string') {
                    throw new Error(
                        `outbox.batchRecord: workspace is required for operationKind '${entry.operationKind}' entries (Sprint L invariant)`,
                    );
                }
            } else {
                entry.workspace ??= DEFAULT_WORKSPACE_BACKFILL;
                entry.operationKind = 'sync.vector.mirror';
            }
            const ws = entry.workspace!;
            if (typeof entry.sequenceId !== 'number') {
                if (nextSeqByWs[ws] === undefined) {
                    nextSeqByWs[ws] = this.nextSequenceId(map, ws);
                }
                entry.sequenceId = nextSeqByWs[ws]++;
            }
            entry.status ??= 'pending';
            entry.attempts ??= 0;
            map[entry.id] = entry;
        }
        this.writeAll(map);
    }

    async markStep(entryId: string, stepIndex: number, status: StepStatus, error?: string): Promise<void> {
        const map = this.readAll();
        const entry = map[entryId];
        if (!entry) return;
        const step = entry.steps[stepIndex];
        if (!step) return;
        const now = new Date().toISOString();
        step.status = status;
        if (!step.startedAt) step.startedAt = now;
        if (status === 'done' || status === 'failed') step.finishedAt = now;
        if (error) step.error = error.slice(0, MAX_ERROR_LEN);
        entry.updatedAt = now;
        this.writeAll(map);
    }

    async markCompleted(entryId: string): Promise<void> {
        const map = this.readAll();
        const entry = map[entryId];
        if (!entry) return;
        entry.completed = true;
        entry.updatedAt = new Date().toISOString();
        // Sprint O1 — keep entry-level status in sync. A completed entry
        // is, by definition, replicated.
        if (entry.status !== 'replicated') {
            entry.status = 'replicated';
            entry.replicatedAt = entry.updatedAt;
        }
        this.writeAll(map);
    }

    async remove(entryId: string): Promise<void> {
        const map = this.readAll();
        if (!(entryId in map)) return;
        delete map[entryId];
        this.writeAll(map);
    }

    // C-R2-03 — conditional remove for rollback safety. Only deletes the row if
    // it is still 'pending' (the replicator hasn't claimed it). The whole-file
    // read-modify-write is the serialization point: once the replicator's
    // markEntryStatus(id,'replicating') has committed, this read sees the new
    // status and returns false so the caller compensates (records a node.delete)
    // instead of leaving a graph-only orphan the in-flight node.upsert resurrects.
    async removeIfPending(entryId: string): Promise<boolean> {
        const map = this.readAll();
        const entry = map[entryId];
        if (!entry) return true;                                       // nothing to replay
        if (entry.status && entry.status !== 'pending') return false;  // already claimed → compensate
        delete map[entryId];
        this.writeAll(map);
        return true;
    }

    async listUnfinished(): Promise<OutboxEntry[]> {
        const map = this.readAll();
        return Object.values(map).filter(e => !e.completed);
    }

    // ---- Sprint O1 additions ----

    async listPendingForWorkspace(workspace: string, limit: number): Promise<OutboxEntry[]> {
        const map = this.readAll();
        const rows = Object.values(map)
            .filter(e => e.workspace === workspace
                && (e.status === 'pending' || e.status === 'failed'))
            .sort((a, b) => (a.sequenceId ?? 0) - (b.sequenceId ?? 0));
        return rows.slice(0, Math.max(0, limit));
    }

    async listWorkspacesWithPending(): Promise<string[]> {
        const map = this.readAll();
        const set = new Set<string>();
        for (const e of Object.values(map)) {
            if ((e.status === 'pending' || e.status === 'failed') && e.workspace) {
                set.add(e.workspace);
            }
        }
        return Array.from(set);
    }

    async markEntryStatus(
        entryId: string,
        status: OutboxStatus,
        info?: { error?: string; bumpAttempt?: boolean },
    ): Promise<void> {
        const map = this.readAll();
        const entry = map[entryId];
        if (!entry) return;
        const now = new Date().toISOString();
        entry.status = status;
        entry.updatedAt = now;
        if (info?.bumpAttempt) entry.attempts = (entry.attempts ?? 0) + 1;
        if (info?.error) entry.lastError = info.error.slice(0, MAX_ERROR_LEN);
        if (status === 'replicated') {
            entry.replicatedAt = now;
            entry.completed = true;
        }
        if (status === 'failed' || status === 'dead') {
            entry.failedAt = now;
        }
        this.writeAll(map);
    }

    async readReplicationState(workspace: string): Promise<OutboxReplicationState> {
        const all = this.readReplStateMap();
        return all[workspace] ?? {
            lastReplicatedSeq: 0,
            updatedAt: new Date(0).toISOString(),
        };
    }

    async writeReplicationState(workspace: string, state: OutboxReplicationState): Promise<void> {
        const all = this.readReplStateMap();
        all[workspace] = state;
        const tmp = `${this.replStatePath}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(all, null, 2), 'utf-8');
        fs.renameSync(tmp, this.replStatePath);
    }

    private readReplStateMap(): ReplStateMap {
        if (!fs.existsSync(this.replStatePath)) return {};
        try {
            const raw = fs.readFileSync(this.replStatePath, 'utf-8');
            const parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
            return parsed as ReplStateMap;
        } catch {
            return {};
        }
    }

    async statsByWorkspace(): Promise<Record<string, OutboxWorkspaceStats>> {
        const map = this.readAll();
        const stats: Record<string, OutboxWorkspaceStats> = {};
        const now = Date.now();
        for (const e of Object.values(map)) {
            const ws = e.workspace ?? DEFAULT_WORKSPACE_BACKFILL;
            const s = stats[ws] ??= { depth: 0, lagSeconds: 0, dead: 0 };
            if (e.status === 'dead') {
                s.dead += 1;
            } else if (e.status === 'pending' || e.status === 'replicating' || e.status === 'failed') {
                s.depth += 1;
                const created = Date.parse(e.createdAt);
                if (Number.isFinite(created)) {
                    const lag = Math.max(0, Math.floor((now - created) / 1000));
                    if (lag > s.lagSeconds) s.lagSeconds = lag;
                }
            }
        }
        return stats;
    }

    async aggregateStats(): Promise<OutboxAggregateStats> {
        const perWorkspace = await this.statsByWorkspace();
        let depth = 0, dead = 0, lagSeconds = 0;
        for (const s of Object.values(perWorkspace)) {
            depth += s.depth;
            dead += s.dead;
            if (s.lagSeconds > lagSeconds) lagSeconds = s.lagSeconds;
        }
        return { depth, dead, lagSeconds, perWorkspace };
    }
}
