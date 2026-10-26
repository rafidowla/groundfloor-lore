/**
 * postgresBm25StopListHolder.ts - the per-store owner of the BM25 common-token
 * stop-list (see postgresBm25StopList.ts for what it is and why).
 *
 * Holds the in-memory copy of the workspace's list, loads it lazily (one tiny
 * indexed read), and keeps it fresh WITHOUT ever building on the recall path:
 * a missing, stale or setting-mismatched list is rebuilt by a single-flight
 * fire-and-forget background job under the pool guard. Until a build lands,
 * queries run exactly as they did before the feature.
 */

import type { Pool } from 'pg';

import { poolGuardFor } from '../postgresPoolGuard.js';
import type { Bm25StopList } from './postgresVerbatimFts.js';
import {
    bm25CommonTokenRatio, buildStopList, isStopListStale, loadStopList, MIN_ROWS_FOR_STOPLIST, RECHECK_MS, type StopListState,
} from './postgresBm25StopList.js';

export interface StopListHolderDeps {
    pool: () => Pool;
    workspaceId: string;
    /** Cheap cached row count (store.count() semantics). */
    count: () => Promise<number>;
    /** Pool-guard owner tag, so close() cancels an in-flight build. */
    owner: object;
    isClosed: () => boolean;
    /** Called after a new list is installed (drops the search cache). */
    onChanged: () => void;
    log: { error: (m: string) => void };
    now?: () => number;
}

function sameList(a: StopListState, b: StopListState): boolean {
    if (Math.abs(a.ratio - b.ratio) > 1e-9 || a.lexemes.size !== b.lexemes.size) return false;
    for (const l of a.lexemes) if (!b.lexemes.has(l)) return false;
    return true;
}

export class Bm25StopListHolder {
    private state: StopListState | null = null;
    private loaded = false;
    private checkedAt = 0;
    private build: Promise<void> | null = null;
    private readonly lexemeCache = new Map<string, string[]>();

    constructor(private readonly deps: StopListHolderDeps) {}

    private now(): number { return (this.deps.now ?? Date.now)(); }

    /** The list to apply to this query, or undefined (feature off / not built yet / built for another ratio). */
    async forQuery(): Promise<{ stopList: Bm25StopList | undefined; ratio: number }> {
        const ratio = bm25CommonTokenRatio();
        if (ratio === 0) return { stopList: undefined, ratio };
        if (!this.loaded) {
            try { this.state = await loadStopList(this.deps.pool(), this.deps.workspaceId); } catch { this.state = null; }
            this.loaded = true;
        }
        const usable = this.state !== null && Math.abs(this.state.ratio - ratio) <= 1e-9;
        const t = this.now();
        // One attempt per RECHECK_MS whether or not a list is in force: a list that cannot be built (a pool with no
        // background slot, a refresh that throws, a not-yet-built list) must not cost a metadata read + guard attempt
        // - or an error log line - on every uncached query. checkedAt is stamped when the attempt starts, so a failed
        // or `ran:false` refresh backs off for the same window as a successful one.
        if (t - this.checkedAt >= RECHECK_MS) {
            this.checkedAt = t;
            this.kick(ratio);
        }
        if (!usable || this.state!.lexemes.size === 0) return { stopList: undefined, ratio };
        return { stopList: { common: this.state!.lexemes, lexemeCache: this.lexemeCache }, ratio };
    }

    private kick(ratio: number): void {
        if (this.build || this.deps.isClosed()) return;
        this.build = this.refresh({ force: false, ratio })
            .then(() => undefined, (err) => this.deps.log.error(`[PostgresVerbatimStore] BM25 stop-list refresh failed (non-fatal): ${(err as Error).message}`))
            .finally(() => { this.build = null; });
    }

    /**
     * Rebuild when missing/stale (or `force`). Awaited by ensureFtsIndex() and compact();
     * the recall path only ever calls it through the background kick. Never throws for a
     * disabled feature, a closed store, or a pool with no spare background slot.
     */
    async refresh(opts: { force?: boolean; ratio?: number } = {}): Promise<{ built: boolean; commonCount: number }> {
        const ratio = opts.ratio ?? bm25CommonTokenRatio();
        if (ratio === 0 || this.deps.isClosed()) return { built: false, commonCount: this.state?.lexemes.size ?? 0 };
        const pool = this.deps.pool();
        const before = this.state;
        try { this.state = await loadStopList(pool, this.deps.workspaceId); this.loaded = true; } catch { this.state = null; }
        // A list another process built can differ from the one this process answered with: drop the search cache
        // (the same epoch bump a local build does) so no entry ranked with the old list outlives it.
        if (before && this.state && !sameList(before, this.state)) this.deps.onChanged();
        const rows = await this.deps.count();
        if (!opts.force && this.state && !isStopListStale(this.state, rows, ratio, this.now())) {
            return { built: false, commonCount: this.state.lexemes.size };
        }
        let built: StopListState;
        if (rows < MIN_ROWS_FOR_STOPLIST) {
            // Below the minimum there is no statistics scan, only a tiny "empty list" write: one short plain connection,
            // not a guarded background job (and not one more thing compact()/ensureFtsIndex() must account for).
            const client = await pool.connect();
            try { built = await buildStopList(client, this.deps.workspaceId, ratio, rows); } finally { client.release(); }
        } else {
            const ran = await poolGuardFor(pool).run('verbatim-bm25-stoplist',
                (client) => buildStopList(client, this.deps.workspaceId, ratio, rows), { owner: this.deps.owner });
            if (!ran.ran) return { built: false, commonCount: this.state?.lexemes.size ?? 0 };
            built = ran.value;
        }
        this.state = built;
        this.loaded = true;
        this.deps.onChanged();
        return { built: true, commonCount: built.lexemes.size };
    }

    /** Test/ops seam: resolves when the in-flight background refresh (if any) has finished. */
    async idle(): Promise<void> { while (this.build) await this.build; }

    /** Test/ops seam: the lexemes currently in force. */
    commonLexemes(): string[] { return this.state ? [...this.state.lexemes].sort() : []; }
}
