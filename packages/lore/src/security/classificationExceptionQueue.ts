/**
 * classificationExceptionQueue.ts — server-side queue of records the AI
 * could not classify with sufficient confidence.
 *
 * Implements the data-integrity HITL path locked in this session: when
 * the ingest classifier's confidence falls below the workspace's
 * threshold (default 0.90 per Rafi's V2.5 answer), the record lands
 * here instead of being silently dropped or routed to the wrong store.
 *
 * Curators (or in soft-split mode, the AI itself if the workspace
 * opted out of the queue) review entries and resolve them by:
 *
 *   - 'route'   → accept the AI's best guess (or override) and ingest
 *   - 'reroute' → ingest as a different node type / kind
 *   - 'drop'    → discard with a stated reason
 *   - 'defer'   → kick down the road; entry stays open
 *
 * Storage: same JSONL pattern as the audit logs. Two files actually:
 *   - exception-queue.open.jsonl (the live queue)
 *   - exception-queue.resolved.jsonl (history; never modified after write)
 *
 * Resolving an entry appends to .resolved and removes from .open. Open
 * file is rewritten in full on resolve (open queue is small; rewrite
 * cost is negligible vs. the complexity of an in-place delete).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { NodeKind } from '../schemas/types.js';

export interface ExceptionQueueEntry {
    /** Stable id for this exception. Used by resolve(). */
    id: string;
    at: string;
    workspace: string;
    sourceId?: string;
    connector?: string;
    inputFingerprint: string;
    /** AI's best guess + confidence at the time of routing. */
    guess: {
        decidedBy: string;
        confidence: number;
        proposedKind?: NodeKind;
        proposedNodeType?: string;
        reasoning?: string;
    };
    /** Snapshot of the record fields the curator needs to decide. */
    sample?: Record<string, unknown>;
}

export interface ExceptionResolution {
    /** Entry being resolved. */
    entryId: string;
    resolvedAt: string;
    resolvedBy: string;
    decision: 'route' | 'reroute' | 'drop' | 'defer';
    /** Required for route/reroute. */
    finalKind?: NodeKind;
    finalNodeType?: string;
    /** Required when decision === 'drop'. */
    reason?: string;
    /** Curator's free-form note. */
    note?: string;
}

export interface ExceptionResolvedRecord {
    entry: ExceptionQueueEntry;
    resolution: ExceptionResolution;
}

export class ClassificationExceptionQueue {
    private readonly openPath: string;
    private readonly resolvedPath: string;

    constructor(baseDir: string) {
        fs.mkdirSync(baseDir, { recursive: true });
        this.openPath = path.join(baseDir, 'exception-queue.open.jsonl');
        this.resolvedPath = path.join(baseDir, 'exception-queue.resolved.jsonl');
    }

    /** Append a new exception to the open queue. */
    enqueue(entry: ExceptionQueueEntry): void {
        validateEntry(entry);
        fs.appendFileSync(this.openPath, JSON.stringify(entry) + '\n', { encoding: 'utf-8' });
    }

    /** All currently-open exceptions, oldest-first. */
    listOpen(filter: { workspace?: string; limit?: number } = {}): ExceptionQueueEntry[] {
        const entries = readJsonl<ExceptionQueueEntry>(this.openPath);
        const out: ExceptionQueueEntry[] = [];
        const limit = filter.limit ?? Infinity;
        for (const e of entries) {
            if (filter.workspace && e.workspace !== filter.workspace) continue;
            out.push(e);
            if (out.length >= limit) break;
        }
        return out;
    }

    /** Read a single open entry by id, or null if not in the open queue. */
    getOpen(id: string): ExceptionQueueEntry | null {
        for (const e of readJsonl<ExceptionQueueEntry>(this.openPath)) {
            if (e.id === id) return e;
        }
        return null;
    }

    /** Resolved-history list, with optional limit. */
    listResolved(filter: { workspace?: string; limit?: number } = {}): ExceptionResolvedRecord[] {
        const records = readJsonl<ExceptionResolvedRecord>(this.resolvedPath);
        const out: ExceptionResolvedRecord[] = [];
        const limit = filter.limit ?? Infinity;
        for (const r of records) {
            if (filter.workspace && r.entry.workspace !== filter.workspace) continue;
            out.push(r);
            if (out.length >= limit) break;
        }
        return out;
    }

    /**
     * Resolve an entry: append to resolved, remove from open.
     *
     * Throws if the entry isn't in the open queue. Idempotent in the
     * sense that a second resolve() call on the same id throws cleanly
     * (entry no longer in open) rather than producing two resolved
     * records.
     */
    resolve(resolution: ExceptionResolution): ExceptionResolvedRecord {
        validateResolution(resolution);
        const open = readJsonl<ExceptionQueueEntry>(this.openPath);
        const idx = open.findIndex(e => e.id === resolution.entryId);
        if (idx < 0) {
            throw new Error(`exception-queue: entry '${resolution.entryId}' not in open queue`);
        }
        const entry = open[idx];
        const record: ExceptionResolvedRecord = { entry, resolution };
        fs.appendFileSync(
            this.resolvedPath,
            JSON.stringify(record) + '\n',
            { encoding: 'utf-8' },
        );
        // Remove from open: rewrite without the resolved entry.
        const remaining = open.filter((_, i) => i !== idx);
        const body = remaining.map(e => JSON.stringify(e)).join('\n');
        fs.writeFileSync(this.openPath, body.length > 0 ? body + '\n' : '', { encoding: 'utf-8' });
        return record;
    }

    /** Counts for dashboards. */
    counts(): { open: number; resolved: number } {
        return {
            open: readJsonl<ExceptionQueueEntry>(this.openPath).length,
            resolved: readJsonl<ExceptionResolvedRecord>(this.resolvedPath).length,
        };
    }
}

/* ---------- internals ---------- */

function readJsonl<T>(p: string): T[] {
    if (!fs.existsSync(p)) return [];
    const raw = fs.readFileSync(p, 'utf-8');
    const out: T[] = [];
    for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try { out.push(JSON.parse(line) as T); } catch { continue; }
    }
    return out;
}

function validateEntry(entry: ExceptionQueueEntry): void {
    if (!entry.id) throw new Error('exception entry missing `id`');
    if (!entry.workspace) throw new Error('exception entry missing `workspace`');
    if (!entry.inputFingerprint) throw new Error('exception entry missing `inputFingerprint`');
    if (!entry.guess) throw new Error('exception entry missing `guess`');
    if (typeof entry.guess.confidence !== 'number') {
        throw new Error('exception.guess.confidence must be a number');
    }
}

function validateResolution(r: ExceptionResolution): void {
    if (!r.entryId) throw new Error('resolution missing `entryId`');
    if (!r.resolvedBy) throw new Error('resolution missing `resolvedBy`');
    if (!r.resolvedAt) throw new Error('resolution missing `resolvedAt`');
    if (!r.decision) throw new Error('resolution missing `decision`');
    if (r.decision === 'route' || r.decision === 'reroute') {
        if (!r.finalKind || !r.finalNodeType) {
            throw new Error("'route'/'reroute' resolution requires finalKind + finalNodeType");
        }
    }
    if (r.decision === 'drop' && !r.reason) {
        throw new Error("'drop' resolution requires a reason");
    }
}
