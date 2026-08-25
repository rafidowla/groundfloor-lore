/**
 * backgroundReconnect.ts — v1.1 first-install reconnect in background.
 *
 * Trigger: at daemon boot, check for `<LORE_HOME>/.lore/reconnect.cursor`.
 * If the cursor doesn't exist (= fresh install OR explicit reset),
 * schedule a one-shot reconnect to run in the background. Daemon
 * answers requests immediately; the reconnect populates embeddings
 * + cross-pillar edges over time.
 *
 * Status is exposed via getBackgroundReconnectStatus() so the
 * /health endpoint can surface progress to the user. Pattern: the
 * UI shows "Indexing N / total — M%" until the cursor lands.
 *
 * After the first successful run writes the cursor, subsequent
 * restarts skip the background trigger entirely. The 5-layer
 * reconnect fix (commit 60afa74) makes incremental runs nearly
 * free, so the user can run `lore reconnect --apply` whenever.
 *
 * Limitations of v1:
 *   - No progress events from reconnectGraph itself; we surface
 *     start/end timestamps + final result only. Per-step progress
 *     is a v1.1.1 follow-up that needs reconnect to emit events.
 *   - No retry on failure. If the embedder crashes mid-run, the
 *     cursor doesn't get written; daemon retries on next restart.
 *   - No throttle vs request load. Reconnect's embedder uses CPU;
 *     can cause request-latency spikes during heavy traffic. v1.1.1
 *     follow-up to throttle when load is high.
 *
 * License: original work for groundfloor-lore.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { ReconnectableGraph } from './reconnect.js';
import type { VerbatimStore } from './verbatimStore.js';
import type { PendingAutolinkTracker } from './pendingAutolink.js';
import { DEFAULT_SWEEP_DRAIN_TIMEOUT_MS } from './pendingAutolink.js';
interface BackgroundReconnectStatus {
    state: 'idle' | 'scheduled' | 'running' | 'success' | 'error' | 'skipped';
    startedAt?: string;
    finishedAt?: string;
    cursorWasMissing: boolean;
    candidatesScanned?: number;
    embeddingsAdded?: number;
    embeddingsSkipped?: number;
    proposedEdges?: number;
    edgesInserted?: number;
    error?: string;
    message?: string;
}

let status: BackgroundReconnectStatus = { state: 'idle', cursorWasMissing: false };

// SP-02 — handle on the in-flight first-install reconnect so the daemon
// shutdown drain can await it. The reconnect only persists its cursor on
// a completed run (see runReconnectInBackground), so awaiting here lets a
// run that is near completion finish and land its cursor instead of being
// killed mid-batch by process.exit.
//
// ─── Why this is a FALLBACK and not the production path ──────────────────
//
// This is a module-level `let`: one slot for the whole PROCESS. That is
// precisely the per-instance violation `pendingAutolink.ts` property 1 exists
// to prevent — a second Lore instance's dispose() in the same process would
// await the first instance's sweep. The previous note here also claimed "the
// drain is bounded by the coordinator's hard timeout", which
// `pendingAutolink.ts` property 2 documents as FALSE for the embedded path
// (`mcp/lifecycle.ts` makeDispose deliberately never enters the coordinator).
//
// Both are fixed by passing `tracker` to {@link maybeRunBackgroundReconnect}:
// the sweep is then registered on the CALLING INSTANCE's `sweepTracker`, gets
// `shouldAbort` from that tracker's seal, and is drained — bounded — by
// shutdownDrain's sweep step. The daemon boot path passes it. This slot
// remains only for callers that do not (direct/test callers), and
// `awaitBackgroundReconnect` is bounded so even they cannot hang a dispose.
let inflightReconnect: Promise<void> | null = null;

export function getBackgroundReconnectStatus(): BackgroundReconnectStatus {
    return { ...status };
}

/**
 * Resolves when the in-flight first-install reconnect (if any) finishes, OR
 * when `timeoutMs` elapses — whichever comes first. Wired into the daemon
 * shutdown drain. No-op when nothing is running.
 *
 * BOUNDED, for the same reason `PendingAutolinkTracker.drain` is: an unbounded
 * await here hangs `dispose()` forever on the embedded path, which never
 * enters the shutdown coordinator that this function's previous comment named
 * as its backstop. When the caller passed a `tracker` the sweep also polls
 * `shouldAbort`, so it stops well inside this budget rather than being
 * abandoned at the deadline.
 */
export async function awaitBackgroundReconnect(
    timeoutMs: number = DEFAULT_SWEEP_DRAIN_TIMEOUT_MS,
): Promise<{ timedOut: boolean }> {
    const inflight = inflightReconnect;
    if (!inflight) return { timedOut: false };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), timeoutMs);
        if (typeof timer.unref === 'function') timer.unref();
    });
    try {
        const outcome = await Promise.race([
            inflight.then(() => 'settled' as const, () => 'settled' as const),
            expired,
        ]);
        return { timedOut: outcome === 'timeout' };
    } finally {
        if (timer) clearTimeout(timer);
    }
}

/**
 * Decide whether to run the background reconnect, and if so, fire
 * it without awaiting. Returns immediately so the daemon can finish
 * its boot sequence.
 *
 * `loreDir` is the workspace `.lore/` directory (not the parent
 * `<LORE_HOME>`). The cursor file lives at `<loreDir>/reconnect.cursor`.
 */
export async function maybeRunBackgroundReconnect(opts: {
    loreDir: string;
    graph: ReconnectableGraph;
    verbatim: VerbatimStore;
    /** Skip the auto-trigger entirely (e.g., for tests). */
    disabled?: boolean;
    /**
     * The CALLING INSTANCE's sweep tracker (`StorageBundle.sweepTracker`).
     * Pass it: the sweep is then registered per-instance (not on this
     * module's process-global slot), refuses to start once shutdown has
     * sealed, and polls that seal at every page boundary so shutdown gets a
     * fast clean stop instead of a deadline it cannot meet — the same bargain
     * `/api/graph/reconnect` already makes. Optional only so direct/test
     * callers that have no bundle keep working.
     */
    tracker?: PendingAutolinkTracker;
}): Promise<void> {
    if (opts.disabled) {
        status = { state: 'skipped', cursorWasMissing: false, message: 'auto-trigger disabled' };
        return;
    }

    const cursorPath = path.join(opts.loreDir, 'reconnect.cursor');
    let cursorExists = false;
    try {
        await fs.access(cursorPath);
        cursorExists = true;
    } catch {
        cursorExists = false;
    }

    if (cursorExists) {
        status = { state: 'skipped', cursorWasMissing: false, message: 'cursor exists; first-install reconnect already done' };
        return;
    }

    // Cursor missing → schedule a background run.
    status = { state: 'scheduled', cursorWasMissing: true };

    // Fire-and-forget. We deliberately don't await — the daemon needs
    // to finish boot and start serving requests immediately. SP-02:
    // capture the promise so the shutdown drain can await it (cleared
    // when it settles).
    const tracker = opts.tracker;
    if (tracker) {
        const started = tracker.runTracked(() => runReconnectInBackground({
            ...opts,
            shouldAbort: () => tracker.isSealed(),
        }));
        if (!started) {
            // Sealed before boot finished (dispose() raced startup). Do not
            // launch a multi-minute sweep whose writes would land on handles
            // about to close.
            status = { state: 'skipped', cursorWasMissing: true, message: 'shutdown in progress; first-install reconnect not started' };
        }
        return;
    }
    const p = runReconnectInBackground(opts);
    inflightReconnect = p;
    void p.finally(() => { if (inflightReconnect === p) inflightReconnect = null; });
}

async function runReconnectInBackground(opts: {
    loreDir: string;
    graph: ReconnectableGraph;
    verbatim: VerbatimStore;
    shouldAbort?: () => boolean;
}): Promise<void> {
    const startedIso = new Date().toISOString();
    status = { state: 'running', startedAt: startedIso, cursorWasMissing: true };
    console.error(`[bg-reconnect] starting first-install reconnect (cursor missing) — running in background`);

    try {
        const { reconnectGraph } = await import('./reconnect.js');
        const result = await reconnectGraph(opts.graph, opts.verbatim, {
            k: 5,
            minSim: 0.65,
            dryRun: false,    // first-install: actually populate edges
            force: false,
            ...(opts.shouldAbort ? { shouldAbort: opts.shouldAbort } : {}),
        });

        // An ABORTED sweep must NOT write the cursor. This file's cursor is
        // the "first-install reconnect already done" marker — the existence
        // check at the top of maybeRunBackgroundReconnect skips the trigger
        // outright when it is present. Writing it after a sweep that stopped
        // on page 1 of N and applied no edges would make EVERY subsequent
        // restart skip the first-install reconnect, permanently, on a graph
        // that was never connected. Same defect class as the incremental
        // since-cursor on /api/graph/reconnect: a cursor may only advance over
        // ground the sweep actually covered.
        if (result.aborted) {
            status = {
                state: 'error',
                startedAt: startedIso,
                finishedAt: new Date().toISOString(),
                cursorWasMissing: true,
                candidatesScanned: result.candidatesScanned,
                error: 'aborted mid-sweep (shutdown in progress); cursor NOT written, will retry on next start',
            };
            console.error(`[bg-reconnect] aborted after ${result.candidatesScanned} node(s) — shutdown in progress; cursor not written`);
            return;
        }

        // Write the cursor on a completed run — subsequent restarts skip.
        const cursorPath = path.join(opts.loreDir, 'reconnect.cursor');
        try {
            await fs.writeFile(cursorPath, startedIso, 'utf-8');
        } catch (err) {
            console.error(`[bg-reconnect] cursor write failed: ${(err as Error).message}`);
        }

        status = {
            state: 'success',
            startedAt: startedIso,
            finishedAt: new Date().toISOString(),
            cursorWasMissing: true,
            candidatesScanned: result.candidatesScanned,
            embeddingsAdded: result.embeddingsAdded,
            embeddingsSkipped: result.embeddingsSkipped,
            proposedEdges: result.proposedEdges.length,
            edgesInserted: result.coreEdgesInserted,
        };
        console.error(`[bg-reconnect] complete: ${result.candidatesScanned} scanned, ${result.embeddingsAdded} embedded, ${result.coreEdgesInserted} edges inserted`);
    } catch (err) {
        const msg = (err as Error).message;
        status = {
            state: 'error',
            startedAt: startedIso,
            finishedAt: new Date().toISOString(),
            cursorWasMissing: true,
            error: msg,
        };
        console.error(`[bg-reconnect] FAILED: ${msg}`);
    }
}
