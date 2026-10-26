/**
 * verbatimRetiredRead.ts - reads on a RETIRED SqliteVerbatimStore follow the promoted store.
 *
 * Wave E (lane e5), follow-up to verbatimRetiredRetry.ts (writes). After a background SQLite -> LanceDB promotion
 * the daemon's boot SqliteVerbatimStore stays open but retired: server.ts, the routes, the sync engine and the
 * shutdown drain all hold that instance. Its writes already forward to the promoted store; its reads used to keep
 * answering from the pre-promotion SQLite data (the open handle on the renamed-away file), so anything written
 * after the promotion was invisible through a held reference until restart.
 *
 * Rule, per read: if this instance is retired (the promotion-retire generation of its path moved past the one it
 * opened under) AND the workspace resolver now hands out a DIFFERENT store, the read is replayed there. In every
 * other case the local read runs exactly as before:
 *   - not retired (the normal case): one Map lookup, no resolver call;
 *   - closed or never initialized: local, so closed-store semantics are unchanged (the shutdown drain still gets
 *     today's empty answers; the resolver is never asked to reopen a store the drain just closed);
 *   - retired but the swap has not landed yet (or failed, or the resolver cannot be asked): the old store is still
 *     consistent up to the promotion point, so it answers rather than failing. This window is the same one a
 *     retired WRITE waits out (verbatimRetiredRetry.ts), except that a read never waits.
 *
 * No bounce-back: the replay only ever targets an object that is not `self`, and the resolver re-resolves on every
 * call (a cached successor could be an idle-evicted, closed store). A replay that fails is surfaced, never
 * answered from the stale file instead. Only a successor closed under us (idle eviction between resolve and call)
 * is re-resolved once.
 */
import { currentRetireGeneration } from './verbatimWriteBarrier.js';
import { isVerbatimStoreClosedError } from './verbatimStoreClosedError.js';
import type { ResolveSuccessor } from './verbatimRetiredRetry.js';

export interface RetiredReadContext {
    self: object;
    basePath: string;
    /** Generation of `basePath` when `self` opened. */
    barrierGeneration: number;
    resolveSuccessor?: ResolveSuccessor;
    /** False when closed or not initialized: such a store never forwards. */
    live: boolean;
}

/** True when `ctx.self` was retired by a promotion commit (cheap: no I/O). */
export function isRetiredForReads(ctx: RetiredReadContext): boolean {
    return ctx.live && !!ctx.resolveSuccessor && currentRetireGeneration(ctx.basePath) > ctx.barrierGeneration;
}

async function resolveOther(ctx: RetiredReadContext): Promise<Record<string, unknown> | undefined> {
    try {
        const s = await ctx.resolveSuccessor!();
        return s && s !== ctx.self ? (s as Record<string, unknown>) : undefined;
    } catch {
        return undefined; // not resolvable (yet): the old store answers
    }
}

/**
 * Run `method(...args)` on the promoted store when `ctx.self` is retired and a successor exists, else `local()`.
 * `missing` answers when the successor does not implement `method` (optional interface methods the Lance engine
 * lacks); without it such a call falls back to `local()`.
 */
export async function followRetiredRead<T>(
    ctx: RetiredReadContext,
    method: string,
    args: unknown[],
    local: () => Promise<T> | T,
    missing?: (successor: Record<string, unknown>) => Promise<T> | T,
): Promise<T> {
    if (!isRetiredForReads(ctx)) return local();
    for (let attempt = 0; attempt < 2; attempt++) {
        const successor = await resolveOther(ctx);
        if (!successor) return local();
        const fn = successor[method];
        if (typeof fn !== 'function') return missing ? missing(successor) : local();
        try {
            return await (fn as (...a: unknown[]) => Promise<T>).apply(successor, args);
        } catch (e) {
            if (attempt === 0 && isVerbatimStoreClosedError(e)) continue; // evicted between resolve and call: resolve again
            throw e;
        }
    }
    return local(); // unreachable: the second attempt returns or throws
}
