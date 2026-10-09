/**
 * conditionalChecks.ts — the shared vocabulary of the per-item conditional
 * writes of phase 2b: `ifRevision` (write only if THIS node is at revision n)
 * and `preconditions` (write only if every listed OTHER node is at its listed
 * revision). Used by POST /api/nodes/bulk, POST /api/node and the embedded
 * `nodeUpsert`.
 *
 * Guarantee level: the checks run under the per-(workspace,id) node locks of
 * THIS process (see nodeWriteLock.ts) and read the graph, which every write path
 * updates inline, so they see the latest ACCEPTED state, including writes still
 * waiting in the outbox. `ifRevision` additionally lands as a conditional
 * `WHERE revision = n` write, so another daemon moving the node loses cleanly.
 * `preconditions` are NOT enforced across daemons (phase 3).
 */
import type { LoreNode } from '../providers/types.js';
import { assertSafeLanceId } from '../engines/verbatimHistory.js';
import { revisionOf } from '../engines/graphShared/revision.js';

export const MAX_PRECONDITIONS = 32;

export interface Precondition { id: string; revision: number }
export interface FailedPrecondition { id: string; expected: number; found: number | null }

/** The write-time conditions of one item, after validation. */
export interface ItemConditions { ifRevision?: number; preconditions?: Precondition[] }

type ParsedConditions =
    | { ok: true; conditions: ItemConditions }
    | { ok: false; code: 'invalid_if_revision' | 'invalid_preconditions'; error: string };

const isRevisionInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && Number.isSafeInteger(v);

/** Validate the `ifRevision` / `preconditions` fields of one item (and their interplay with `ifAbsent`). */
export function parseConditionalFields(input: { id: string; ifRevision: unknown; preconditions: unknown; ifAbsent?: unknown }): ParsedConditions {
    const { id, ifRevision, preconditions } = input;
    const conditions: ItemConditions = {};
    if (ifRevision !== undefined) {
        if (!isRevisionInt(ifRevision)) return { ok: false, code: 'invalid_if_revision', error: 'invalid_if_revision: ifRevision must be a non-negative integer' };
        if (input.ifAbsent === true) return { ok: false, code: 'invalid_if_revision', error: 'invalid_if_revision: ifAbsent and ifRevision cannot be combined (ifAbsent creates, ifRevision updates)' };
        conditions.ifRevision = ifRevision;
    }
    if (preconditions !== undefined) {
        const bad = (why: string): ParsedConditions => ({ ok: false, code: 'invalid_preconditions', error: `invalid_preconditions: ${why}` });
        if (!Array.isArray(preconditions)) return bad('preconditions must be an array of { id, revision }');
        if (preconditions.length > MAX_PRECONDITIONS) return bad(`at most ${MAX_PRECONDITIONS} preconditions per item (got ${preconditions.length})`);
        const list: Precondition[] = [];
        for (const p of preconditions as unknown[]) {
            const rec = p && typeof p === 'object' && !Array.isArray(p) ? p as Record<string, unknown> : null;
            if (!rec || typeof rec['id'] !== 'string' || !isRevisionInt(rec['revision'])) return bad('each precondition must be { id: string, revision: non-negative integer }');
            try { assertSafeLanceId(rec['id'], 'conditionalChecks.preconditions'); } catch { return bad('a precondition id is not a valid node id'); }
            if (rec['id'] === id) return bad('a precondition cannot name the item\'s own id (use ifRevision)');
            list.push({ id: rec['id'], revision: rec['revision'] });
        }
        if (list.length > 0) conditions.preconditions = list;
    }
    return { ok: true, conditions };
}

/** Every precondition entry that does not hold now. `found: null` = the node is absent. */
export async function findFailedPreconditions(
    graph: { getNode?(id: string): Promise<LoreNode | null> },
    preconditions: readonly Precondition[],
): Promise<FailedPrecondition[]> {
    const failed: FailedPrecondition[] = [];
    for (const p of preconditions) {
        const node = await graph.getNode!(p.id);
        const found = node ? revisionOf(node) : null;
        if (found !== p.revision) failed.push({ id: p.id, expected: p.revision, found });
    }
    return failed;
}

export const revisionMismatchMessage = (id: string, expected: number, found: number | null): string =>
    `revision_mismatch: ${id} expected revision ${expected}, found ${found === null ? 'absent' : found}`;

export const preconditionFailedMessage = (failed: readonly FailedPrecondition[]): string => {
    const f = failed[0]!;
    return `precondition_failed: ${f.id} expected revision ${f.expected}, found ${f.found === null ? 'absent' : f.found}${failed.length > 1 ? ` (and ${failed.length - 1} more)` : ''}`;
};

export const REVISION_UNSUPPORTED = 'revision_unsupported: this storage engine keeps no per-node revision, so ifRevision / preconditions cannot be honoured; nothing was written';

/** A write condition that did not hold; thrown from a write callback and mapped to the item's failure payload. */
export class ItemConditionError extends Error {
    constructor(readonly payload: { error: string; currentRevision?: number | null; failedPreconditions?: FailedPrecondition[] }) {
        super(payload.error);
        this.name = 'ItemConditionError';
    }
}

/**
 * Check an item's conditions against the graph as it is now (call under the
 * locks, immediately before the item's write). Returns the failure payload or null.
 * `ifRevision` is checked first; a failing `ifRevision` reports only itself.
 */
export async function checkItemConditions(
    graph: { getNode?(id: string): Promise<LoreNode | null> },
    id: string,
    c: ItemConditions,
): Promise<{ error: string; currentRevision?: number | null; failedPreconditions?: FailedPrecondition[] } | null> {
    if (c.ifRevision !== undefined) {
        const node = await graph.getNode!(id);
        const found = node ? revisionOf(node) : null;
        if (found !== c.ifRevision) return { error: revisionMismatchMessage(id, c.ifRevision, found), currentRevision: found };
    }
    if (c.preconditions && c.preconditions.length > 0) {
        const failed = await findFailedPreconditions(graph, c.preconditions);
        if (failed.length > 0) return { error: preconditionFailedMessage(failed), failedPreconditions: failed };
    }
    return null;
}
