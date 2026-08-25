/**
 * migration/checkpointStore.ts — Phase 4 batched checkpointing.
 *
 * Persists migration progress to `<workspace>/.lore/migrations/in-flight.json`
 * so a crashed or restarted plan can resume from the saved cursor
 * instead of starting over (or worse — silently re-running ops that
 * already completed). The file is rewritten atomically (write-rename)
 * after every batch.
 *
 * On-disk shape (one in-flight plan at a time per workspace):
 *
 *   {
 *     "planId": "uuid",
 *     "startedAt": "ISO",
 *     "lastCheckpointAt": "ISO",
 *     "proposedBy": "human:rafi",
 *     "approvedBy": "human:rafi",
 *     "sandboxId": "optional",
 *     "note": "optional",
 *     "ops": [
 *       { "opIndex": 0, "op": {...}, "status": "completed", "cursor": null,
 *         "deleted": 47, "modified": 0 },
 *       { "opIndex": 1, "op": {...}, "status": "in_progress",
 *         "cursor": "node-id-1234", "deleted": 0, "modified": 8000 },
 *       { "opIndex": 2, "op": {...}, "status": "pending",
 *         "cursor": null, "deleted": 0, "modified": 0 }
 *     ]
 *   }
 *
 * Concurrency: only one in-flight plan at a time. The runner refuses
 * to start a new plan if `load()` returns a non-completed entry —
 * caller must explicitly resume or clear first. This keeps the
 * "single-writer per workspace" invariant the existing Kùzu setup
 * already relies on.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { MigrationOp } from './types.js';

export type CheckpointOpStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

export interface CheckpointOp {
    opIndex: number;
    op: MigrationOp;
    status: CheckpointOpStatus;
    /** Substrate-defined cursor for the in-progress op; null for
     *  pending/completed/failed. Opaque to the runner. */
    cursor: string | null;
    deleted: number;
    modified: number;
    /** Present only for failed ops. */
    error?: string;
}

export interface CheckpointState {
    planId: string;
    startedAt: string;
    lastCheckpointAt: string;
    proposedBy: string;
    approvedBy: string;
    sandboxId?: string;
    note?: string;
    ops: CheckpointOp[];
}

const FILENAME = 'in-flight.json';
const ROLLBACK_FILENAME = 'rollback-in-flight.json';

/**
 * C-R3-04 — rollback progress checkpoint. rollback() is best-effort and was
 * NOT resumable: a crash mid-rollback left data half-restored with no record
 * of which ops had completed, so a re-run re-applied every op from scratch.
 * This records which ops have been rolled back so a resumed rollback skips
 * them. Op identity is `${kind}:${target}` (one rollback op per kind+target).
 */
export interface RollbackCheckpointState {
    planId: string;
    startedAt: string;
    lastCheckpointAt: string;
    /** `${kind}:${target}` keys of ops already successfully rolled back. */
    completed: string[];
}

export class CheckpointStore {
    private readonly filePath: string;
    private readonly rollbackFilePath: string;

    /**
     * @param loreDir absolute path to a workspace's `.lore/` directory.
     *                The checkpoint file lives at `<loreDir>/migrations/in-flight.json`.
     */
    constructor(loreDir: string) {
        this.filePath = path.join(loreDir, 'migrations', FILENAME);
        this.rollbackFilePath = path.join(loreDir, 'migrations', ROLLBACK_FILENAME);
    }

    /** Absolute path to the on-disk checkpoint file. Useful for tests + diagnostics. */
    path(): string { return this.filePath; }

    /** Absolute path to the rollback-progress checkpoint file. */
    rollbackPath(): string { return this.rollbackFilePath; }

    /** C-R3-04 — read rollback progress, or null if none. Tolerant of a
     *  malformed file (treated as absent, mirroring load()). */
    loadRollback(): RollbackCheckpointState | null {
        if (!fs.existsSync(this.rollbackFilePath)) return null;
        try {
            const parsed = JSON.parse(fs.readFileSync(this.rollbackFilePath, 'utf-8')) as Partial<RollbackCheckpointState>;
            if (!parsed || !parsed.planId || !Array.isArray(parsed.completed)) {
                console.error(`[CheckpointStore] malformed rollback checkpoint at ${this.rollbackFilePath} — ignoring`);
                return null;
            }
            return parsed as RollbackCheckpointState;
        } catch (err) {
            console.error(`[CheckpointStore] failed to load ${this.rollbackFilePath} (non-fatal, treating as absent): ${(err as Error).message}`);
            return null;
        }
    }

    /** C-R3-04 — atomically persist rollback progress (write-rename). */
    saveRollback(state: RollbackCheckpointState): void {
        fs.mkdirSync(path.dirname(this.rollbackFilePath), { recursive: true });
        const withTs: RollbackCheckpointState = { ...state, lastCheckpointAt: new Date().toISOString() };
        const tmp = `${this.rollbackFilePath}.tmp.${process.pid}.${Date.now()}`;
        fs.writeFileSync(tmp, JSON.stringify(withTs, null, 2), 'utf-8');
        fs.renameSync(tmp, this.rollbackFilePath);
    }

    /** C-R3-04 — delete the rollback checkpoint on completion. No-op if absent. */
    clearRollback(): void {
        try { fs.unlinkSync(this.rollbackFilePath); }
        catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err; }
    }

    /**
     * Read the checkpoint, or `null` if no in-flight plan. Returns
     * `null` (not throws) on parse errors so a stale debug file
     * never crashes the runner — log + treat as missing.
     */
    load(): CheckpointState | null {
        if (!fs.existsSync(this.filePath)) return null;
        try {
            const raw = fs.readFileSync(this.filePath, 'utf-8');
            const parsed = JSON.parse(raw) as Partial<CheckpointState>;
            if (!parsed || !parsed.planId || !Array.isArray(parsed.ops)) {
                console.error(`[CheckpointStore] malformed checkpoint at ${this.filePath} — ignoring`);
                return null;
            }
            return parsed as CheckpointState;
        } catch (err) {
            console.error(
                `[CheckpointStore] failed to load ${this.filePath} (non-fatal, treating as absent): ${(err as Error).message}`,
            );
            return null;
        }
    }

    /** Atomically write the full state. Creates the directory if needed. */
    save(state: CheckpointState): void {
        fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
        const withTimestamp: CheckpointState = {
            ...state,
            lastCheckpointAt: new Date().toISOString(),
        };
        const tmp = `${this.filePath}.tmp.${process.pid}.${Date.now()}`;
        fs.writeFileSync(tmp, JSON.stringify(withTimestamp, null, 2), 'utf-8');
        fs.renameSync(tmp, this.filePath);
    }

    /** Delete the checkpoint (e.g. on plan completion). No-op if absent. */
    clear(): void {
        try { fs.unlinkSync(this.filePath); }
        catch (err) {
            // ENOENT is fine; surface anything else.
            if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
                throw err;
            }
        }
    }
}
