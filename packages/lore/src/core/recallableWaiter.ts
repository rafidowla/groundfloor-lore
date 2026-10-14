/**
 * core/recallableWaiter.ts - 3.34.0 (N5) the engine-neutral "is it recallable yet?" contract.
 *
 * One waiter for every engine. It composes three narrow, optional capabilities that each engine
 * already answers in its own dialect:
 *   - vector.indexedIds? / vector.getVectors?  - is the embedding answered by the vector index?
 *       ArcadeDB : bounded `vector.neighbors` self-check (engines/arcade/arcadeVectorStore.ts)
 *       SQLite   : stored == searchable, so presence in `getVectors` (no new engine code)
 *       Dataplane: neither - the result is an explicit `not_supported` (see below)
 *   - outbox.embedStatesForNodes? / embedBacklog?  - is embed work still queued / dead / done?
 *   - graph.getNodesByIds                          - does the node exist in THIS workspace?
 *
 * Dataplane is `not_supported`: its vector store is a remote tabular API with no embedding-presence
 * read and no outbox position visible to this process; claiming "recallable" there would have to be
 * a guess. It would need a Dataplane `embedded` flag (or a read-your-writes token) on lore_node.
 *
 * Waiting never polls in a tight loop (the M4 out-of-memory pattern N5 replaces): each round sleeps
 * until the replicator's next tick (`waitForRefresh`) or a capped exponential backoff, never less
 * than `minGapMs` apart, and the vector index is asked only about ids that are not still queued in
 * the outbox (the first round asks about all of them, because the local sync write path leaves its
 * `verbatim.upsert` row `pending` even though the vector is already stored).
 *
 * A timeout is a STATUS (`timedOut: true`, `ready: false`), never an error.
 */

import type { OutboxStore } from '../outbox/types.js';
import type {
    RecallableIdStatus, RecallableNotSupported, RecallablePendingReason, RecallableRequest, RecallableResult,
} from '../providers/types.js';

const ROW_PREFIX = 'lore:';
/** Newest replicated nodes verified in the index for the all-before-now form. */
export const ALL_BEFORE_NOW_SAMPLE = 20;

export interface RecallableVector {
    indexedIds?(ids: string[]): Promise<Set<string>>;
    getVectors?(ids: string[]): Promise<Map<string, number[]>>;
}
export interface RecallableDeps {
    /** The workspace's vector store (undefined / lacking both probes => not_supported). */
    vector: RecallableVector | undefined;
    /** The workspace's graph - existence binds ids to the workspace (outside ids => not_found). */
    graph?: { getNodesByIds(ids: string[]): Promise<Map<string, unknown>> };
    outbox?: Pick<OutboxStore, 'embedStatesForNodes' | 'embedBacklog'>;
    /** Outbox lane key (arcade lane decorators replace it with the bound cell key). */
    workspace: string;
    /** Resolves on the replicator's next tick, after maxMs, or on abort. Never rejects. */
    waitForRefresh?: (maxMs: number, signal?: AbortSignal) => Promise<void>;
    pacing?: { initialMs?: number; capMs?: number; minGapMs?: number };
    /** Test seams. */
    now?: () => number;
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
        if (signal?.aborted) return resolve();
        const t = setTimeout(done, Math.max(0, ms));
        function done(): void { clearTimeout(t); signal?.removeEventListener('abort', done); resolve(); }
        signal?.addEventListener('abort', done, { once: true });
    });
}

export function notSupported(reason: string): RecallableNotSupported {
    return { supported: false, code: 'not_supported', reason };
}

/** Does this engine have any way to answer "is the embedding searchable"? */
export function recallableSupport(deps: Pick<RecallableDeps, 'vector'>): RecallableNotSupported | null {
    const v = deps.vector;
    if (!v || (typeof v.indexedIds !== 'function' && typeof v.getVectors !== 'function')) {
        return notSupported('this engine exposes no embedding-presence read (vector.indexedIds / getVectors), so recallability cannot be verified');
    }
    return null;
}

export async function awaitRecallable(deps: RecallableDeps, req: RecallableRequest): Promise<RecallableResult | RecallableNotSupported> {
    const unsupported = recallableSupport(deps);
    if (unsupported) return unsupported;
    if ('allBeforeNow' in req) {
        if (typeof deps.outbox?.embedBacklog !== 'function') {
            return notSupported('everything-queued-before-now needs the outbox position (embedBacklog), which this engine/host does not expose; pass an explicit id list');
        }
        return waitAllBeforeNow(deps, req);
    }
    return waitIds(deps, req);
}

class Pacer {
    private round = 0;
    private lastStart = 0;
    constructor(private readonly deps: RecallableDeps, private readonly now: () => number) {}
    get initial(): number { return this.deps.pacing?.initialMs ?? 100; }
    get cap(): number { return this.deps.pacing?.capMs ?? 1000; }
    get minGap(): number { return this.deps.pacing?.minGapMs ?? 100; }
    begin(): void { this.lastStart = this.now(); }
    /** Sleep until the next replicator tick or the backoff, but never less than minGap since the round began. */
    async wait(deadline: number, signal?: AbortSignal): Promise<void> {
        const delay = Math.min(this.cap, this.initial * 2 ** Math.min(this.round++, 10));
        const room = Math.max(0, deadline - this.now());
        const ms = Math.min(delay, room);
        const sleep = this.deps.sleep ?? defaultSleep;
        if (this.deps.waitForRefresh) await this.deps.waitForRefresh(ms, signal); else await sleep(ms, signal);
        const gap = this.minGap - (this.now() - this.lastStart);
        if (gap > 0) await sleep(Math.min(gap, Math.max(0, deadline - this.now())), signal);
    }
}

/** Probe the vector engine, retrying transient failures (first round fails fast). */
class IndexProbe {
    checks = 0;
    private failures = 0;
    constructor(private readonly vector: RecallableVector) {}
    async indexed(nodeIds: string[]): Promise<Set<string>> {
        if (nodeIds.length === 0) return new Set();
        this.checks++;
        const rows = nodeIds.map((n) => ROW_PREFIX + n);
        try {
            let present: Iterable<string>;
            if (typeof this.vector.indexedIds === 'function') present = await this.vector.indexedIds(rows);
            else present = (await this.vector.getVectors!(rows)).keys();
            this.failures = 0;
            const out = new Set<string>();
            for (const r of present) if (r.startsWith(ROW_PREFIX)) out.add(r.slice(ROW_PREFIX.length));
            return out;
        } catch (err) {
            if (this.checks === 1 || ++this.failures >= 3) throw err;
            return new Set();
        }
    }
}

async function existingIds(deps: RecallableDeps, ids: string[]): Promise<Set<string>> {
    if (!deps.graph || ids.length === 0) return new Set();
    return new Set((await deps.graph.getNodesByIds(ids)).keys());
}

async function waitIds(deps: RecallableDeps, req: Extract<RecallableRequest, { ids: string[] }>): Promise<RecallableResult> {
    const now = deps.now ?? Date.now;
    const start = now();
    const deadline = start + Math.max(0, req.timeoutMs);
    const ids = [...new Set(req.ids)];
    const probe = new IndexProbe(deps.vector!);
    const pacer = new Pacer(deps, now);
    const result = new Map<string, RecallableIdStatus>();
    // Ids still being decided; settled ids leave this set.
    let open = new Set(ids);
    let first = true;
    let timedOut = false;
    for (;;) {
        pacer.begin();
        const unresolved = [...open];
        const states = deps.outbox?.embedStatesForNodes ? await deps.outbox.embedStatesForNodes(deps.workspace, unresolved) : new Map();
        // Round 1 asks the index about everything; later rounds skip ids whose outbox row is still queued.
        const toProbe = first ? unresolved : unresolved.filter((i) => states.get(i) !== 'queued');
        const indexed = await probe.indexed(toProbe);
        const rest = unresolved.filter((i) => !indexed.has(i));
        const inGraph = rest.some((i) => !states.has(i) || states.get(i) === 'replicated') ? await existingIds(deps, rest) : new Set<string>();
        for (const id of unresolved) {
            if (indexed.has(id)) { result.set(id, { id, status: 'recallable' }); open.delete(id); continue; }
            const st = states.get(id);
            let reason: RecallablePendingReason | undefined;
            if (st === 'queued') reason = 'queued';
            else if (st === 'dead') reason = 'embed_failed';
            else if (st === 'replicated' || inGraph.has(id)) reason = 'awaiting_index';
            if (!reason) { result.set(id, { id, status: 'not_found' }); open.delete(id); continue; }
            result.set(id, { id, status: 'pending', reason });
            if (reason === 'embed_failed') open.delete(id); // will never embed by waiting
        }
        first = false;
        if (open.size === 0) break;
        if (req.signal?.aborted || now() >= deadline) { timedOut = true; break; }
        await pacer.wait(deadline, req.signal);
        if (req.signal?.aborted) { timedOut = true; break; }
    }
    const list = ids.map((i) => result.get(i)!);
    const counts = { recallable: 0, pending: 0, notFound: 0 };
    for (const s of list) { if (s.status === 'recallable') counts.recallable++; else if (s.status === 'pending') counts.pending++; else counts.notFound++; }
    const ready = counts.pending === 0 && counts.notFound === 0;
    return { supported: true, mode: 'ids', ready, timedOut: timedOut && !ready, waitedMs: now() - start, indexChecks: probe.checks, counts, ids: list };
}

async function waitAllBeforeNow(deps: RecallableDeps, req: Extract<RecallableRequest, { allBeforeNow: true }>): Promise<RecallableResult> {
    const now = deps.now ?? Date.now;
    const start = now();
    const deadline = start + Math.max(0, req.timeoutMs);
    const outbox = deps.outbox!;
    const probe = new IndexProbe(deps.vector!);
    const pacer = new Pacer(deps, now);
    // Snapshot the high-water mark at request time: rows queued AFTER this call do not move the goalposts.
    const hw = (await outbox.embedBacklog!(deps.workspace, null, 0)).highWaterSequenceId;
    let queued = 0, sampled = 0, recallable = 0, timedOut = false, ready = false;
    for (;;) {
        pacer.begin();
        const bl = await outbox.embedBacklog!(deps.workspace, hw, ALL_BEFORE_NOW_SAMPLE);
        queued = bl.queued;
        if (queued === 0) {
            // Backlog drained: spot-check that the newest replicated nodes are answered by the index.
            const indexed = await probe.indexed(bl.sampleNodeIds);
            const missing = bl.sampleNodeIds.filter((i) => !indexed.has(i));
            // A sampled node deleted since is not a lag signal.
            const alive = missing.length ? await existingIds(deps, missing) : new Set<string>();
            const stillMissing = missing.filter((i) => alive.has(i));
            sampled = bl.sampleNodeIds.length - (missing.length - stillMissing.length);
            recallable = indexed.size;
            if (stillMissing.length === 0) { ready = true; break; }
        }
        if (req.signal?.aborted || now() >= deadline) { timedOut = true; break; }
        await pacer.wait(deadline, req.signal);
        if (req.signal?.aborted) { timedOut = true; break; }
    }
    return {
        supported: true, mode: 'all_before_now', ready, timedOut: timedOut && !ready, waitedMs: now() - start,
        indexChecks: probe.checks, counts: { recallable, pending: Math.max(0, sampled - recallable), notFound: 0 },
        highWaterSequenceId: hw, queuedRemaining: queued, sampled,
    };
}
