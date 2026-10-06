/**
 * verbatimWriteGate.ts — in-flight tracking + drain for VerbatimStore's
 * native LanceDB write table (STEP2-CLOSE-PATH-DESIGN.md (a)).
 *
 * Mirrors `LanceTablePool`'s read-side drain (`lanceTablePool.ts`), for the
 * same reason: once `VerbatimStore.close()` calls the native `table.close()`
 * / `db.close()` instead of merely dereferencing them, a call still
 * mid-`await` on `this.table` when close() runs is a use-after-close
 * SIGSEGV hazard on darwin-arm64 (the exact class LanceTablePool.drain()
 * already guards on the read side — see `conc-close-does-not-drain-inflight-reads`).
 *
 * Named after the write path (the one call class that mutates `this.table`),
 * but every VerbatimStore method that touches `this.table`/`this.db`
 * directly — not through the pooled read handles — routes through this same
 * gate, because ALL of them race the same native close() on the SAME shared
 * handle. Extracted to its own file (rather than inlined in
 * verbatimStore.ts) to keep that file inside its file-size baseline.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Connection, Table } from '@lancedb/lancedb';
import { log } from '../logger.js';
import { DEFAULT_POOL_DRAIN_TIMEOUT_MS } from './poolLimits.js';

/** hc-verbatim-native-close — LORE_VERBATIM_NATIVE_CLOSE kill switch: `0`/`false`/`off`
 *  restores the 3.19.1 dereference-only close(); anything else closes the natives. */
export function nativeCloseEnabled(): boolean {
    const raw = (process.env.LORE_VERBATIM_NATIVE_CLOSE ?? '').trim().toLowerCase();
    return raw !== '0' && raw !== 'false' && raw !== 'off';
}

/** How long VerbatimStore.close() waits for in-flight/queued writes before giving up on closing natives
 *  (default 5 s). LORE_VERBATIM_CLOSE_DRAIN_MS overrides it with a positive integer (tests, slow disks). */
export function closeDrainTimeoutMs(): number {
    const n = Number.parseInt(process.env.LORE_VERBATIM_CLOSE_DRAIN_MS ?? '', 10);
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_POOL_DRAIN_TIMEOUT_MS;
}

interface WriteLane { tail: Promise<unknown>; refs: number }
const pathLanes = new Map<string, WriteLane>();

/** Canonical lane key for a Lance directory: realpath (symlinks, macOS case),
 *  falling back to path.resolve when it cannot be stat'ed. */
export function resolveLaneKey(dir: string): string {
    try { return fs.realpathSync.native(dir); } catch { return path.resolve(dir); }
}

export class VerbatimWriteGate {
    private inFlight = 0;
    private drainPromise: Promise<void> | null = null;
    private drainResolve: (() => void) | null = null;

    /** Run `fn` counted as in-flight so `drain()` can wait for it to finish
     *  before native handles close. */
    async run<T>(fn: () => Promise<T>): Promise<T> {
        this.enter();
        try {
            return await fn();
        } finally {
            this.exit();
        }
    }

    /** Lower-level pair for call sites that already wrap their body in a
     *  try/catch (VerbatimStoreError) — avoids a second nested closure.
     *  `exit()` MUST run in a `finally` paired with every `enter()`. */
    enter(): void { this.inFlight++; }
    exit(): void {
        if (this.inFlight > 0) this.inFlight--;
        if (this.inFlight === 0 && this.drainResolve) {
            const r = this.drainResolve;
            this.drainResolve = null;
            r();
        }
    }

    inFlightCount(): number { return this.inFlight; }

    /**
     * Write mutex, one lane PER RESOLVED LANCE TABLE PATH (3.28.0,
     * duplicate-canonical fix). `run`/`enter` only COUNT work for drain();
     * they never order it, so two overlapping store/storeBatch/bulk calls for
     * the same id both ran their snapshot -> delete -> add (or plain add)
     * interleaved and left two canonical rows. `exclusive` runs `fn` strictly
     * after every earlier `exclusive` call on the SAME LANE has settled (FIFO).
     *
     * The lane is keyed by the realpath of the Lance directory in a
     * module-level map, NOT by gate/store instance: two VerbatimStore
     * instances on one path in one process (boot store + outbox resolver
     * store, reconnect, tests) share one lane. One lane per path, not per id:
     * storeBatch touches many ids, and per-id locks would need a global
     * ordering to stay deadlock-free for no real gain — every write already
     * ends in one LanceDB commit. A gate built without a path keeps a private
     * lane (unit tests of the gate itself).
     *
     * Holding the lane only orders writers. A table handle that was opened
     * before another writer's commit is STALE, and mergeInsert from a stale
     * handle inserts a duplicate: the caller must bring its handle current
     * (VerbatimStore.writeLane -> refreshWriteTable) as the first step under
     * the lane. In-process only: a second PROCESS writing at the same time is
     * NOT serialised (no lockfile, by design); non-overlapping cross-process
     * writes are safe because each write refreshes first.
     *
     * Take it INSIDE enter()/exit() (a waiter counts as in-flight, so drain()
     * and close() wait for it) and never from code already inside `exclusive`
     * on the same path: it is not re-entrant. A predecessor's rejection does
     * not poison the next waiter. A lane never waits on another store's
     * drain()/close(), so two instances closing and writing cannot deadlock;
     * the lane entry is deleted when its last waiter settles.
     */
    exclusive<T>(fn: () => Promise<T>): Promise<T> {
        const key = this.laneKey();
        let lane = key === null ? this.privateLane : pathLanes.get(key);
        if (!lane) { lane = { tail: Promise.resolve(), refs: 0 }; pathLanes.set(key as string, lane); }
        const mine = lane;
        mine.refs++;
        const run = mine.tail.catch(() => undefined).then(fn);
        mine.tail = run;
        const release = () => {
            if (--mine.refs === 0 && key !== null && pathLanes.get(key) === mine) pathLanes.delete(key);
        };
        run.then(release, release);
        return run;
    }
    private readonly privateLane: WriteLane = { tail: Promise.resolve(), refs: 0 };
    private resolvedLaneKey: string | null | undefined;
    private laneKey(): string | null {
        if (this.resolvedLaneKey !== undefined) return this.resolvedLaneKey;
        if (!this.lanePath) return (this.resolvedLaneKey = null);
        return (this.resolvedLaneKey = resolveLaneKey(this.lanePath));
    }
    /** @param lanePath the Lance directory this gate's writes target; omit for a private lane. */
    constructor(private readonly lanePath?: string) {}
    /** Test hook: number of live path lanes (0 when every lane has drained). */
    static activeLaneCount(): number { return pathLanes.size; }

    /**
     * Resolve once in-flight work hits 0, or after `timeoutMs` — whichever
     * is first. Returns `true` on a clean drain, `false` if the timeout
     * fired (work may still be running). Never throws.
     */
    async drain(timeoutMs: number = DEFAULT_POOL_DRAIN_TIMEOUT_MS, label = 'VerbatimStore'): Promise<boolean> {
        if (this.inFlight === 0) return true;
        if (!this.drainPromise) {
            this.drainPromise = new Promise<void>((resolve) => { this.drainResolve = resolve; });
        }
        let timer: NodeJS.Timeout | null = null;
        const timeout = new Promise<'timeout'>((resolve) => { timer = setTimeout(() => resolve('timeout'), timeoutMs); });
        const result = await Promise.race([this.drainPromise.then(() => 'drained' as const), timeout]);
        if (timer) clearTimeout(timer);
        if (result === 'timeout') {
            log.warn(`${label}: write drain timed out — natives are NOT closed this round (falls back to 3.19.1's dereference-only close; the in-flight call finishes on its still-live handle)`, {
                inFlight: this.inFlight, timeoutMs,
            });
            return false;
        }
        return true;
    }
}

export interface VerbatimNativeHandles {
    table: Table | null;
    db: Connection | null;
}

/**
 * STEP2-CLOSE-PATH-DESIGN.md (a) steps 5-7 — closeLsmWriters() (flushes
 * pending writes; a no-op today since Lore installs no LsmWriteSpec, kept
 * first per its own contract) → table.close() → db.close() LAST (the
 * pooled + write tables both live on it). Each native close is individually
 * try/caught + logged so one failing close cannot strand the next.
 * Call only AFTER the caller's own writeGate.drain() and read-pool close.
 */
export async function closeVerbatimNatives(handles: VerbatimNativeHandles, label: string): Promise<void> {
    if (handles.table) {
        try { await handles.table.closeLsmWriters?.(); }
        catch (e) { log.error(`[VerbatimWriteGate] closeLsmWriters failed for ${label} (non-fatal): ${(e as Error).message}`); }
        try { handles.table.close(); }
        catch (e) { log.error(`[VerbatimWriteGate] table.close failed for ${label} (non-fatal): ${(e as Error).message}`); }
    }
    if (handles.db) {
        try { handles.db.close(); }
        catch (e) { log.error(`[VerbatimWriteGate] db.close failed for ${label} (non-fatal): ${(e as Error).message}`); }
    }
}
