/**
 * multiMasterSync.ts — Multi-master sync with LWW + conflict log (V3.0 Phase A7).
 *
 * Implements D-QQ ("every device edits; cloud is the merge point; LWW
 * with a conflict log"). Used for local-first workspaces (Personal,
 * Developer, Social Media Manager) where the same user edits from
 * multiple devices and cloud relays between them.
 *
 * Concepts:
 *
 *   ChangeRecord — one write to one node from one device. Carries the
 *                  device id, lamport-style monotonic counter, and
 *                  wall-clock at write time.
 *
 *   MergeRound — given the local current state of a node + a set of
 *                inbound ChangeRecords (e.g., from cloud), compute the
 *                merged result. Conflicts are detected per-field.
 *
 *   LWW resolution — for each conflicting field, the winning value is
 *                    the one with the latest wall-clock; ties broken
 *                    by lamport counter, then device id (lex).
 *                    Loser values are recorded to the conflict log so
 *                    the user can review and override.
 *
 * Conflict log lives in `.lore/sync-conflicts.jsonl`. Each line is a
 * ConflictEntry (field, winner snapshot, loser snapshot, decision
 * timestamp). The admin app reads this for the "review conflicts"
 * surface; for V3.0-Personal without admin app, it's still written —
 * the user can spot-check via CLI.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface ChangeRecord {
    /** Node id this change targets. */
    nodeId: string;
    /** Field name being changed. Use '__delete' for whole-node deletion. */
    field: string;
    /** New value. `undefined` for delete. */
    value: unknown;
    /** Wall-clock at write time, milliseconds since epoch. */
    wallClockMs: number;
    /** Lamport-style monotonic counter from the writing device. */
    lamport: number;
    /** Stable device id (UUID-like). */
    deviceId: string;
}

export interface NodeState {
    nodeId: string;
    /** Current field values. Empty when the node has been deleted. */
    fields: Record<string, unknown>;
    /** Per-field metadata about the last write that set it. */
    lastWrite: Record<string, { wallClockMs: number; lamport: number; deviceId: string }>;
    /** Tombstone: set when the most recent applicable change was a delete. */
    deleted?: boolean;
}

export type MergeOutcome =
    | { kind: 'applied'; nextState: NodeState; conflictsResolved: number }
    | { kind: 'no-op'; reason: 'older-than-current' | 'duplicate' };

export interface ConflictEntry {
    /** R4-002 — the workspace this conflict belongs to. Optional for
     *  back-compat with legacy untagged entries; new entries written by a
     *  workspace-scoped MultiMasterMerger always set it so the conflict log
     *  (a single daemon-wide JSONL) can be filtered per workspace and a
     *  scoped read token can't enumerate other workspaces' conflict history. */
    workspace?: string;
    nodeId: string;
    field: string;
    at: string;
    /** What won (incumbent or candidate). */
    winner: { value: unknown; wallClockMs: number; lamport: number; deviceId: string };
    /** What lost. */
    loser: { value: unknown; wallClockMs: number; lamport: number; deviceId: string };
    rationale: 'wallclock' | 'lamport' | 'device-id';
}

export class ConflictLog {
    private readonly filePath: string;

    constructor(baseDir: string, filename: string = 'sync-conflicts.jsonl') {
        fs.mkdirSync(baseDir, { recursive: true });
        this.filePath = path.join(baseDir, filename);
    }

    get path(): string { return this.filePath; }

    append(entry: ConflictEntry): void {
        fs.appendFileSync(this.filePath, JSON.stringify(entry) + '\n', { encoding: 'utf-8' });
    }

    list(filter: { nodeId?: string; sinceIso?: string; limit?: number; workspace?: string } = {}): ConflictEntry[] {
        if (!fs.existsSync(this.filePath)) return [];
        const raw = fs.readFileSync(this.filePath, 'utf-8');
        const out: ConflictEntry[] = [];
        const limit = filter.limit ?? Infinity;
        for (const line of raw.split('\n')) {
            if (!line.trim()) continue;
            let entry: ConflictEntry;
            try { entry = JSON.parse(line) as ConflictEntry; } catch { continue; }
            // R4-002 — when a workspace filter is set, return ONLY entries tagged
            // with that workspace. Legacy untagged entries are excluded (a scoped
            // caller must not see ambiguous/other-workspace conflicts).
            if (filter.workspace !== undefined && entry.workspace !== filter.workspace) continue;
            if (filter.nodeId && entry.nodeId !== filter.nodeId) continue;
            if (filter.sinceIso && entry.at < filter.sinceIso) continue;
            out.push(entry);
            if (out.length >= limit) break;
        }
        return out;
    }

    count(): number {
        if (!fs.existsSync(this.filePath)) return 0;
        const raw = fs.readFileSync(this.filePath, 'utf-8');
        let n = 0;
        for (const line of raw.split('\n')) if (line.trim()) n++;
        return n;
    }
}

export class MultiMasterMerger {
    /**
     * @param workspace R4-002 — the workspace this merger serves. Stamped onto
     *   every ConflictEntry it appends so the daemon-wide conflict log can be
     *   filtered per workspace. In cloud/multi-master mode a merger is built per
     *   workspace; optional for back-compat / single-workspace local use.
     */
    constructor(private readonly conflictLog: ConflictLog, private readonly workspace?: string) { }

    /** R4-002 — append a conflict tagged with this merger's workspace. */
    private appendConflict(entry: Omit<ConflictEntry, 'workspace'>): void {
        this.conflictLog.append(this.workspace !== undefined ? { workspace: this.workspace, ...entry } : entry);
    }

    /**
     * Apply one inbound ChangeRecord to a local node state.
     *
     * Returns 'applied' when the change wins (or is the first to touch
     * the field). Returns 'no-op' when the change is older than what
     * we already have (duplicate or stale), in which case the conflict
     * log records the loser only when the values differ — pure replays
     * of the same value are silent.
     */
    applyChange(state: NodeState, change: ChangeRecord): MergeOutcome {
        if (state.nodeId !== change.nodeId) {
            throw new Error(`merger: nodeId mismatch (state=${state.nodeId}, change=${change.nodeId})`);
        }

        // Whole-node delete handling.
        if (change.field === '__delete') {
            // Compare against the most-recent per-field write.
            const incumbentMax = mostRecentLastWrite(state);
            const winner = pickWinner(
                incumbentMax,
                { wallClockMs: change.wallClockMs, lamport: change.lamport, deviceId: change.deviceId },
            );
            if (winner === 'incumbent') {
                if (incumbentMax) {
                    this.appendConflict({
                        nodeId: state.nodeId, field: '__delete',
                        at: new Date().toISOString(),
                        winner: { value: state.fields, ...incumbentMax },
                        loser: { value: undefined, wallClockMs: change.wallClockMs, lamport: change.lamport, deviceId: change.deviceId },
                        rationale: rationaleFor(incumbentMax!, change),
                    });
                }
                return { kind: 'no-op', reason: 'older-than-current' };
            }
            const before = { ...state.fields };
            const next: NodeState = {
                nodeId: state.nodeId,
                fields: {},
                lastWrite: {},
                deleted: true,
            };
            if (Object.keys(before).length > 0) {
                this.appendConflict({
                    nodeId: state.nodeId, field: '__delete',
                    at: new Date().toISOString(),
                    winner: { value: undefined, wallClockMs: change.wallClockMs, lamport: change.lamport, deviceId: change.deviceId },
                    loser: { value: before, ...(incumbentMax!) },
                    rationale: rationaleFor(change, incumbentMax!),
                });
                return { kind: 'applied', nextState: next, conflictsResolved: 1 };
            }
            return { kind: 'applied', nextState: next, conflictsResolved: 0 };
        }

        const incumbent = state.lastWrite[change.field];
        if (incumbent
            && incumbent.wallClockMs === change.wallClockMs
            && incumbent.lamport === change.lamport
            && incumbent.deviceId === change.deviceId
            && deepEqual(state.fields[change.field], change.value)
        ) {
            // Pure duplicate — same write seen again. No-op, no conflict log.
            return { kind: 'no-op', reason: 'duplicate' };
        }

        const winner = pickWinner(
            incumbent,
            { wallClockMs: change.wallClockMs, lamport: change.lamport, deviceId: change.deviceId },
        );

        if (winner === 'incumbent') {
            // Existing value wins. Record loser unless values match.
            if (incumbent && !deepEqual(state.fields[change.field], change.value)) {
                this.appendConflict({
                    nodeId: state.nodeId, field: change.field,
                    at: new Date().toISOString(),
                    winner: { value: state.fields[change.field], ...incumbent },
                    loser: { value: change.value, wallClockMs: change.wallClockMs, lamport: change.lamport, deviceId: change.deviceId },
                    rationale: rationaleFor(incumbent, change),
                });
            }
            return { kind: 'no-op', reason: 'older-than-current' };
        }

        // Candidate wins.
        const conflictsResolved = incumbent && !deepEqual(state.fields[change.field], change.value) ? 1 : 0;
        if (conflictsResolved === 1) {
            this.appendConflict({
                nodeId: state.nodeId, field: change.field,
                at: new Date().toISOString(),
                winner: { value: change.value, wallClockMs: change.wallClockMs, lamport: change.lamport, deviceId: change.deviceId },
                loser: { value: state.fields[change.field], ...incumbent! },
                rationale: rationaleFor(change, incumbent!),
            });
        }
        const nextFields = { ...state.fields, [change.field]: change.value };
        const nextLastWrite = {
            ...state.lastWrite,
            [change.field]: { wallClockMs: change.wallClockMs, lamport: change.lamport, deviceId: change.deviceId },
        };
        return {
            kind: 'applied',
            nextState: {
                nodeId: state.nodeId,
                fields: nextFields,
                lastWrite: nextLastWrite,
                deleted: false,
            },
            conflictsResolved,
        };
    }

    /** Apply a batch of changes in deterministic order. Returns final state + total conflicts resolved. */
    applyBatch(initial: NodeState, changes: ChangeRecord[]): { state: NodeState; conflictsResolved: number } {
        // Sort by wallClock, then lamport, then deviceId — deterministic regardless of arrival order.
        const ordered = [...changes].sort((a, b) => {
            if (a.wallClockMs !== b.wallClockMs) return a.wallClockMs - b.wallClockMs;
            if (a.lamport !== b.lamport) return a.lamport - b.lamport;
            return a.deviceId.localeCompare(b.deviceId);
        });
        let state = initial;
        let conflictsResolved = 0;
        for (const c of ordered) {
            const outcome = this.applyChange(state, c);
            if (outcome.kind === 'applied') {
                state = outcome.nextState;
                conflictsResolved += outcome.conflictsResolved;
            }
        }
        return { state, conflictsResolved };
    }
}

/* ---------- helpers ---------- */

function pickWinner(
    incumbent: { wallClockMs: number; lamport: number; deviceId: string } | undefined,
    candidate: { wallClockMs: number; lamport: number; deviceId: string },
): 'incumbent' | 'candidate' {
    if (!incumbent) return 'candidate';
    if (candidate.wallClockMs > incumbent.wallClockMs) return 'candidate';
    if (candidate.wallClockMs < incumbent.wallClockMs) return 'incumbent';
    if (candidate.lamport > incumbent.lamport) return 'candidate';
    if (candidate.lamport < incumbent.lamport) return 'incumbent';
    if (candidate.deviceId > incumbent.deviceId) return 'candidate';
    return 'incumbent';
}

function rationaleFor(
    winner: { wallClockMs: number; lamport: number; deviceId: string },
    loser: { wallClockMs: number; lamport: number; deviceId: string },
): 'wallclock' | 'lamport' | 'device-id' {
    if (winner.wallClockMs !== loser.wallClockMs) return 'wallclock';
    if (winner.lamport !== loser.lamport) return 'lamport';
    return 'device-id';
}

function mostRecentLastWrite(state: NodeState): { wallClockMs: number; lamport: number; deviceId: string } | undefined {
    let best: { wallClockMs: number; lamport: number; deviceId: string } | undefined;
    for (const w of Object.values(state.lastWrite)) {
        if (!best) { best = w; continue; }
        if (pickWinner(best, w) === 'candidate') best = w;
    }
    return best;
}

function deepEqual(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (a === null || b === null || typeof a !== typeof b) return false;
    if (typeof a !== 'object') return false;
    return JSON.stringify(a) === JSON.stringify(b);
}
